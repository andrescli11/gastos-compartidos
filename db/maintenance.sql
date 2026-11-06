-- Apply after schema.sql, access.sql, payments.sql and imports.sql.
-- Only the administrative scheduler can execute this function. Never grant BFF
-- a general cleanup capability. Financial history and idempotency are retained.
begin;
create table if not exists app_private.maintenance_runs (
  id bigint generated always as identity primary key,
  completed_at timestamptz not null default clock_timestamp(),
  sessions_removed integer not null check (sessions_removed >= 0),
  quotas_removed integer not null check (quotas_removed >= 0)
);
alter table app_private.maintenance_runs enable row level security;
revoke all on app_private.maintenance_runs from public, cusco_bff;
revoke all on sequence app_private.maintenance_runs_id_seq from public, cusco_bff;

create or replace function app_private.run_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sessions integer; v_quotas integer;
begin
  -- Session IDs are never referenced by financial/audit rows: they hold link IDs.
  -- Delay physical deletion one day after expiry/revocation for incident handling.
  delete from app_private.sessions
    where expires_at < clock_timestamp() - interval '1 day'
      or revoked_at < clock_timestamp() - interval '1 day';
  get diagnostics v_sessions = row_count;
  delete from app_private.rate_limits where expires_at < clock_timestamp();
  get diagnostics v_quotas = row_count;
  if to_regprocedure('app_private.expire_imports()') is not null then
    perform app_private.expire_imports();
  end if;
  insert into app_private.maintenance_runs(sessions_removed,quotas_removed)
    values(v_sessions,v_quotas);
  return jsonb_build_object('sessionsRemoved',v_sessions,'quotasRemoved',v_quotas);
end $$;
revoke all on function app_private.run_maintenance() from public, cusco_bff;
commit;
