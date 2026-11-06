\set ON_ERROR_STOP on
-- Only disposable CI PostgreSQL. All fixtures are rolled back.
begin;
update app_private.trip set start_date='2026-01-01',end_date='2026-01-31';
insert into app_private.participants(id,trip_id,display_name) values
('91000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Import owner fixture'),
('91000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Import other fixture');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
('92000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','participant',repeat('d',64)),
('92000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','participant',repeat('e',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
('00000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',repeat('4',64),1,now()+interval '1 hour'),
('00000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000002',repeat('5',64),1,now()+interval '1 hour');
do $$
declare r jsonb; rows_value jsonb; cmd jsonb; created jsonb; saved jsonb; confirmed jsonb; jobid uuid; eid uuid; rejected boolean; count_before bigint; partial_job uuid;
begin
 rows_value:=jsonb_build_array(jsonb_build_object('id','93000000-0000-4000-8000-000000000001',
 'description','Import reviewed fixture','spentOn','2026-01-01','amountMinor','100','currency','PEN','payerId','91000000-0000-4000-8000-000000000001',
 'splits',jsonb_build_array(jsonb_build_object('participantId','91000000-0000-4000-8000-000000000002','amountMinor','100')),
 'selected',true,'reviewed',true,'keepBoth',false,'evidence','Original limited evidence','sourceRow',2,'warnings','[]'::jsonb,'duplicateExpenseIds','[]'::jsonb));
 set local role cusco_bff;
 cmd:=jsonb_build_object('operation','create','sourceType','csv','rows',rows_value);
 created:=app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000001',cmd);
 jobid:=(created->'job'->>'id')::uuid;
 assert created->'job'->>'version'='1';
 assert created->'job'->>'state'='preview';
 assert app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000001',cmd)=created;
 rejected:=false;
 begin perform app_api.list_imports(repeat('5',64),jobid); exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'drafts private to owner';
 assert jsonb_array_length(app_api.list_imports(repeat('5',64))->'jobs')=0;
 rejected:=false;
 begin perform app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000001',cmd||'{"sourceType":"manual"}'); exception when unique_violation then rejected:=true; end;
 assert rejected,'idempotency payload collision rejected';
 cmd:=jsonb_build_object('operation','save','id',jobid,'expectedVersion',1,'rows',rows_value);
 saved:=app_api.mutate_import(repeat('4',64),gen_random_uuid(),cmd);
 assert saved->'job'->>'version'='2';
 rejected:=false;
 begin perform app_api.mutate_import(repeat('4',64),gen_random_uuid(),cmd); exception when serialization_failure then rejected:=true; end;
 assert rejected,'stale preview cannot overwrite';
 cmd:=jsonb_build_object('operation','confirm','id',jobid,'expectedVersion',2);
 confirmed:=app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000002',cmd);
 assert confirmed->'job'->>'state'='persisted';
 assert confirmed->'job'->'results'->0->>'status'='persisted';
 assert confirmed->'job'->'rows'->0->>'evidence'='';
 eid:=(confirmed->'job'->'results'->0->>'expenseId')::uuid;
 assert app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000002',cmd)=confirmed,'confirm replay after version change';
 assert (app_api.mutate_import(repeat('4',64),'94000000-0000-4000-8000-000000000001',jsonb_build_object('operation','create','sourceType','csv','rows',rows_value))->'job'->>'id')::uuid=jobid,'create replay never recreates finished job';
 reset role;
 assert (select count(*) from app_private.expenses where id=eid)=1;
 assert (select source from app_private.expenses where id=eid)='csv';
 assert not exists(select 1 from app_private.import_commands where result::text like '%Original limited evidence%'),'no original evidence retained in retry journal';
 -- Selected unauthorized row fails without losing successful row; retry skips successes.
 rows_value:=rows_value||jsonb_build_array((rows_value->0)||jsonb_build_object('id','93000000-0000-4000-8000-000000000002','payerId','91000000-0000-4000-8000-000000000002','description','Unauthorized row fixture','spentOn','2026-01-02'));
 rows_value:=jsonb_set(rows_value,'{0,spentOn}','"2026-01-03"');
 set local role cusco_bff;
 r:=app_api.mutate_import(repeat('4',64),gen_random_uuid(),jsonb_build_object('operation','create','sourceType','manual','rows',rows_value));
 partial_job:=(r->'job'->>'id')::uuid;
 r:=app_api.mutate_import(repeat('4',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',partial_job,'expectedVersion',1));
 assert r->'job'->>'state'='preview';
 assert r->'job'->'results'->0->>'status'='persisted';
 assert r->'job'->'results'->1->>'code'='FORBIDDEN';
 reset role;
 select count(*) into count_before from app_private.expenses;
 set local role cusco_bff;
 r:=app_api.mutate_import(repeat('4',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',partial_job,'expectedVersion',2));
 reset role;
 assert (select count(*) from app_private.expenses)=count_before,'partial retry cannot duplicate successful row';
 set local role cusco_bff;
 r:=app_api.mutate_import(repeat('4',64),gen_random_uuid(),jsonb_build_object('operation','cancel','id',partial_job,'expectedVersion',3));
 assert r->'job'->>'state'='cancelled' and jsonb_array_length(r->'job'->'rows')=0;
 reset role;
 update app_private.import_jobs set expires_at=now()-interval '1 second' where id=jobid;
 set local role cusco_bff;
 r:=app_api.list_imports(repeat('4',64),jobid);
 assert r->'job'->>'state'='expired' and jsonb_array_length(r->'job'->'rows')=0;
 reset role;
 assert not has_table_privilege('cusco_bff','app_private.import_jobs','select');
 assert not has_function_privilege('anon','app_api.mutate_import(text,uuid,jsonb)','execute');
end $$;
rollback;
