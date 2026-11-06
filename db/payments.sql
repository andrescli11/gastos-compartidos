-- Fuente: aplicar después de schema.sql y access.sql, antes de habilitar el BFF.
-- Generar migración con CLI y validar en PostgreSQL efímero antes de desplegar.
begin;
alter table app_private.trip
  add column configuration_chosen_by uuid references app_private.access_links(id),
  add column configuration_chosen_at timestamptz,
  add constraint configuration_choice_complete check ((configuration_chosen_by is null) = (configuration_chosen_at is null)),
  add constraint ledger_version_json_safe check (ledger_version <= 9007199254740991);
create table app_private.payments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  sender_id uuid not null, receiver_id uuid not null,
  amount_minor bigint not null check (amount_minor between 1 and 99999999999999),
  currency text not null check (currency in ('PEN','USD')),
  state text not null default 'pending' check (state in ('pending','confirmed','rejected','voided')),
  version integer not null default 1 check (version > 0),
  created_by uuid not null, confirmed_by uuid, rejected_by uuid, voided_by uuid,
  void_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz, rejected_at timestamptz, voided_at timestamptz,
  foreign key(trip_id,sender_id) references app_private.participants(trip_id,id),
  foreign key(trip_id,receiver_id) references app_private.participants(trip_id,id),
  foreign key(trip_id,created_by) references app_private.access_links(trip_id,id),
  foreign key(trip_id,confirmed_by) references app_private.access_links(trip_id,id),
  foreign key(trip_id,rejected_by) references app_private.access_links(trip_id,id),
  foreign key(trip_id,voided_by) references app_private.access_links(trip_id,id),
  check(sender_id <> receiver_id),
  check ((confirmed_by is null) = (confirmed_at is null)),
  check ((rejected_by is null) = (rejected_at is null)),
  check ((voided_by is null) = (voided_at is null)),
  check (
    (state='pending' and confirmed_by is null and rejected_by is null and voided_by is null and void_reason is null) or
    (state='confirmed' and confirmed_by is not null and rejected_by is null and voided_by is null and void_reason is null) or
    (state='rejected' and confirmed_by is null and rejected_by is not null and voided_by is null and void_reason is null) or
    (state='voided' and confirmed_by is not null and rejected_by is null and voided_by is not null
      and void_reason is not null and length(btrim(void_reason)) between 1 and 500)
  ),
  unique(trip_id,id)
);
create index payments_trip_state_idx on app_private.payments(trip_id,state);
create index payments_sender_idx on app_private.payments(trip_id,sender_id);
create index payments_receiver_idx on app_private.payments(trip_id,receiver_id);
create index payments_creator_idx on app_private.payments(trip_id,created_by);
create index payments_confirmer_idx on app_private.payments(trip_id,confirmed_by);
create index payments_rejecter_idx on app_private.payments(trip_id,rejected_by);
create index payments_voider_idx on app_private.payments(trip_id,voided_by);
create index trip_configuration_actor_idx on app_private.trip(configuration_chosen_by);
-- Auditoría mínima: nunca incluye dinero, motivos ni snapshots privados.
create table app_private.payment_audit_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  actor_link_id uuid not null references app_private.access_links(id),
  action text not null check(action in ('payment.register','payment.confirm','payment.reject','payment.void','settlement.configure')),
  entity_id uuid references app_private.payments(id),
  ledger_version bigint not null check(ledger_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  check((action='settlement.configure') = (entity_id is null))
);
create index payment_audit_trip_idx on app_private.payment_audit_events(trip_id,created_at);
create index payment_audit_actor_idx on app_private.payment_audit_events(actor_link_id);
create index payment_audit_entity_idx on app_private.payment_audit_events(entity_id);
alter table app_private.payments enable row level security;
alter table app_private.payment_audit_events enable row level security;

