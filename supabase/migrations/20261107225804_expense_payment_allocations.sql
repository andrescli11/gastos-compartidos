-- Additive expense attribution for external payments. Existing amounts and states
-- remain authoritative; no historical payment is rewritten or deleted.
begin;
alter table app_private.payments add column if not exists expense_allocations jsonb not null default '[]'::jsonb
  check(jsonb_typeof(expense_allocations)='array' and jsonb_array_length(expense_allocations)<=200);

-- Produce exact original obligations in the configured settlement currency.
-- USD conversion matches convertExpense: half-up expense total, then largest
-- remainders over original shares, ties resolved by participant UUID.
create or replace function app_private.settlement_positions_json(p_trip uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare
 rows_json jsonb:='[]'::jsonb; warnings_json jsonb:='[]'::jsonb;
 item record; payment app_private.payments; allocation jsonb; pos jsonb;
 idx integer; found_idx integer; field_name text; allocated numeric; amount numeric;
 left_minor numeric; free_minor numeric; take_minor numeric; covered numeric;
begin
 for item in
  with totals as (
   select e.*,case when t.settlement_mode='consolidated' and e.currency='USD'
     then floor((2*e.amount_minor::numeric*t.rate_numerator+t.rate_denominator)/(2*t.rate_denominator::numeric))
     else e.amount_minor::numeric end as converted_total,
     case when t.settlement_mode='consolidated' then 'PEN' else e.currency end as settled_currency
   from app_private.expenses e join app_private.trip t on t.id=e.trip_id
   where e.trip_id=p_trip and e.state='active'
  ), parts as (
   select e.id,e.payer_id,e.description,e.spent_on,e.settled_currency,e.converted_total,s.participant_id,
    floor(e.converted_total*s.amount_minor/e.amount_minor) as base,
    mod(e.converted_total*s.amount_minor,e.amount_minor) as remainder
   from totals e join app_private.expense_splits s on s.expense_id=e.id
  ), ranked as (
   select *, row_number() over(partition by id order by remainder desc,participant_id) as rank,
    converted_total-sum(base) over(partition by id) as residual from parts
  )
  select *,base+case when rank<=residual then 1 else 0 end as share from ranked
  where participant_id<>payer_id and base+case when rank<=residual then 1 else 0 end>0
  order by spent_on,id,participant_id
 loop
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object(
   'expenseId',item.id,'senderId',item.participant_id,'receiverId',item.payer_id,
   'currency',item.settled_currency,'amountMinor',item.share::text,
   'description',item.description,'spentOn',item.spent_on,
   'confirmedMinor','0','pendingMinor','0','remainingMinor',item.share::text));
 end loop;
 -- Confirmed payments take precedence over reservations. A reservation never
 -- changes the financial balance, but prevents a second pending collection.
 for payment in select * from app_private.payments
  where trip_id=p_trip and state in ('confirmed','pending')
  order by case state when 'confirmed' then 0 else 1 end,created_at,id
 loop
  field_name:=case when payment.state='confirmed' then 'confirmedMinor' else 'pendingMinor' end;
  covered:=0;
  for allocation in select value from jsonb_array_elements(payment.expense_allocations)
  loop
   amount:=(allocation->>'amountMinor')::numeric;
   covered:=covered+amount;
   found_idx:=-1;
   for idx in 0..jsonb_array_length(rows_json)-1 loop
    pos:=rows_json->idx;
    if pos->>'expenseId'=allocation->>'expenseId'
      and pos->>'senderId'=payment.sender_id::text and pos->>'receiverId'=payment.receiver_id::text
      and pos->>'currency'=payment.currency then found_idx:=idx; exit; end if;
   end loop;
   if found_idx>=0 then
    pos:=rows_json->found_idx;
    free_minor:=greatest(0,(pos->>'amountMinor')::numeric-(pos->>'confirmedMinor')::numeric-(pos->>'pendingMinor')::numeric);
    allocated:=(pos->>field_name)::numeric+amount;
    rows_json:=jsonb_set(rows_json,array[found_idx::text,field_name],to_jsonb(allocated::text));
    -- Edited/reassigned/voided expenses must not silently re-create a paid debt.
    if amount>free_minor then
     warnings_json:=warnings_json||jsonb_build_array(jsonb_build_object('senderId',payment.sender_id,'receiverId',payment.receiver_id,'currency',payment.currency,'amountMinor',(amount-free_minor)::text));
    end if;
   else
    warnings_json:=warnings_json||jsonb_build_array(jsonb_build_object('senderId',payment.sender_id,'receiverId',payment.receiver_id,'currency',payment.currency,'amountMinor',amount::text));
   end if;
  end loop;
  -- Legacy/general payments have no explicit expense attribution. Consume their
  -- remaining credit against the same pair/currency in stable oldest-first order.
  -- Unmatched credit remains visible and blocks new attributed payments for
  -- either endpoint until reviewed; it is never discarded or invented as debt.
  left_minor:=payment.amount_minor-covered;
  for idx in 0..jsonb_array_length(rows_json)-1 loop
   exit when left_minor<=0;
   pos:=rows_json->idx;
   if pos->>'senderId'=payment.sender_id::text and pos->>'receiverId'=payment.receiver_id::text and pos->>'currency'=payment.currency then
    free_minor:=greatest(0,(pos->>'amountMinor')::numeric-(pos->>'confirmedMinor')::numeric-(pos->>'pendingMinor')::numeric);
    take_minor:=least(left_minor,free_minor);
    if take_minor>0 then
     allocated:=(pos->>field_name)::numeric+take_minor;
     rows_json:=jsonb_set(rows_json,array[idx::text,field_name],to_jsonb(allocated::text));
     left_minor:=left_minor-take_minor;
    end if;
   end if;
  end loop;
  if left_minor>0 then
   warnings_json:=warnings_json||jsonb_build_array(jsonb_build_object('senderId',payment.sender_id,'receiverId',payment.receiver_id,'currency',payment.currency,'amountMinor',left_minor::text));
  end if;
 end loop;
 for idx in 0..jsonb_array_length(rows_json)-1 loop
  pos:=rows_json->idx;
  rows_json:=jsonb_set(rows_json,array[idx::text,'remainingMinor'],to_jsonb(greatest(0,(pos->>'amountMinor')::numeric-(pos->>'confirmedMinor')::numeric)::text));
 end loop;
 return jsonb_build_object('positions',rows_json,'reconciliationRequired',warnings_json);
