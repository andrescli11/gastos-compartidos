#!/usr/bin/env bash
set -euo pipefail
umask 077
# PG* connection variables come from an operator's secret manager, not arguments.
# age encrypts the dump stream without ever writing plaintext to disk.
if [[ $# -ne 1 || -z "${CUSCO_BACKUP_RECIPIENT:-}" || "$1" != /* ]]; then
  echo 'Uso: configurar PG* y CUSCO_BACKUP_RECIPIENT (age), indicar destino absoluto fuera del repositorio.' >&2
  exit 1
fi
for tool in pg_dump psql age realpath; do
  if ! command -v "$tool" >/dev/null; then
    echo 'Falta una herramienta de backup requerida.' >&2
    exit 1
  fi
done
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backup_path="$(realpath -m -- "$1")"
if [[ "$backup_path" != /* || "$backup_path" == "$repo_dir"/* || -e "$backup_path" ]]; then
  echo 'Destino de backup inválido, existente o dentro del repositorio.' >&2
  exit 1
fi
if [[ ! -d "$(dirname -- "$backup_path")" ]]; then
  echo 'Crear primero un directorio privado para el backup.' >&2
  exit 1
fi
# Never use DATABASE_URL on the command line. Production backup requires TLS
# verification and the provider CA, with a dedicated operator credential.
if [[ "${PGSSLMODE:-}" != "verify-full" ]]; then
  echo 'Backup requiere PGSSLMODE=verify-full y confianza TLS del proveedor.' >&2
  exit 1
fi
# Export one repeatable-read snapshot, so the evidence check and dump cannot race.
diagnostics="$(mktemp)"
complete=no
snapshot_pid=""
cleanup() {
  if [[ -n "$snapshot_pid" ]]; then
    kill "$snapshot_pid" 2>/dev/null || true
    wait "$snapshot_pid" 2>/dev/null || true
  fi
  rm -f -- "$diagnostics"
  if [[ "$complete" != yes ]]; then rm -f -- "$backup_path"; fi
}
trap cleanup EXIT
coproc CUSCO_SNAPSHOT { psql -X --no-password -v ON_ERROR_STOP=1 -qAt 2>>"$diagnostics"; }
snapshot_pid="$CUSCO_SNAPSHOT_PID"
snapshot_read_fd="${CUSCO_SNAPSHOT[0]}"
snapshot_write_fd="${CUSCO_SNAPSHOT[1]}"
printf '%s\n' "begin isolation level repeatable read read only;" \
  "select (to_regclass('app_private.import_jobs') is not null)::integer;" >&"$snapshot_write_fd"
if ! read -r -t 15 has_imports <&"$snapshot_read_fd" || [[ ! "$has_imports" =~ ^[01]$ ]]; then
  echo 'Backup bloqueado: no se pudo verificar el esquema.' >&2
  exit 1
fi
if [[ "$has_imports" == 1 ]]; then
  printf '%s\n' "select count(*) from app_private.import_jobs j where (j.state='preview' and jsonb_array_length(j.rows)>0) or exists(select 1 from jsonb_array_elements(j.rows) r where coalesce(r->>'evidence','')<>'');" >&"$snapshot_write_fd"
else
  printf '%s\n' 'select 0;' >&"$snapshot_write_fd"
fi
printf '%s\n' 'select pg_export_snapshot();' >&"$snapshot_write_fd"
if ! read -r -t 15 pending_sources <&"$snapshot_read_fd" || [[ "$pending_sources" != 0 ]] || \
  ! read -r -t 15 snapshot_id <&"$snapshot_read_fd" || \
  [[ ! "$snapshot_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$ ]]; then
  echo 'Backup bloqueado: terminar o cancelar borradores con evidencia, o verificar conexión.' >&2
  exit 1
fi
if ! pg_dump --format=custom --no-owner --no-acl --enable-row-security --inserts \
  --snapshot="$snapshot_id" \
  --schema=app_private --schema=app_api \
  --exclude-table-data=app_private.sessions \
  --exclude-table-data=app_private.rate_limits \
  --exclude-table-data=app_private.import_commands \
  --no-password 2>"$diagnostics" \
  | age --recipient "$CUSCO_BACKUP_RECIPIENT" --output "$backup_path" 2>>"$diagnostics"; then
  echo 'Backup falló; diagnóstico privado descartado y salida parcial eliminada.' >&2
  exit 1
fi
complete=yes
echo 'Backup cifrado completado. Verificar restauración antes de considerarlo recuperable.'
