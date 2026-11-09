\set ON_ERROR_STOP on
-- Only the existing disposable CI database executes this transactional fixture.
begin;
insert into app_private.participants(id,trip_id,display_name) values
 ('e1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Receipt sender'),
 ('e1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Receipt receiver'),
 ('e1000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Receipt stranger');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
 ('e2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','participant',repeat('4',64)),
 ('e2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002','participant',repeat('5',64)),
 ('e2000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','participant',repeat('6',64)),
 ('e2000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001',null,'admin',repeat('7',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
 ('00000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001',repeat('4',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002',repeat('5',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003',repeat('6',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000004',repeat('7',64),1,now()+interval '1 hour');
do $$
declare
 a constant text:='e1000000-0000-4000-8000-000000000001'; b constant text:='e1000000-0000-4000-8000-000000000002';
 c constant text:='e1000000-0000-4000-8000-000000000003'; receiver_actor constant text:='e2000000-0000-4000-8000-000000000002';
 state jsonb; expense jsonb; first_id text; second_id text; third_id text; command jsonb; original jsonb;
 receipt_id text; pending_id text; key uuid; failed boolean; position jsonb; previous_version bigint; original_command jsonb; fourth_id text; fifth_id text;
begin
 set local role cusco_bff;
 expense:=app_api.mutate_expense(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Receipt first','spentOn','2026-01-01','amountMinor','100','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','100'))));
 first_id:=expense->>'id';
 expense:=app_api.mutate_expense(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Receipt second','spentOn','2026-01-02','amountMinor','200','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','200'))));
 second_id:=expense->>'id';
 expense:=app_api.mutate_expense(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',c,'description','Different receiver expense','spentOn','2026-01-03','amountMinor','50','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','50'))));
 third_id:=expense->>'id';
 state:=app_api.payment_context(repeat('5',64));
 command:=jsonb_build_object('operation','receive','senderId',a,'receiverId',b,'amountMinor','40','currency','PEN','expenseIds',jsonb_build_array(first_id),'expectedLedgerVersion',(state->>'ledgerVersion')::bigint);
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command);
 exception when object_not_in_prerequisite_state then failed:=(sqlerrm='configuration_required'); end;
 assert failed,'receiver cannot settle before administrative configuration choice';
 state:=app_api.mutate_payment(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','configure','mode','separate','expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 command:=command||jsonb_build_object('expectedLedgerVersion',(state->>'ledgerVersion')::bigint);
 failed:=false;
 begin perform app_api.mutate_payment(repeat('4',64),gen_random_uuid(),command);
 exception when insufficient_privilege then failed:=true; end;
 assert failed,'sender cannot attest receipt for receiver';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('6',64),gen_random_uuid(),command);
 exception when insufficient_privilege then failed:=true; end;
 assert failed,'unrelated participant cannot settle another receiver debt';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command-'expenseIds');
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'receiver receipt requires expense attribution';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||'{"currency":"USD"}');
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'receipt cannot change expense currency';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||jsonb_build_object('expenseIds',jsonb_build_array(third_id)));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'receipt must match selected expense actual receiver';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||jsonb_build_object('expenseIds',jsonb_build_array(first_id,first_id)));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'duplicate expense IDs rejected';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||jsonb_build_object('expenseIds',jsonb_build_array(gen_random_uuid())));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'unknown or foreign-trip expenses cannot be attributed';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||jsonb_build_object('expectedLedgerVersion',0));
 exception when serialization_failure then failed:=(sqlerrm='ledger_version_conflict'); end;
 assert failed,'receipt always requires the current reviewed ledger';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||jsonb_build_object('createdBy',receiver_actor));
 exception when invalid_parameter_value then failed:=true; end;
 assert failed,'receipt actor metadata cannot come from client';
 previous_version:=(state->>'ledgerVersion')::bigint; key:=gen_random_uuid(); original_command:=command;
 state:=app_api.mutate_payment(repeat('5',64),key,command); original:=state;
 receipt_id:=state->'payments'->0->>'id';
 assert (state->>'ledgerVersion')::bigint=previous_version+1,'register and receipt confirmation are one atomic ledger revision';
 assert state->'payments'->0->>'state'='confirmed' and state->'payments'->0->>'version'='2';
 assert state->'payments'->0->>'createdBy'=receiver_actor and state->'payments'->0->>'confirmedBy'=receiver_actor,'actual receiver is recorded as creator and confirmer';
 assert state->'payments'->0->'expenseAllocations'->0->>'expenseId'=first_id;
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='60' and position->>'confirmedMinor'='40' and position->>'pendingMinor'='0';
 assert app_api.mutate_payment(repeat('5',64),key,command)=original,'durable receiver retry is exact';
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),key,command||'{"amountMinor":"41"}');
 exception when unique_violation then failed:=true; end;
 assert failed,'same key cannot cover a different receipt';
 -- The sender's pending transfer reserves thirty cents. Receiver must confirm
 -- that existing transfer instead of creating another receipt for its amount.
 state:=app_api.mutate_payment(repeat('4',64),gen_random_uuid(),jsonb_build_object('operation','register','senderId',a,'receiverId',b,'amountMinor','30','currency','PEN','expenseIds',jsonb_build_array(first_id),'expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 pending_id:=state->'payments'->1->>'id';
 command:=command||jsonb_build_object('expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'amountMinor','40');
 failed:=false;
 begin perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command);
 exception when serialization_failure then failed:=(sqlerrm='payment_positions_conflict'); end;
 assert failed,'receiver receipt cannot consume reserved pending amount';
 state:=app_api.mutate_payment(repeat('5',64),gen_random_uuid(),command||'{"amountMinor":"30"}');
 state:=app_api.mutate_payment(repeat('5',64),gen_random_uuid(),jsonb_build_object('operation','confirm','id',pending_id,'expectedPaymentVersion',1,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reviewedLedgerVersion',(state->>'ledgerVersion')::bigint));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='0' and position->>'pendingMinor'='0','one expense is fully covered without duplicate receipt';
 -- Admin may attest a full remaining person balance, keeping its actor identity.
 state:=app_api.mutate_payment(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','receive','senderId',a,'receiverId',b,'amountMinor','200','currency','PEN','expenseIds',jsonb_build_array(second_id),'expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 assert (select sum((value->>'remainingMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'senderId'=a and value->>'receiverId'=b)=0;
 assert state->'payments'->3->>'createdBy'='e2000000-0000-4000-8000-000000000004';
 -- A full person receipt covers multiple expense shares in one transaction.
 expense:=app_api.mutate_expense(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Grouped receipt first','spentOn','2026-01-04','amountMinor','15','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','15'))));
 fourth_id:=expense->>'id';
 expense:=app_api.mutate_expense(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','create','payerId',b,'description','Grouped receipt second','spentOn','2026-01-05','amountMinor','25','currency','PEN','splits',jsonb_build_array(jsonb_build_object('participantId',a,'amountMinor','25'))));
 fifth_id:=expense->>'id';
 state:=app_api.payment_context(repeat('5',64));
 state:=app_api.mutate_payment(repeat('5',64),gen_random_uuid(),jsonb_build_object('operation','receive','senderId',a,'receiverId',b,'amountMinor','40','currency','PEN','expenseIds',jsonb_build_array(fourth_id,fifth_id),'expectedLedgerVersion',(state->>'ledgerVersion')::bigint));
 assert jsonb_array_length(state->'payments'->4->'expenseAllocations')=2,'person receipt attributes every selected expense';
 assert (select sum((value->>'remainingMinor')::numeric) from jsonb_array_elements(state->'positions') where value->>'senderId'=a and value->>'receiverId'=b)=0;
 -- The same key still returns the first receipt result after unrelated revisions.
 assert app_api.mutate_payment(repeat('5',64),key,original_command)=original;
 failed:=false;
 begin
  perform app_api.mutate_payment(repeat('5',64),gen_random_uuid(),jsonb_build_object('operation','void','id',receipt_id,'expectedPaymentVersion',2,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reason','Unauthorized receiver reversal'));
 exception when insufficient_privilege then failed:=true; end;
 assert failed,'receiver cannot void an already confirmed receipt';
 state:=app_api.mutate_payment(repeat('7',64),gen_random_uuid(),jsonb_build_object('operation','void','id',receipt_id,'expectedPaymentVersion',2,'expectedLedgerVersion',(state->>'ledgerVersion')::bigint,'reason','Disposable direct receipt reversal'));
 select value into position from jsonb_array_elements(state->'positions') where value->>'expenseId'=first_id;
 assert position->>'remainingMinor'='40','admin void restores exactly the direct receipt allocation';
 assert app_api.mutate_payment(repeat('5',64),key,original_command)=original,'old receipt retry does not recreate a voided receipt';
 reset role;
 assert (select count(*) from app_private.payment_audit_events where entity_id=receipt_id::uuid and action='payment.register')=1;
 assert (select count(*) from app_private.payment_audit_events where entity_id=receipt_id::uuid and action='payment.confirm')=1;
 assert (select count(distinct ledger_version) from app_private.payment_audit_events where entity_id=receipt_id::uuid and action in ('payment.register','payment.confirm'))=1;
 assert not has_function_privilege('cusco_bff','app_private.mutate_payment_v1(text,uuid,jsonb)','EXECUTE');
 assert not has_table_privilege('cusco_bff','app_private.payments','INSERT');
end $$;
rollback;
