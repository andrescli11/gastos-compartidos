-- Receiver-initiated settlement. Additive replacement of the public wrapper;
-- the original private state machine and prior migrations remain unchanged.
begin;
create or replace function app_api.mutate_payment(p_session_hash text,p_key uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor app_private.access_links; saved app_private.idempotency_keys; snapshot jsonb; v_result jsonb;
 positions jsonb; pos jsonb; allocation_json jsonb:='[]'::jsonb; selected_ids uuid[];
 sender uuid; receiver uuid; requested numeric; left_minor numeric; take_minor numeric;
 payment_id uuid; old_ids uuid[]; has_selection boolean; is_receipt boolean;
 current_trip app_private.trip;
begin
 actor:=app_private.require_session(p_session_hash);
 select * into current_trip from app_private.trip where id=actor.trip_id for update;
 if p_key is null or p_command is null or jsonb_typeof(p_command)<>'object' or octet_length(p_command::text)>16384 then
  raise exception using errcode='22023',message='invalid_payment_command';
 end if;
 select * into saved from app_private.idempotency_keys where actor_link_id=actor.id and scope='payment' and key=p_key;
 if found then
  if saved.request<>p_command then raise exception using errcode='23505',message='idempotency_conflict'; end if;
  return saved.result;
 end if;
 is_receipt:=p_command->>'operation'='receive';
 if is_receipt then
  if exists(select 1 from jsonb_object_keys(p_command) item(key) where key not in ('operation','senderId','receiverId','amountMinor','currency','expenseIds','expectedLedgerVersion')) then
   raise exception using errcode='22023',message='invalid_payment_command';
  end if;
  if not(p_command ? 'expenseIds') then raise exception using errcode='22023',message='invalid_payment_selection'; end if;
  if jsonb_typeof(p_command->'expectedLedgerVersion') is distinct from 'number'
    or (p_command->>'expectedLedgerVersion') !~ '^(0|[1-9][0-9]{0,15})$'
    or (p_command->>'expectedLedgerVersion')::numeric>9007199254740991 then
   raise exception using errcode='22023',message='invalid_ledger_version';
  end if;
 end if;
 has_selection:=p_command ? 'expenseIds';
 if has_selection then
  if p_command->>'operation' not in ('register','receive') or jsonb_typeof(p_command->'expenseIds') is distinct from 'array'
    or jsonb_array_length(p_command->'expenseIds') not between 1 and 200
    or exists(select 1 from jsonb_array_elements(p_command->'expenseIds') item where jsonb_typeof(item)<>'string' or (item#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
   raise exception using errcode='22023',message='invalid_payment_selection';
  end if;
  select array_agg(value::uuid) into selected_ids from jsonb_array_elements_text(p_command->'expenseIds');
  if cardinality(selected_ids)<>(select count(distinct id) from unnest(selected_ids) id) then
   raise exception using errcode='22023',message='invalid_payment_selection';
  end if;
  if jsonb_typeof(p_command->'senderId') is distinct from 'string' or jsonb_typeof(p_command->'receiverId') is distinct from 'string'
    or (p_command->>'senderId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or (p_command->>'receiverId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   raise exception using errcode='22023',message='invalid_payment';
  end if;
  sender:=(p_command->>'senderId')::uuid; receiver:=(p_command->>'receiverId')::uuid;
  if actor.role<>'admin' and actor.participant_id is distinct from case when is_receipt then receiver else sender end then raise exception using errcode='42501',message='payment_forbidden'; end if;
  if is_receipt then
   if sender=receiver or jsonb_typeof(p_command->'currency') is distinct from 'string' or p_command->>'currency' not in ('PEN','USD')
     or (current_trip.settlement_mode='consolidated' and p_command->>'currency'<>'PEN')
     or (select count(*) from app_private.participants where trip_id=actor.trip_id and id in (sender,receiver) and active)<>2 then
    raise exception using errcode='22023',message='invalid_payment';
   end if;
   if current_trip.configuration_chosen_by is null then raise exception using errcode='55000',message='configuration_required'; end if;
   if (p_command->>'expectedLedgerVersion')::numeric<>current_trip.ledger_version or current_trip.ledger_version=9007199254740991 then
    raise exception using errcode='40001',message='ledger_version_conflict';
   end if;
  end if;
  if jsonb_typeof(p_command->'amountMinor') is distinct from 'string' or (p_command->>'amountMinor') !~ '^[1-9][0-9]{0,13}$' then
   raise exception using errcode='22023',message='invalid_payment';
  end if;
  requested:=(p_command->>'amountMinor')::numeric;
  snapshot:=app_private.settlement_positions_json(actor.trip_id);
  if exists(select 1 from jsonb_array_elements(snapshot->'reconciliationRequired') warning
    where warning->>'currency'=p_command->>'currency' and (warning->>'senderId' in (sender::text,receiver::text) or warning->>'receiverId' in (sender::text,receiver::text))) then
   raise exception using errcode='22023',message='payment_reconciliation_required';
  end if;
  positions:=snapshot->'positions';
  if cardinality(selected_ids)<>(select count(*) from jsonb_array_elements(positions) position
    where (position->>'expenseId')::uuid=any(selected_ids) and position->>'senderId'=sender::text
      and position->>'receiverId'=receiver::text and position->>'currency'=p_command->>'currency') then
   raise exception using errcode='22023',message='invalid_payment_selection';
  end if;
  left_minor:=requested;
  for pos in select value from jsonb_array_elements(positions) where (value->>'expenseId')::uuid=any(selected_ids)
    and value->>'senderId'=sender::text and value->>'receiverId'=receiver::text and value->>'currency'=p_command->>'currency'
  loop
   take_minor:=least(left_minor,greatest(0,(pos->>'remainingMinor')::numeric-(pos->>'pendingMinor')::numeric));
   if take_minor>0 then allocation_json:=allocation_json||jsonb_build_array(jsonb_build_object('expenseId',pos->>'expenseId','amountMinor',take_minor::text)); end if;
   left_minor:=left_minor-take_minor;
  end loop;
  if left_minor<>0 then raise exception using errcode='40001',message='payment_positions_conflict'; end if;
 end if;
 if is_receipt then
  -- The actual receiver explicitly attests that the external money was already
  -- received. No sender identity is impersonated and no pending reservation is
  -- bypassed: the allocations above came only from unreserved current debt.
  insert into app_private.payments(trip_id,sender_id,receiver_id,amount_minor,currency,state,version,created_by,confirmed_by,confirmed_at,expense_allocations)
   values(actor.trip_id,sender,receiver,requested::bigint,p_command->>'currency','confirmed',2,actor.id,actor.id,clock_timestamp(),allocation_json)
   returning id into payment_id;
  update app_private.trip set ledger_version=ledger_version+1 where id=actor.trip_id;
  insert into app_private.payment_audit_events(trip_id,actor_link_id,action,entity_id,ledger_version) values
   (actor.trip_id,actor.id,'payment.register',payment_id,current_trip.ledger_version+1),
   (actor.trip_id,actor.id,'payment.confirm',payment_id,current_trip.ledger_version+1);
 else
 select coalesce(array_agg(id),'{}'::uuid[]) into old_ids from app_private.payments where trip_id=actor.trip_id;
 -- The old function revalidates mode, actors, currency, reviewed versions and
 -- idempotency while holding the same trip row lock. Exceptions roll back all.
 v_result:=app_private.mutate_payment_v1(p_session_hash,p_key,p_command-'expenseIds');
 if has_selection then
  select id into payment_id from app_private.payments where trip_id=actor.trip_id and not(id=any(old_ids));
  if payment_id is null then raise exception using errcode='40001',message='payment_positions_conflict'; end if;
  update app_private.payments set expense_allocations=allocation_json where id=payment_id;
 end if;
 end if;
 v_result:=app_private.payment_ledger_json(actor.trip_id,actor.role='admin')||jsonb_build_object('actor',jsonb_build_object('id',actor.id,'role',actor.role,'participantId',actor.participant_id));
 if is_receipt then
  insert into app_private.idempotency_keys(actor_link_id,scope,key,request,result) values(actor.id,'payment',p_key,p_command,v_result);
 else
  update app_private.idempotency_keys set request=p_command,result=v_result where actor_link_id=actor.id and scope='payment' and key=p_key;
 end if;
 return v_result;
end $$;
revoke all on function app_api.mutate_payment(text,uuid,jsonb) from public,cusco_bff;
grant execute on function app_api.mutate_payment(text,uuid,jsonb) to cusco_bff;
commit;