-- Lectura de snapshot bajo lock compartido del viaje: evita mezclar gastos y versión.
create function app_private.payment_ledger_json(p_trip uuid,p_admin boolean) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
   'ledgerVersion',t.ledger_version,
   'configuration',case when t.settlement_mode='separate' then jsonb_build_object('mode','separate')
     else jsonb_build_object('mode','consolidated','rate',jsonb_build_object('numerator',t.rate_numerator::text,'denominator',t.rate_denominator::text)) end,
   'configurationChosenBy',t.configuration_chosen_by,
   'participants',(select coalesce(jsonb_agg(p.id order by p.id),'[]'::jsonb) from app_private.participants p where p.trip_id=t.id),
   'expenses',(select coalesce(jsonb_agg(app_private.expense_json(e.id) order by e.id),'[]'::jsonb) from app_private.expenses e where e.trip_id=t.id and e.state='active'),
   'payments',(select coalesce(jsonb_agg(jsonb_build_object(
     'id',p.id,'senderId',p.sender_id,'receiverId',p.receiver_id,'amountMinor',p.amount_minor::text,
     'currency',p.currency,'state',p.state,'version',p.version,'createdBy',p.created_by,
     'confirmedBy',p.confirmed_by,'rejectedBy',p.rejected_by,'voidedBy',p.voided_by,
     'voidReason',case when p_admin then p.void_reason else null end) order by p.created_at,p.id),'[]'::jsonb)
     from app_private.payments p where p.trip_id=t.id))
 from app_private.trip t where t.id=p_trip;
