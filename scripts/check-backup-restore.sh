#!/usr/bin/env bash
set -euo pipefail
umask 077
# Destructive schema replacement is permitted only in the existing disposable CI
# database. This script refuses remote hosts and never reads production secrets.
if [[ "${CI:-}" != true || "${GITHUB_ACTIONS:-}" != true || \
  "${CUSCO_DB_TEST_DISPOSABLE:-}" != yes || "${PGDATABASE:-}" != cusco_test || \
  ! "${PGHOST:-}" =~ ^(127\.0\.0\.1|localhost|::1)$ ]]; then
  echo 'Restore rehearsal blocked: only the disposable loopback CI database is accepted.' >&2
  exit 1
fi
for tool in pg_dump pg_restore psql; do
  if ! command -v "$tool" >/dev/null; then
    echo 'Restore rehearsal requires PostgreSQL client utilities.' >&2
    exit 1
  fi
done
scratch_dir="$(mktemp -d)"
trap 'rm -rf -- "$scratch_dir"' EXIT
query="select jsonb_build_object('expenses',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from app_private.expenses e),'splits',(select coalesce(jsonb_agg(to_jsonb(s) order by expense_id,participant_id),'[]') from app_private.expense_splits s),'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from app_private.payments p),'trip',(select jsonb_agg(to_jsonb(t) order by id) from app_private.trip t))"
psql -X --no-password -v ON_ERROR_STOP=1 -Atqc "$query" > "$scratch_dir/before.json"
psql -X --no-password -v ON_ERROR_STOP=1 -qc "create role cusco_backup_once nologin; do \$\$ declare t record; begin for t in select tablename from pg_tables where schemaname='app_private' loop execute format('create policy cusco_backup_snapshot_read on app_private.%I for select to cusco_backup_once using (true)',t.tablename); end loop; end \$\$;"
pg_dump --format=custom --no-owner --no-acl --schema=app_private --schema=app_api \
  --no-password --file="$scratch_dir/synthetic.dump"
pg_restore --list "$scratch_dir/synthetic.dump" | python3 "$(dirname -- "${BASH_SOURCE[0]}")/filter-backup-toc.py" > "$scratch_dir/restore.list"
# Remove the credential and its policy before restore, as production backup does.
psql -X --no-password -v ON_ERROR_STOP=1 -qc "do \$\$ declare t record; begin for t in select tablename from pg_tables where schemaname='app_private' loop execute format('drop policy cusco_backup_snapshot_read on app_private.%I',t.tablename); end loop; end \$\$; drop role cusco_backup_once;"
# Restore into the same ephemeral CI database, after its financial suites pass.
psql -X --no-password -v ON_ERROR_STOP=1 -qc 'drop schema app_api cascade; drop schema app_private cascade;' \
  > "$scratch_dir/drop.log" 2>&1
pg_restore --no-password --exit-on-error --no-owner --no-acl --use-list="$scratch_dir/restore.list" \
  --dbname="$PGDATABASE" "$scratch_dir/synthetic.dump"
# --no-acl deliberately strips runtime grants from an export. Reinstate only the
# reviewed API boundary, never blanket grants on private tables or functions.
psql -X --no-password -v ON_ERROR_STOP=1 -qc "alter default privileges revoke execute on functions from public; alter default privileges in schema app_private revoke all on tables from public; alter default privileges in schema app_private revoke execute on functions from public; alter default privileges in schema app_api revoke execute on functions from public; revoke all on schema app_private,app_api from public; revoke all on all tables in schema app_private from public,cusco_bff; revoke all on all functions in schema app_private,app_api from public,cusco_bff; grant usage on schema app_api to cusco_bff; grant execute on function app_api.mutate_expense(text,uuid,jsonb),app_api.list_expenses(text),app_api.consume_quota(text,text),app_api.exchange_link(text,text),app_api.session_context(text),app_api.logout_session(text),app_api.revoke_link(text,uuid),app_api.payment_context(text),app_api.mutate_payment(text,uuid,jsonb),app_api.list_access_links(text),app_api.rotate_access_link(text,uuid,uuid,integer,text),app_api.list_imports(text,uuid),app_api.mutate_import(text,uuid,jsonb) to cusco_bff;"
psql -X --no-password -v ON_ERROR_STOP=1 <<'SQL'
begin;
create function app_api.__restore_default_acl_probe() returns boolean language sql as 'select true';
do $$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('app_private','app_api') and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'Public function execution restored unexpectedly';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and (not c.relrowsecurity or has_table_privilege('cusco_bff',c.oid,'SELECT'))) then
    raise exception 'Private table boundary not restored';
  end if;
  if has_function_privilege('cusco_bff','app_api.__restore_default_acl_probe()','EXECUTE') then
    raise exception 'Unreviewed future function granted to runtime';
  end if;
  if not has_function_privilege('cusco_bff','app_api.list_expenses(text)','EXECUTE') or not has_function_privilege('cusco_bff','app_api.mutate_import(text,uuid,jsonb)','EXECUTE') then
    raise exception 'Required API permission missing';
  end if;
end $$;
rollback;
SQL
psql -X --no-password -v ON_ERROR_STOP=1 -Atqc "$query" > "$scratch_dir/after.json"
if ! cmp -s -- "$scratch_dir/before.json" "$scratch_dir/after.json"; then
  echo 'Restore rehearsal failed: financial snapshots differ (details withheld).' >&2
  exit 1
fi
echo 'Backup/restore rehearsal passed in the existing disposable CI database.'
