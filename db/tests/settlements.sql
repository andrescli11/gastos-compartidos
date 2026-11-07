\set ON_ERROR_STOP on
-- Only the guarded disposable PostgreSQL runner applies this fixture.
begin;
insert into app_private.participants(id,trip_id,display_name) values
 ('d1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Settlement sender'),
 ('d1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Settlement receiver'),
 ('d1000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Other receiver');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
 ('d2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','participant',repeat('d',64)),
 ('d2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002','participant',repeat('e',64)),
 ('d2000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',null,'admin',repeat('f',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
 ('00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',repeat('d',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000002',repeat('e',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000003',repeat('f',64),1,now()+interval '1 hour');
do $$
declare
 a constant text:='d1000000-0000-4000-8000-000000000001';
 b constant text:='d1000000-0000-4000-8000-000000000002';
 c constant text:='d1000000-0000-4000-8000-000000000003';
 state jsonb; expense jsonb; first_id text; second_id text; third_id text;
 command jsonb; previous jsonb; key uuid; payment_one text; payment_two text; payment_all text;
 position jsonb; failed boolean; v bigint;
begin
 set local role cusco_bff;
 state:=app_api.payment_context(repeat('f',64));
 v:=(state->>'ledgerVersion')::bigint;
 state:=app_api.mutate_payment(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','configure','mode','separate','expectedLedgerVersion',v));
 expense:=app_api.mutate_expense(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Expense first','spentOn','2026-01-01','amountMinor','100','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','100'))));
 first_id:=expense->>'id';
 expense:=app_api.mutate_expense(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Expense second','spentOn','2026-01-02','amountMinor','200','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','200'))));
 second_id:=expense->>'id';
 expense:=app_api.mutate_expense(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',c,'description','Expense other receiver','spentOn','2026-01-03','amountMinor','50','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','50'))));
 third_id:=expense->>'id';
 state:=app_api.payment_context(repeat('d',64));
 assert jsonb_array_length(state->'positions')=3;
 assert jsonb_array_length(state->'reconciliationRequired')=0;
 assert (select sum((value->>'remainingMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'receiverId'=b)=300;
 command:=jsonb_build_object('operation','register','senderId',a,'receiverId',b,'amountMinor','40','currency','PEN','expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'expenseIds',jsonb_build_array(first_id));
 failed:=false;
 begin perform app_api.mutate_payment(repeat('e',64),gen_random_uuid(),command);
 exception when insufficient_privilege then failed:=true; end;
 assert failed,'receiver cannot attribute another participant payment';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command||jsonb_build_object('receiverId',c));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'expense selection binds receiver';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command||'{"currency":"USD"}');
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'expense selection binds currency';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command||jsonb_build_object('expenseIds',jsonb_build_array(first_id,first_id)));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'duplicate selected IDs rejected';
 key:=gen_random_uuid();
 state:=app_api.mutate_payment(repeat('d',64),key,command);
 previous:=state;
 assert app_api.mutate_payment(repeat('d',64),key,command)=previous,'durable replay returns exact attributed snapshot';
 payment_one:=state->'payments'->0->>'id';
 assert state->'payments'->0->'expenseAllocations'->0->>'expenseId'=first_id;
 assert state->'payments'->0->'expenseAllocations'->0->>'amountMinor'='40';
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='100' and position->>'pendingMinor'='40','pending reserves without changing debt';
 command:=command||jsonb_build_object('expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'amountMinor','70');
 failed:=false;
 begin perform app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command);
 exception when serialization_failure then failed:=true; end;
 assert failed,'reservation prevents collecting overlapping amount';
 state:=app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command||'{"amountMinor":"60"}');
 payment_two:=state->'payments'->1->>'id';
 state:=app_api.mutate_payment(repeat('e',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',payment_one,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reviewedLedgerVersion',(state->>'ledgerVersion')::bigint));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='60' and position->>'pendingMinor'='60';
 state:=app_api.mutate_payment(repeat('e',64),gen_random_uuid(),jsonb_build_object('operation','reject','id',payment_two,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='60' and position->>'pendingMinor'='0','reject releases reservation';
 command:=jsonb_build_object('operation','register','senderId',a,'receiverId',b,'amountMinor','260','currency','PEN','expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'expenseIds',jsonb_build_array(first_id,second_id));
 state:=app_api.mutate_payment(repeat('d',64),gen_random_uuid(),command);
 payment_all:=state->'payments'->2->>'id';
 assert jsonb_array_length(state->'payments'->2->'expenseAllocations')=2,'person payment links all covered expense shares';
 state:=app_api.mutate_payment(repeat('e',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',payment_all,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reviewedLedgerVersion',(state->>'ledgerVersion')::bigint));
 assert (select sum((value->>'remainingMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'receiverId'=b)=0,'person and expense totals close together';
 state:=app_api.mutate_payment(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','void','id',payment_all,'expectedPaymentVersion',2,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reason','Disposable fixture reversal'));
 assert (select sum((value->>'remainingMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'receiverId'=b)=260,'void restores only that payment allocations';
 -- Editing a settled share does not erase the historical 40-cent receipt.
 expense:=app_api.mutate_expense(repeat('f',64),gen_random_uuid(),jsonb_build_object('operation','update','id',first_id,'expectedVersion',1,'payerId',b,'description','Expense first edited','spentOn','2026-01-01','amountMinor','120','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','120'))));
 state:=app_api.payment_context(repeat('d',64));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'confirmedMinor'='40' and position->>'remainingMinor'='80','edit adds only the new residual';
 -- Legacy/general matching receipt is accounted oldest-first without mutation.
 state:=app_api.mutate_payment(repeat('d',64),gen_random_uuid(),jsonb_build_object('operation','register','senderId',a,'receiverId',b,'amountMinor','30','currency','PEN','expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 payment_two:=state->'payments'->3->>'id';
 state:=app_api.mutate_payment(repeat('e',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',payment_two,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reviewedLedgerVersion',(state->>'ledgerVersion')::bigint));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'confirmedMinor'='70' and position->>'remainingMinor'='50','legacy credit is not collected a second time';
 -- No runtime principal can bypass the reviewed wrapper or inspect allocation tables.
 reset role;
 assert not has_function_privilege('cusco_bff','app_private.mutate_payment_v1(text,uuid,jsonb)','EXECUTE');
 assert not has_function_privilege('anon','app_private.settlement_positions_json(uuid)','EXECUTE');
 assert not has_table_privilege('cusco_bff','app_private.payments','SELECT');
end $$;
rollback;

-- Independent penny conversion and legacy unmatched-credit fixture.
begin;
insert into app_private.participants(id,trip_id,display_name) values
 ('d4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Penny A'),
 ('d4000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Penny B'),
 ('d4000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Penny C');
insert into app_private.access_links(id,trip_id,role,token_hash) values('d5000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','admin',repeat('9',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values('00000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001',repeat('9',64),1,now()+interval '1 hour');
do $$
declare state jsonb; expense jsonb; expense_id text; a constant text:='d4000000-0000-4000-8000-000000000001'; b constant text:='d4000000-0000-4000-8000-000000000002'; c constant text:='d4000000-0000-4000-8000-000000000003'; payment_id text; failed boolean;
begin
 set local role cusco_bff;
 state:=app_api.payment_context(repeat('9',64));
 state:=app_api.mutate_payment(repeat('9',64),gen_random_uuid(),jsonb_build_object('operation','configure','mode','consolidated','rateNumerator','15','rateDenominator','10','expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 expense:=app_api.mutate_expense(repeat('9',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',c,'description','Penny USD','spentOn','2026-01-01','amountMinor','3','currency','USD','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','1'),jsonb_build_object('participantId',b,'amountMinor','2'))));
 expense_id:=expense->>'id';
 state:=app_api.payment_context(repeat('9',64));
 assert (select sum((value->>'amountMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'expenseId'=expense_id)=5,'half-up converted total is 5 PEN cents';
 assert (select value->>'amountMinor' from jsonb_array_elements(state->'positions') where value->>'senderId'=a)='2','largest remainder gives the residual cent to A';
 assert (select value->>'amountMinor' from jsonb_array_elements(state->'positions') where value->>'senderId'=b)='3';
 state:=app_api.mutate_payment(repeat('9',64),gen_random_uuid(),jsonb_build_object('operation','register','senderId',a,'receiverId',b,'amountMinor','1','currency','PEN','expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 payment_id:=state->'payments'->0->>'id';
 state:=app_api.mutate_payment(repeat('9',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',payment_id,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reviewedLedgerVersion',(state->>'ledgerVersion')::bigint));
 assert jsonb_array_length(state->'reconciliationRequired')=1,'unmatched prior receipt remains explicit credit';
 failed:=false;
 begin
  perform app_api.mutate_payment(repeat('9',64),gen_random_uuid(),jsonb_build_object('operation','register','senderId',a,'receiverId',c,'amountMinor','2','currency','PEN','expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'expenseIds',jsonb_build_array(expense_id)));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'unmatched credit blocks unsafe new attributed collection';
end $$;
rollback;