$$;
create function app_api.payment_context(p_session_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor app_private.access_links;
begin
 v_actor:=app_private.require_session(p_session_hash);
 perform 1 from app_private.trip where id=v_actor.trip_id for share;
 return app_private.payment_ledger_json(v_actor.trip_id,v_actor.role='admin') || jsonb_build_object('actor',jsonb_build_object('id',v_actor.id,'role',v_actor.role,'participantId',v_actor.participant_id));
end $$;

create function app_api.mutate_payment(p_session_hash text,p_key uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_actor app_private.access_links; v_trip app_private.trip; v_saved app_private.idempotency_keys;
 v_payment app_private.payments; v_op text; v_target text; v_id uuid; v_sender uuid; v_receiver uuid;
 v_mode text; v_num bigint; v_den bigint; v_same boolean; v_reason text; v_result jsonb;
 v_effect boolean:=true; v_allowed text[];
begin
 v_actor:=app_private.require_session(p_session_hash);
 -- Mismo primer lock financiero que gastos/configuración/confirmación.
 select * into v_trip from app_private.trip where id=v_actor.trip_id for update;
 if p_key is null or p_command is null or jsonb_typeof(p_command)<>'object' or octet_length(p_command::text)>4096 then
   raise exception using errcode='22023',message='invalid_payment_command';
 end if;
 select * into v_saved from app_private.idempotency_keys where actor_link_id=v_actor.id and scope='payment' and key=p_key;
 if found then
   if v_saved.request<>p_command then raise exception using errcode='23505',message='idempotency_conflict'; end if;
   return v_saved.result;
 end if;
 v_op:=p_command->>'operation';
 if jsonb_typeof(p_command->'operation') is distinct from 'string' or v_op not in ('register','confirm','reject','void','configure') then
   raise exception using errcode='22023',message='invalid_payment_command';
 end if;
 v_allowed:=case v_op
   when 'register' then array['operation','senderId','receiverId','amountMinor','currency','expectedLedgerVersion']
   when 'configure' then array['operation','mode','rateNumerator','rateDenominator','expectedLedgerVersion']
   when 'confirm' then array['operation','id','expectedPaymentVersion','expectedLedgerVersion','reviewedLedgerVersion']
   when 'reject' then array['operation','id','expectedPaymentVersion','expectedLedgerVersion']
   else array['operation','id','expectedPaymentVersion','expectedLedgerVersion','reason'] end;
 if exists(select 1 from jsonb_object_keys(p_command) as k(key) where not(key=any(v_allowed))) then
   raise exception using errcode='22023',message='invalid_payment_command';
 end if;
 if jsonb_typeof(p_command->'expectedLedgerVersion') is distinct from 'number'
   or (p_command->>'expectedLedgerVersion') !~ '^(0|[1-9][0-9]{0,15})$'
   or (p_command->>'expectedLedgerVersion')::numeric>9007199254740991 then
   raise exception using errcode='22023',message='invalid_ledger_version';
 end if;
 if v_op='configure' then
   if v_actor.role<>'admin' then raise exception using errcode='42501',message='payment_forbidden'; end if;
   v_mode:=p_command->>'mode';
   if jsonb_typeof(p_command->'mode') is distinct from 'string' or v_mode not in ('separate','consolidated') then
     raise exception using errcode='22023',message='invalid_configuration';
   end if;
   if v_mode='separate' then
     if p_command ? 'rateNumerator' or p_command ? 'rateDenominator' then raise exception using errcode='22023',message='invalid_configuration'; end if;
   else
     if jsonb_typeof(p_command->'rateNumerator') is distinct from 'string' or jsonb_typeof(p_command->'rateDenominator') is distinct from 'string'
       or (p_command->>'rateNumerator') !~ '^[1-9][0-9]{0,17}$' or (p_command->>'rateDenominator') !~ '^[1-9][0-9]{0,17}$' then
       raise exception using errcode='22023',message='invalid_configuration';
     end if;
     v_num:=(p_command->>'rateNumerator')::bigint; v_den:=(p_command->>'rateDenominator')::bigint;
   end if;
   v_same:=v_mode=v_trip.settlement_mode and (v_mode='separate' or v_num::numeric*v_trip.rate_denominator=v_trip.rate_numerator::numeric*v_den);
   if v_same and v_trip.configuration_chosen_by is not null then v_effect:=false;
   else
     if not v_same and exists(select 1 from app_private.payments where trip_id=v_trip.id and state in ('pending','confirmed')) then
       raise exception using errcode='55000',message='configuration_locked';
     end if;
   end if;
 elsif v_op='register' then
   if jsonb_typeof(p_command->'senderId') is distinct from 'string' or jsonb_typeof(p_command->'receiverId') is distinct from 'string'
     or (p_command->>'senderId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or (p_command->>'receiverId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(p_command->'amountMinor') is distinct from 'string' or (p_command->>'amountMinor') !~ '^[1-9][0-9]{0,13}$'
     or jsonb_typeof(p_command->'currency') is distinct from 'string' or (p_command->>'currency') not in ('PEN','USD') then
     raise exception using errcode='22023',message='invalid_payment';
   end if;
   v_sender:=(p_command->>'senderId')::uuid; v_receiver:=(p_command->>'receiverId')::uuid;
   if v_actor.role<>'admin' and v_actor.participant_id<>v_sender then raise exception using errcode='42501',message='payment_forbidden'; end if;
   if v_sender=v_receiver or (v_trip.settlement_mode='consolidated' and p_command->>'currency'<>'PEN')
     or (select count(*) from app_private.participants where trip_id=v_trip.id and id in (v_sender,v_receiver) and active)<>2 then
     raise exception using errcode='22023',message='invalid_payment';
   end if;
 else
   if jsonb_typeof(p_command->'id') is distinct from 'string' or (p_command->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(p_command->'expectedPaymentVersion') is distinct from 'number'
     or (p_command->>'expectedPaymentVersion') !~ '^[1-9][0-9]{0,9}$' then
     raise exception using errcode='22023',message='invalid_payment';
   end if;
   v_id:=(p_command->>'id')::uuid;
   select * into v_payment from app_private.payments where trip_id=v_trip.id and id=v_id for update;
   if not found then raise exception using errcode='40001',message='payment_version_conflict'; end if;
   if (v_op='void' and v_actor.role<>'admin') or (v_op<>'void' and v_actor.role<>'admin' and v_actor.participant_id<>v_payment.receiver_id) then
     raise exception using errcode='42501',message='payment_forbidden';
   end if;
   if v_op='void' then
     v_reason:=btrim(p_command->>'reason');
     if jsonb_typeof(p_command->'reason') is distinct from 'string' or length(v_reason) not between 1 and 500 then
       raise exception using errcode='22023',message='invalid_void_reason';
     end if;
   end if;
   if v_op='confirm' and (jsonb_typeof(p_command->'reviewedLedgerVersion') is distinct from 'number'
     or (p_command->>'reviewedLedgerVersion') !~ '^(0|[1-9][0-9]{0,15})$') then
     raise exception using errcode='22023',message='review_required';
   end if;
   v_target:=case v_op when 'confirm' then 'confirmed' when 'reject' then 'rejected' else 'voided' end;
   if v_payment.state=v_target then
     if v_op='void' and v_payment.void_reason<>v_reason then raise exception using errcode='40001',message='payment_version_conflict'; end if;
     v_effect:=false;
   elsif (v_op='void' and v_payment.state<>'confirmed') or (v_op<>'void' and v_payment.state<>'pending')
     or (p_command->>'expectedPaymentVersion')::bigint<>v_payment.version or v_payment.version=2147483647 then
     raise exception using errcode='40001',message='payment_version_conflict';
   end if;
   if v_effect and v_op='confirm' then
     if v_trip.configuration_chosen_by is null then raise exception using errcode='55000',message='configuration_required'; end if;
     if (p_command->>'reviewedLedgerVersion')::numeric<>v_trip.ledger_version then raise exception using errcode='40001',message='payment_review_conflict'; end if;
     if v_trip.settlement_mode='consolidated' and v_payment.currency<>'PEN' then raise exception using errcode='22023',message='invalid_payment_currency'; end if;
   end if;
 end if;
 if v_effect then
   if (p_command->>'expectedLedgerVersion')::numeric<>v_trip.ledger_version or v_trip.ledger_version=9007199254740991 then
     raise exception using errcode='40001',message='ledger_version_conflict';
   end if;
   if v_op='configure' then
     update app_private.trip set settlement_mode=v_mode,rate_numerator=v_num,rate_denominator=v_den,
       configuration_chosen_by=v_actor.id,configuration_chosen_at=clock_timestamp() where id=v_trip.id;
   elsif v_op='register' then
     insert into app_private.payments(trip_id,sender_id,receiver_id,amount_minor,currency,created_by)
       values(v_trip.id,v_sender,v_receiver,(p_command->>'amountMinor')::bigint,p_command->>'currency',v_actor.id) returning id into v_id;
   else
     update app_private.payments set state=v_target,version=version+1,updated_at=clock_timestamp(),
       confirmed_by=case when v_op='confirm' then v_actor.id else confirmed_by end,
       confirmed_at=case when v_op='confirm' then clock_timestamp() else confirmed_at end,
       rejected_by=case when v_op='reject' then v_actor.id else rejected_by end,
       rejected_at=case when v_op='reject' then clock_timestamp() else rejected_at end,
       voided_by=case when v_op='void' then v_actor.id else voided_by end,
       voided_at=case when v_op='void' then clock_timestamp() else voided_at end,
       void_reason=case when v_op='void' then v_reason else void_reason end where id=v_id;
   end if;
   update app_private.trip set ledger_version=ledger_version+1 where id=v_trip.id;
   insert into app_private.payment_audit_events(trip_id,actor_link_id,action,entity_id,ledger_version)
     values(v_trip.id,v_actor.id,case when v_op='configure' then 'settlement.configure' else 'payment.'||v_op end,v_id,v_trip.ledger_version+1);
 end if;
 v_result:=app_private.payment_ledger_json(v_trip.id,v_actor.role='admin') || jsonb_build_object('actor',jsonb_build_object('id',v_actor.id,'role',v_actor.role,'participantId',v_actor.participant_id));
 insert into app_private.idempotency_keys(actor_link_id,scope,key,request,result) values(v_actor.id,'payment',p_key,p_command,v_result);
 return v_result;
end $$;
revoke all on app_private.payments,app_private.payment_audit_events from public,cusco_bff;
revoke all on function app_private.payment_ledger_json(uuid,boolean) from public,cusco_bff;
revoke all on function app_api.payment_context(text),app_api.mutate_payment(text,uuid,jsonb) from public,cusco_bff;
grant execute on function app_api.payment_context(text),app_api.mutate_payment(text,uuid,jsonb) to cusco_bff;
commit;