end $$;

-- Keep the existing reviewed transition machine as a private implementation.
-- The public names/signatures remain stable for rollback compatibility.
do $$ begin
 if to_regprocedure('app_private.payment_ledger_json_v1(uuid,boolean)') is null then
  alter function app_private.payment_ledger_json(uuid,boolean) rename to payment_ledger_json_v1;
 end if;
 if to_regprocedure('app_private.mutate_payment_v1(text,uuid,jsonb)') is null then
  alter function app_api.mutate_payment(text,uuid,jsonb) set schema app_private;
  alter function app_private.mutate_payment(text,uuid,jsonb) rename to mutate_payment_v1;
 end if;
end $$;

create or replace function app_private.payment_ledger_json(p_trip uuid,p_admin boolean) returns jsonb
language sql stable set search_path='' as $$
 select (app_private.payment_ledger_json_v1(p_trip,p_admin)-'payments')
  || app_private.settlement_positions_json(p_trip)
  || jsonb_build_object('payments',(
   select coalesce(jsonb_agg(item.value||jsonb_build_object('expenseAllocations',p.expense_allocations) order by item.ordinality),'[]'::jsonb)
   from jsonb_array_elements(app_private.payment_ledger_json_v1(p_trip,p_admin)->'payments') with ordinality as item(value,ordinality)
   join app_private.payments p on p.id=(item.value->>'id')::uuid and p.trip_id=p_trip));
$$;

