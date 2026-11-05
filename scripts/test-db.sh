#!/usr/bin/env bash
set -euo pipefail
# Únicamente una base efímera VACÍA. No acepta una URL ni secretos como argumento.
# La conexión utiliza las variables PG* del runner; no imprime sus valores.
if [[ "${CUSCO_DB_TEST_DISPOSABLE:-}" != "yes" ]]; then
  echo 'Prueba bloqueada: requiere CUSCO_DB_TEST_DISPOSABLE=yes y una base efímera vacía.' >&2
  exit 1
fi
if ! command -v psql >/dev/null; then
  echo 'PostgreSQL client (psql) no está instalado.' >&2
  exit 1
fi
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/roles.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/schema.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/access.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/payments.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/admin-access.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/imports.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/maintenance.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/security-remediation.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/persistence.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/access.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/payments.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/admin-access.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/imports.sql"
psql -X --no-password -v ON_ERROR_STOP=1 -f "$repo_dir/db/tests/maintenance.sql"
node "$repo_dir/scripts/check-db-concurrency.mjs"
node "$repo_dir/scripts/check-payment-db-concurrency.mjs"
