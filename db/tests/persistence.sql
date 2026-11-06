\set ON_ERROR_STOP on
begin;
-- Exclusivamente sintético y dentro de una transacción que se revierte al final.
insert into app_private.participants(id,trip_id,display_name) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Fixture A'),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Fixture B');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','participant',repeat('a',64)),
('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','participant',repeat('b',64)),
('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',null,'admin',repeat('c',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',repeat('1',64),1,now()+interval '1 hour'),
('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',repeat('2',64),1,now()+interval '1 hour'),
('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003',repeat('3',64),1,now()+interval '1 hour');

do $$
declare cmd jsonb; result jsonb; edited jsonb; v_id uuid; rejected boolean;
begin
  cmd := '{"operation":"create","payerId":"10000000-0000-4000-8000-000000000001","description":"Fixture","spentOn":"2026-01-01","amountMinor":"101","currency":"PEN","splits":[{"participantId":"10000000-0000-4000-8000-000000000001","amountMinor":"51"},{"participantId":"10000000-0000-4000-8000-000000000002","amountMinor":"50"}]}'::jsonb;
  set local role cusco_bff;
  result := app_api.mutate_expense(repeat('1',64),'30000000-0000-4000-8000-000000000001',cmd);
  assert result->>'amountMinor' = '101';
  assert result->>'version' = '1';
  assert result = app_api.mutate_expense(repeat('1',64),'30000000-0000-4000-8000-000000000001',cmd);
  assert jsonb_array_length(app_api.list_expenses(repeat('2',64))) = 1;
  v_id := (result->>'id')::uuid;
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),'30000000-0000-4000-8000-000000000001',cmd || '{"description":"different"}');
  exception when unique_violation then rejected := true; end;
  assert rejected, 'idempotency must reject changed payload';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('2',64),gen_random_uuid(),cmd);
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'participant cannot create for another payer';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('f',64),gen_random_uuid(),cmd);
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'unknown session';
  rejected := false;
  begin
    perform count(*) from app_private.expenses;
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'BFF must not access raw tables';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),cmd || '{"amountMinor":"102"}');
  exception when check_violation then rejected := true; end;
  assert rejected, 'sum must equal amount';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),cmd || '{"amountMinor":101}');
  exception when invalid_parameter_value then rejected := true; end;
  assert rejected, 'money crosses JSON as strings';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),cmd || '{"splits":[{"participantId":"10000000-0000-4000-8000-000000000001","amountMinor":"51"},{"participantId":"10000000-0000-4000-8000-000000000001","amountMinor":"50"}]}');
  exception when unique_violation then rejected := true; end;
  assert rejected, 'no duplicate beneficiary';
  cmd := cmd || jsonb_build_object('operation','update','id',v_id,'expectedVersion',1);
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('2',64),gen_random_uuid(),cmd || '{"payerId":"10000000-0000-4000-8000-000000000002"}');
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'cannot appropriate existing expense';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),cmd || '{"payerId":"10000000-0000-4000-8000-000000000002"}');
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'cannot reassign own expense';
  edited := app_api.mutate_expense(repeat('1',64),'30000000-0000-4000-8000-000000000002',cmd || '{"description":"Edited fixture"}');
  assert edited->>'version' = '2';
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),cmd);
  exception when serialization_failure then rejected := true; end;
  assert rejected, 'stale version';
  edited := app_api.mutate_expense(repeat('3',64),gen_random_uuid(),cmd || '{"expectedVersion":2,"payerId":"10000000-0000-4000-8000-000000000002"}');
  assert edited->>'version' = '3';
  assert edited->>'payerId' = '10000000-0000-4000-8000-000000000002';
  edited := app_api.mutate_expense(repeat('2',64),gen_random_uuid(),jsonb_build_object('operation','void','id',v_id,'expectedVersion',3));
  assert edited->>'state' = 'voided';
  assert jsonb_array_length(app_api.list_expenses(repeat('1',64))) = 0;
  reset role;
  assert (select count(*) from app_private.expense_revisions where expense_id=v_id) = 4;
  assert (select count(*) from app_private.audit_events where entity_id=v_id) = 4;
  assert (select count(*) from app_private.expenses) = 1;
  assert (select ledger_version from app_private.trip) = 4;
  -- Invariante diferida comprobada incluso con SQL administrativo directo.
  rejected := false;
  begin
    update app_private.expense_splits set amount_minor=52 where expense_id=v_id and amount_minor=51;
    set constraints all immediate;
  exception when check_violation then rejected := true; end;
  assert rejected, 'deferred constraint rejects direct corrupt totals';
  set constraints all immediate;
  set constraints all deferred;
  update app_private.access_links set revoked_at=clock_timestamp() where id='20000000-0000-4000-8000-000000000001';
  set local role cusco_bff;
  rejected := false;
  begin
    perform app_api.list_expenses(repeat('1',64));
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'revoked link cannot read';
  -- Reintento previamente completado tampoco elude revocación.
  rejected := false;
  begin
    perform app_api.mutate_expense(repeat('1',64),'30000000-0000-4000-8000-000000000002',cmd || '{"description":"Edited fixture"}');
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'retries must reauthorize';
  reset role;
  update app_private.sessions set expires_at=now()-interval '1 second' where token_hash=repeat('2',64);
  set local role cusco_bff;
  rejected := false;
  begin perform app_api.list_expenses(repeat('2',64));
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'expired session';
  reset role;
  update app_private.access_links set version=2 where id='20000000-0000-4000-8000-000000000003';
  set local role cusco_bff;
  rejected := false;
  begin perform app_api.list_expenses(repeat('3',64));
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'rotated link';
  reset role;
  update app_private.access_links set version=1 where id='20000000-0000-4000-8000-000000000003';
  update app_private.sessions set revoked_at=clock_timestamp() where token_hash=repeat('3',64);
  set local role cusco_bff;
  rejected := false;
  begin perform app_api.list_expenses(repeat('3',64));
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'revoked session';
  reset role;
  update app_private.access_links set revoked_at=null where id='20000000-0000-4000-8000-000000000001';
  update app_private.participants set active=false where id='10000000-0000-4000-8000-000000000001';
  set local role cusco_bff;
  rejected := false;
  begin perform app_api.list_expenses(repeat('1',64));
  exception when invalid_authorization_specification then rejected := true; end;
  assert rejected, 'inactive participant';
  reset role;
  -- RLS en todas las tablas privadas y funciones sin EXECUTE público.
  assert not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and not c.relrowsecurity);
  assert not has_schema_privilege('cusco_bff','app_private','USAGE');
end $$;
-- Rol sin grants: ni lectura de tablas ni ejecución de la API.
create role cusco_test_untrusted nologin;
do $$ declare rejected boolean := false; begin
  set local role cusco_test_untrusted;
  begin perform app_api.list_expenses(repeat('3',64));
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'public cannot execute application functions';
  rejected := false;
  begin perform count(*) from app_private.expenses;
  exception when insufficient_privilege then rejected := true; end;
  assert rejected, 'public cannot read private data';
  reset role;
  assert not has_function_privilege('cusco_test_untrusted','app_api.list_expenses(text)','EXECUTE');
  assert not has_function_privilege('cusco_test_untrusted','app_api.mutate_expense(text,uuid,jsonb)','EXECUTE');
end $$;
set constraints all immediate;
rollback;
\echo 'OK: persistence authorization, invariants, history, revocation and idempotency'