-- Recompile the public snapshot reader after replacing the private helper so
-- existing database sessions cannot retain a plan referencing its renamed v1.
create or replace function app_api.payment_context(p_session_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor app_private.access_links;
begin
 actor:=app_private.require_session(p_session_hash);
 perform 1 from app_private.trip where id=actor.trip_id for share;
 return app_private.payment_ledger_json(actor.trip_id,actor.role='admin')
  || jsonb_build_object('actor',jsonb_build_object('id',actor.id,'role',actor.role,'participantId',actor.participant_id));
end $$;

create or replace function app_api.mutate_payment(p_session_hash text,p_key uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor app_private.access_links; saved app_private.idempotency_keys; snapshot jsonb; v_result jsonb;
 positions jsonb; pos jsonb; allocation_json jsonb:='[]'::jsonb; selected_ids uuid[];
 sender uuid; receiver uuid; requested numeric; left_minor numeric; take_minor numeric;
 payment_id uuid; old_ids uuid[]; has_selection boolean;
begin
 actor:=app_private.require_session(p_session_hash);
 perform 1 from app_private.trip where id=actor.trip_id for update;
 if p_key is null or p_command is null or jsonb_typeof(p_command)<>'object' or octet_length(p_command::text)>16384 then
  raise exception using errcode='22023',message='invalid_payment_command';
 end if;
 select * into saved from app_private.idempotency_keys where actor_link_id=actor.id and scope='payment' and key=p_key;
 if found then
  if saved.request<>p_command then raise exception using errcode='23505',message='idempotency_conflict'; end if;
  return saved.result;
 end if;
 has_selection:=p_command ? 'expenseIds';
 if has_selection then
  if p_command->>'operation'<>'register' or jsonb_typeof(p_command->'expenseIds') is distinct from 'array'
    or jsonb_array_length(p_command->'expenseIds') not between 1 and 200
    or exists(select 1 from jsonb_array_elements(p_command->'expenseIds') item where jsonb_typeof(item)<>'string' or (item#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
   raise exception using errcode='22023',message='invalid_payment_selection';
  end if;
  select array_agg(value::uuid) into selected_ids from jsonb_array_elements_text(p_command->'expenseIds');
  if cardinality(selected_ids)<>(select count(distinct id) from unnest(selected_ids) id) then
   raise exception using errcode='22023',message='invalid_payment_selection';
  end if;
  sender:=(p_command->>'senderId')::uuid; receiver:=(p_command->>'receiverId')::uuid;
  if actor.role<>'admin' and actor.participant_id is distinct from sender then raise exception using errcode='42501',message='payment_forbidden'; end if;
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
 select coalesce(array_agg(id),'{}'::uuid[]) into old_ids from app_private.payments where trip_id=actor.trip_id;
 -- The old function revalidates mode, actors, currency, reviewed versions and
 -- idempotency while holding the same trip row lock. Exceptions roll back all.
 v_result:=app_private.mutate_payment_v1(p_session_hash,p_key,p_command-'expenseIds');
 if has_selection then
  select id into payment_id from app_private.payments where trip_id=actor.trip_id and not(id=any(old_ids));
  if payment_id is null then raise exception using errcode='40001',message='payment_positions_conflict'; end if;
  update app_private.payments set expense_allocations=allocation_json where id=payment_id;
 end if;
 v_result:=app_private.payment_ledger_json(actor.trip_id,actor.role='admin')||jsonb_build_object('actor',jsonb_build_object('id',actor.id,'role',actor.role,'participantId',actor.participant_id));
 update app_private.idempotency_keys set request=p_command,result=v_result where actor_link_id=actor.id and scope='payment' and key=p_key;
 return v_result;
end $$;
revoke all on function app_private.settlement_positions_json(uuid),app_private.payment_ledger_json(uuid,boolean),app_private.payment_ledger_json_v1(uuid,boolean),app_private.mutate_payment_v1(text,uuid,jsonb) from public,cusco_bff;
revoke all on function app_api.mutate_payment(text,uuid,jsonb) from public,cusco_bff;
grant execute on function app_api.mutate_payment(text,uuid,jsonb) to cusco_bff;
commit;
