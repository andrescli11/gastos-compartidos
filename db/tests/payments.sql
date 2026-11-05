\set ON_ERROR_STOP on
-- Aplicar schema.sql, access.sql, payments.sql en base efímera vacía antes.
-- Prueba secuencial; NO demuestra carreras entre conexiones PostgreSQL.
begin;
insert into app_private.participants(id,trip_id,display_name) values
('81000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Sender fixture'),
('81000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Receiver fixture');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
('82000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','participant',repeat('a',64)),
('82000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002','participant',repeat('b',64)),
('82000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',null,'admin',repeat('c',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
('00000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',repeat('1',64),1,now()+interval '1 hour'),
('00000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',repeat('2',64),1,now()+interval '1 hour'),
('00000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000003',repeat('3',64),1,now()+interval '1 hour');
do $$
declare
 v_result jsonb; v_saved jsonb; v_command jsonb; v_id uuid; v_rejected boolean; v_version bigint; v_count bigint;
begin
 set local role cusco_bff;
 v_result:=app_api.payment_context(repeat('1',64));
 assert v_result->>'ledgerVersion'='0';
 assert v_result->'configurationChosenBy'='null'::jsonb;
 assert v_result->'actor'->>'id'='82000000-0000-4000-8000-000000000001';
 assert jsonb_array_length(v_result->'participants')=2;
 v_command:=jsonb_build_object('operation','register','senderId','81000000-0000-4000-8000-000000000001',
   'receiverId','81000000-0000-4000-8000-000000000002','amountMinor','123','currency','USD','expectedLedgerVersion',0);
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command);
 exception when insufficient_privilege then v_rejected:=true; end;
 assert v_rejected,'receiver cannot register payment for sender';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('1',64),gen_random_uuid(),v_command||'{"createdBy":"spoof"}');
 exception when invalid_parameter_value then v_rejected:=true; end;
 assert v_rejected,'identity cannot come from command';
 v_saved:=app_api.mutate_payment(repeat('1',64),'83000000-0000-4000-8000-000000000001',v_command);
 assert v_saved->>'ledgerVersion'='1';
 assert v_saved->'payments'->0->>'amountMinor'='123';
 v_id:=(v_saved->'payments'->0->>'id')::uuid;
 assert app_api.mutate_payment(repeat('1',64),'83000000-0000-4000-8000-000000000001',v_command)=v_saved;
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('1',64),'83000000-0000-4000-8000-000000000001',v_command||'{"amountMinor":"124"}');
 exception when unique_violation then v_rejected:=true; end;
 assert v_rejected,'key payload mismatch';
 v_command:=jsonb_build_object('operation','confirm','id',v_id,'expectedPaymentVersion',1,'expectedLedgerVersion',1,'reviewedLedgerVersion',1);
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('1',64),gen_random_uuid(),v_command);
 exception when insufficient_privilege then v_rejected:=true; end;
 assert v_rejected,'sender cannot confirm own outbound payment';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command);
 exception when object_not_in_prerequisite_state then v_rejected:=(sqlerrm='configuration_required'); end;
 assert v_rejected,'admin explicitly chooses default mode before confirmation';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('3',64),gen_random_uuid(),'{"operation":"configure","mode":"consolidated","rateNumerator":"37","rateDenominator":"10","expectedLedgerVersion":1}');
 exception when object_not_in_prerequisite_state then v_rejected:=(sqlerrm='configuration_locked'); end;
 assert v_rejected,'pending payment prevents actual configuration change';
 v_result:=app_api.mutate_payment(repeat('3',64),gen_random_uuid(),'{"operation":"configure","mode":"separate","expectedLedgerVersion":1}');
 assert v_result->>'ledgerVersion'='2';
 assert v_result->>'configurationChosenBy'='82000000-0000-4000-8000-000000000003';
 -- Ledger changed by explicit configuration choice. Old reviewed snapshot is rejected.
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command-'reviewedLedgerVersion');
 exception when invalid_parameter_value then v_rejected:=true; end;
 assert v_rejected,'confirmation always requires reviewed version';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command||'{"expectedLedgerVersion":2}');
 exception when serialization_failure then v_rejected:=true; end;
 assert v_rejected,'review stale after configuration';
 v_command:=v_command||'{"expectedLedgerVersion":2,"reviewedLedgerVersion":2}';
 v_result:=app_api.mutate_payment(repeat('2',64),'83000000-0000-4000-8000-000000000002',v_command);
 assert v_result->>'ledgerVersion'='3';
 assert v_result->'payments'->0->>'state'='confirmed';
 assert v_result->'payments'->0->>'confirmedBy'='82000000-0000-4000-8000-000000000002';
 assert app_api.mutate_payment(repeat('2',64),'83000000-0000-4000-8000-000000000002',v_command)=v_result;
 -- A fresh key for the same authorized transition is a semantic no-op.
 assert app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command)->>'ledgerVersion'='3';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('3',64),gen_random_uuid(),'{"operation":"configure","mode":"consolidated","rateNumerator":"37","rateDenominator":"10","expectedLedgerVersion":3}');
 exception when object_not_in_prerequisite_state then v_rejected:=true; end;
 assert v_rejected,'confirmed payment prevents configuration change';
 v_command:=jsonb_build_object('operation','void','id',v_id,'expectedPaymentVersion',2,'expectedLedgerVersion',3,'reason','private fixture reason');
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command);
 exception when insufficient_privilege then v_rejected:=true; end;
 assert v_rejected,'receiver cannot void';
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('3',64),gen_random_uuid(),v_command-'reason');
 exception when invalid_parameter_value then v_rejected:=true; end;
 assert v_rejected,'void reason is mandatory';
 v_result:=app_api.mutate_payment(repeat('3',64),gen_random_uuid(),v_command);
 assert v_result->>'ledgerVersion'='4';
 assert v_result->'payments'->0->>'voidReason'='private fixture reason';
 assert v_result->'payments'->0->>'confirmedBy'='82000000-0000-4000-8000-000000000002';
 v_result:=app_api.payment_context(repeat('1',64));
 assert v_result->'payments'->0->'voidReason'='null'::jsonb,'private reason hidden from participants';
 v_result:=app_api.mutate_payment(repeat('3',64),gen_random_uuid(),'{"operation":"configure","mode":"consolidated","rateNumerator":"37","rateDenominator":"10","expectedLedgerVersion":4}');
 assert v_result->>'ledgerVersion'='5';
 assert v_result->'configuration'->'rate'->>'numerator'='37';
 assert v_result->'payments'->0->>'currency'='USD','historical void USD preserved';
 v_result:=app_api.mutate_payment(repeat('3',64),gen_random_uuid(),'{"operation":"configure","mode":"consolidated","rateNumerator":"74","rateDenominator":"20","expectedLedgerVersion":4}');
 assert v_result->>'ledgerVersion'='5','equivalent rational configuration is a no-op';
 v_command:=jsonb_build_object('operation','register','senderId','81000000-0000-4000-8000-000000000001',
   'receiverId','81000000-0000-4000-8000-000000000002','amountMinor','99','currency','USD','expectedLedgerVersion',5);
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('1',64),gen_random_uuid(),v_command);
 exception when invalid_parameter_value then v_rejected:=true; end;
 assert v_rejected,'consolidated payments exclusively PEN';
 v_result:=app_api.mutate_payment(repeat('1',64),gen_random_uuid(),v_command||'{"currency":"PEN"}');
 v_id:=(v_result->'payments'->1->>'id')::uuid;
 v_command:=jsonb_build_object('operation','reject','id',v_id,'expectedPaymentVersion',1,'expectedLedgerVersion',6);
 v_result:=app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command);
 assert v_result->>'ledgerVersion'='7';
 assert app_api.mutate_payment(repeat('2',64),gen_random_uuid(),v_command)->>'ledgerVersion'='7';
 -- Active expense snapshots and payment ledger share the same version counter.
 perform app_api.mutate_expense(repeat('1',64),gen_random_uuid(),'{"operation":"create","payerId":"81000000-0000-4000-8000-000000000001","description":"Snapshot fixture","spentOn":"2026-01-01","amountMinor":"321","currency":"PEN","splits":[{"participantId":"81000000-0000-4000-8000-000000000002","amountMinor":"321"}]}');
 v_result:=app_api.payment_context(repeat('1',64));
 assert v_result->>'ledgerVersion'='8';
 assert jsonb_array_length(v_result->'expenses')=1;
 assert v_result->'expenses'->0->>'amountMinor'='321';
 assert v_result->'expenses'->0->'splits'->0->>'amountMinor'='321';
 v_rejected:=false;
 begin perform app_api.payment_context(repeat('f',64));
 exception when invalid_authorization_specification then v_rejected:=true; end;
 assert v_rejected,'session validation mandatory';
 reset role;
 assert (select count(*) from app_private.payments)=2;
 assert (select count(*) from app_private.payment_audit_events)=7,'replays do not create audit events';
 assert (select count(*) from app_private.payment_audit_events where action='payment.confirm')=1;
 assert not has_table_privilege('cusco_bff','app_private.payments','SELECT');
 assert not has_function_privilege('cusco_bff','app_private.payment_ledger_json(uuid,boolean)','EXECUTE');
 assert (select relrowsecurity from pg_class where oid='app_private.payments'::regclass);
 assert (select relrowsecurity from pg_class where oid='app_private.payment_audit_events'::regclass);
 -- Revocation applies even to a durable replay.
 update app_private.access_links set revoked_at=now() where id='82000000-0000-4000-8000-000000000001';
 set local role cusco_bff;
 v_rejected:=false;
 begin perform app_api.mutate_payment(repeat('1',64),'83000000-0000-4000-8000-000000000001','{}');
 exception when invalid_authorization_specification then v_rejected:=true; end;
 assert v_rejected,'revoked actor cannot replay';
 reset role;
end $$;
set constraints all immediate;
rollback;
\echo 'OK: payment states, authorization, durable/semantic idempotency, configuration and privacy'
