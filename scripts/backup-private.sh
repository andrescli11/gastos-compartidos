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
# Refuse to archive temporary evidence; the operator must explicitly finish or
# cancel outstanding previews. This check never deletes or modifies their work.
if ! pending_sources="$(psql -X --no-password -v ON_ERROR_STOP=1 -Atqc "select count(*) from app_private.import_jobs j where (j.state='preview' and jsonb_array_length(j.rows)>0) or exists(select 1 from jsonb_array_elements(j.rows) r where coalesce(r->>'evidence','')<>'')" 2>/dev/null)" || [[ "$pending_sources" != 0 ]]; then
  echo 'Backup bloqueado: terminar o cancelar borradores con evidencia antes de exportar.' >&2
  exit 1
fi
diagnostics="$(mktemp)"
complete=no
cleanup() {
  rm -f -- "$diagnostics"
  if [[ "$complete" != yes ]]; then rm -f -- "$backup_path"; fi
}
trap cleanup EXIT
if ! pg_dump --format=custom --no-owner --no-acl \
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
