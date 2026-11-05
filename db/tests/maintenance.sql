begin;
do $$
declare
  v_trip uuid := '00000000-0000-4000-8000-000000000001';
  v_link uuid := gen_random_uuid();
  v_old uuid := gen_random_uuid();
  v_recent uuid := gen_random_uuid();
  v_active uuid := gen_random_uuid();
  v_quota text := md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  v_before_expenses bigint;
  v_before_payments bigint;
  v_result jsonb;
begin
  if has_function_privilege('cusco_bff','app_private.run_maintenance()','EXECUTE') then
    raise exception 'BFF must not execute maintenance';
  end if;
  insert into app_private.access_links(id,trip_id,role,token_hash)
    values(v_link,v_trip,'admin',md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text));
  insert into app_private.sessions(id,trip_id,link_id,token_hash,link_version,expires_at)
    values
      (v_old,v_trip,v_link,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),1,now()-interval '2 days'),
      (v_recent,v_trip,v_link,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),1,now()-interval '1 hour'),
      (v_active,v_trip,v_link,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),1,now()+interval '1 hour');
  insert into app_private.rate_limits(scope,key_hash,window_start,hits,expires_at)
    values('read',v_quota,now()-interval '2 days',1,now()-interval '1 day');
  select count(*) into v_before_expenses from app_private.expenses;
  select count(*) into v_before_payments from app_private.payments;
  v_result := app_private.run_maintenance();
  if exists(select 1 from app_private.sessions where id=v_old)
    or not exists(select 1 from app_private.sessions where id=v_recent)
    or not exists(select 1 from app_private.sessions where id=v_active) then
    raise exception 'Session retention boundary failed';
  end if;
  if exists(select 1 from app_private.rate_limits where key_hash=v_quota) then
    raise exception 'Expired quota retained';
  end if;
  if (v_result->>'sessionsRemoved')::integer < 1
    or (v_result->>'quotasRemoved')::integer < 1
    or not exists(select 1 from app_private.maintenance_runs) then
    raise exception 'Maintenance result not recorded';
  end if;
  if (select count(*) from app_private.expenses) <> v_before_expenses
    or (select count(*) from app_private.payments) <> v_before_payments then
    raise exception 'Maintenance changed financial data';
  end if;
end $$;
rollback;
