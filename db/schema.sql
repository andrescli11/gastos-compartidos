-- Esquema fuente versionado; generar migración con Supabase CLI antes de desplegar.
-- Solo una base vacía de desarrollo. Nunca se ejecuta automáticamente al arrancar Next.js.
begin;
create schema app_private;
create schema app_api;
revoke all on schema app_private, app_api from public;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'cusco_bff') then
    create role cusco_bff nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
alter default privileges in schema app_private revoke all on tables from public;
alter default privileges in schema app_private revoke execute on functions from public;
alter default privileges in schema app_api revoke execute on functions from public;

create table app_private.trip (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  name text not null check (length(name) between 1 and 160),
  timezone text not null default 'America/Lima',
  settlement_mode text not null default 'separate' check (settlement_mode in ('separate','consolidated')),
  rate_numerator bigint,
  rate_denominator bigint,
  ledger_version bigint not null default 0 check (ledger_version >= 0),
  check ((settlement_mode = 'separate' and rate_numerator is null and rate_denominator is null)
    or (settlement_mode = 'consolidated' and rate_numerator > 0 and rate_denominator > 0
      and rate_numerator is not null and rate_denominator is not null))
);
insert into app_private.trip(id,name) values ('00000000-0000-4000-8000-000000000001','Cusco · Yácole');
create table app_private.participants (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  active boolean not null default true,
  unique (trip_id,id)
);
create table app_private.access_links (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  participant_id uuid,
  role text not null check (role in ('participant','admin')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version > 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (trip_id,participant_id) references app_private.participants(trip_id,id),
  check ((role = 'participant' and participant_id is not null) or (role = 'admin' and participant_id is null)),
  unique (trip_id,id)
);
create table app_private.sessions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null,
  link_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  link_version integer not null check (link_version > 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (trip_id,link_id) references app_private.access_links(trip_id,id)
);
create index sessions_link_idx on app_private.sessions(link_id);
create table app_private.expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  payer_id uuid not null,
  description text not null check (length(btrim(description)) between 1 and 240),
  spent_on date not null check (spent_on between date '2000-01-01' and date '2100-12-31'),
  amount_minor bigint not null check (amount_minor between 1 and 99999999999999),
  currency text not null check (currency in ('PEN','USD')),
  source text not null default 'manual' check (source in ('manual','bulk','csv','excel','image')),
  state text not null default 'active' check (state in ('active','voided')),
  version integer not null default 1 check (version > 0),
  created_by uuid not null references app_private.access_links(id),
  updated_by uuid not null references app_private.access_links(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (trip_id,payer_id) references app_private.participants(trip_id,id),
  unique(trip_id,id)
);
create index expenses_trip_date_idx on app_private.expenses(trip_id,spent_on desc,id);
create index expenses_payer_idx on app_private.expenses(trip_id,payer_id);
create index expenses_created_by_idx on app_private.expenses(created_by);
create index expenses_updated_by_idx on app_private.expenses(updated_by);
create table app_private.expense_splits (
  trip_id uuid not null,
  expense_id uuid not null,
  participant_id uuid not null,
  amount_minor bigint not null check (amount_minor between 1 and 99999999999999),
  primary key (expense_id,participant_id),
  foreign key (trip_id,expense_id) references app_private.expenses(trip_id,id),
  foreign key (trip_id,participant_id) references app_private.participants(trip_id,id)
);
create index splits_participant_idx on app_private.expense_splits(trip_id,participant_id);
-- Historial financiero privado. Auditoría operativa solo usa metadatos opacos.
create table app_private.expense_revisions (
  expense_id uuid not null references app_private.expenses(id),
  version integer not null,
  actor_link_id uuid not null references app_private.access_links(id),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (expense_id,version)
);
create index revisions_actor_idx on app_private.expense_revisions(actor_link_id);
create table app_private.audit_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references app_private.trip(id),
  actor_link_id uuid not null references app_private.access_links(id),
  action text not null check (action in ('expense.create','expense.update','expense.void')),
  entity_id uuid not null references app_private.expenses(id),
  entity_version integer not null,
  created_at timestamptz not null default now()
);
create index audit_trip_idx on app_private.audit_events(trip_id,created_at);
create index audit_actor_idx on app_private.audit_events(actor_link_id);
create index audit_entity_idx on app_private.audit_events(entity_id);
create table app_private.idempotency_keys (
  actor_link_id uuid not null references app_private.access_links(id),
  scope text not null,
  key uuid not null,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_link_id,scope,key)
);

-- Igualdad entre total y partes se valida al final de la transacción.
create function app_private.check_expense_total() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_total bigint; v_sum numeric; v_count bigint;
begin
  if tg_table_name = 'expenses' then
    if tg_op = 'DELETE' then v_id := old.id; else v_id := new.id; end if;
  else
    if tg_op = 'DELETE' then v_id := old.expense_id; else v_id := new.expense_id; end if;
    if tg_op = 'UPDATE' and (new.expense_id <> old.expense_id or new.trip_id <> old.trip_id) then
      raise exception using errcode = '23514', message = 'split_parent_immutable';
    end if;
  end if;
  select amount_minor into v_total from app_private.expenses where id = v_id for update;
  if not found then return null; end if;
  select coalesce(sum(amount_minor),0),count(*) into v_sum,v_count
    from app_private.expense_splits where expense_id = v_id;
  if v_count = 0 or v_sum <> v_total then
    raise exception using errcode = '23514', message = 'split_total_mismatch';
  end if;
  return null;
end $$;
create constraint trigger expenses_total after insert or update on app_private.expenses
  deferrable initially deferred for each row execute function app_private.check_expense_total();
create constraint trigger splits_total after insert or update or delete on app_private.expense_splits
  deferrable initially deferred for each row execute function app_private.check_expense_total();

-- La sesión y el enlace se vuelven a comprobar para cada llamada. Los locks
-- compartidos serializan revocaciones con las transacciones en curso.
create function app_private.require_session(p_hash text) returns app_private.access_links
language plpgsql security definer set search_path = '' as $$
declare v_link app_private.access_links; v_session app_private.sessions;
begin
  select * into v_session from app_private.sessions where token_hash = p_hash for share;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= clock_timestamp() then
    raise exception using errcode = '28000', message = 'invalid_session';
  end if;
  select * into v_link from app_private.access_links where id = v_session.link_id for share;
  if not found or v_link.revoked_at is not null or v_link.version <> v_session.link_version
    or (v_link.expires_at is not null and v_link.expires_at <= clock_timestamp()) then
    raise exception using errcode = '28000', message = 'invalid_session';
  end if;
  if v_link.role = 'participant' then
    perform 1 from app_private.participants where id = v_link.participant_id and active for share;
    if not found then raise exception using errcode = '28000', message = 'invalid_session'; end if;
  end if;
  return v_link;
end $$;

create function app_private.expense_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id',e.id,'payerId',e.payer_id,'description',e.description,'spentOn',e.spent_on,
    'amountMinor',e.amount_minor::text,'currency',e.currency,'source',e.source,'state',e.state,'version',e.version,
    'splits',(select jsonb_agg(jsonb_build_object('participantId',s.participant_id,'amountMinor',s.amount_minor::text)
      order by s.participant_id) from app_private.expense_splits s where s.expense_id=e.id))
  from app_private.expenses e where e.id=p_id;
$$;

-- Una única entrada financiera: crea, edita o anula. La identidad no viene del payload.
create function app_api.mutate_expense(p_session_hash text,p_key uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor app_private.access_links; v_existing app_private.expenses;
  v_saved app_private.idempotency_keys; v_id uuid; v_payer uuid;
  v_op text; v_amount bigint; v_split jsonb; v_result jsonb;
  v_description text; v_date date; v_currency text; v_sum numeric := 0;
begin
  v_actor := app_private.require_session(p_session_hash);
  -- Serializa las mutaciones del único viaje, incluidos reintentos concurrentes.
  perform 1 from app_private.trip where id=v_actor.trip_id for update;
  if p_key is null or p_command is null or jsonb_typeof(p_command) <> 'object'
    or octet_length(p_command::text) > 65536 then
    raise exception using errcode='22023',message='invalid_command';
  end if;
  select * into v_saved from app_private.idempotency_keys
    where actor_link_id=v_actor.id and scope='expense' and key=p_key;
  if found then
    if v_saved.request <> p_command then raise exception using errcode='23505',message='idempotency_conflict'; end if;
    return v_saved.result;
  end if;
  v_op := p_command->>'operation';
  if v_op is null or v_op not in ('create','update','void') then
    raise exception using errcode='22023',message='invalid_command';
  end if;
  if exists (select 1 from jsonb_object_keys(p_command) as k(key)
    where key not in ('operation','id','expectedVersion','payerId','description','spentOn','amountMinor','currency','splits')) then
    raise exception using errcode='22023',message='invalid_command';
  end if;
  if v_op <> 'create' then
    v_id := (p_command->>'id')::uuid;
    select * into v_existing from app_private.expenses where id=v_id and trip_id=v_actor.trip_id for update;
    if not found or (v_actor.role <> 'admin' and v_existing.payer_id <> v_actor.participant_id) then
      raise exception using errcode='42501',message='expense_forbidden';
    end if;
    if jsonb_typeof(p_command->'expectedVersion') is distinct from 'number' or (p_command->>'expectedVersion') is null or (p_command->>'expectedVersion')::integer <> v_existing.version
      or v_existing.state <> 'active' then
      raise exception using errcode='40001',message='expense_version_conflict';
    end if;
  end if;
  if v_op = 'void' then
    if exists(select 1 from jsonb_object_keys(p_command) as k(key) where key not in ('operation','id','expectedVersion')) then
      raise exception using errcode='22023',message='invalid_command';
    end if;
    update app_private.expenses set state='voided',version=version+1,updated_by=v_actor.id,updated_at=clock_timestamp() where id=v_id;
  else
    if v_op = 'create' and (p_command ? 'id' or p_command ? 'expectedVersion') then
      raise exception using errcode='22023',message='invalid_command';
    end if;
    v_payer := (p_command->>'payerId')::uuid;
    if v_payer is null or (v_actor.role <> 'admin' and v_payer <> v_actor.participant_id) then
      raise exception using errcode='42501',message='expense_forbidden';
    end if;
    perform 1 from app_private.participants where id=v_payer and trip_id=v_actor.trip_id and active;
    if not found then raise exception using errcode='22023',message='invalid_payer'; end if;
    if jsonb_typeof(p_command->'amountMinor') is distinct from 'string'
      or (p_command->>'amountMinor') !~ '^[1-9][0-9]{0,13}$' then
      raise exception using errcode='22023',message='invalid_amount';
    end if;
    v_amount := (p_command->>'amountMinor')::bigint;
    v_description := p_command->>'description';
    v_currency := p_command->>'currency';
    if jsonb_typeof(p_command->'description') is distinct from 'string'
      or jsonb_typeof(p_command->'spentOn') is distinct from 'string'
      or jsonb_typeof(p_command->'currency') is distinct from 'string'
      or v_description is null or length(btrim(v_description)) not between 1 and 240
      or v_currency is null or v_currency not in ('PEN','USD')
      or (p_command->>'spentOn') is null or (p_command->>'spentOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode='22023',message='invalid_expense';
    end if;
    v_date := (p_command->>'spentOn')::date;
    if jsonb_typeof(p_command->'splits') is distinct from 'array' then
      raise exception using errcode='22023',message='invalid_splits';
    end if;
    if jsonb_array_length(p_command->'splits') not between 1 and 200 then
      raise exception using errcode='22023',message='invalid_splits';
    end if;
    for v_split in select value from jsonb_array_elements(p_command->'splits') loop
      if jsonb_typeof(v_split) <> 'object' or jsonb_typeof(v_split->'amountMinor') is distinct from 'string'
        or (v_split->>'amountMinor') !~ '^[1-9][0-9]{0,13}$'
        or (v_split->>'participantId') is null then
        raise exception using errcode='22023',message='invalid_splits';
      end if;
      if exists(select 1 from jsonb_object_keys(v_split) as k(key) where key not in ('participantId','amountMinor')) then
        raise exception using errcode='22023',message='invalid_splits';
      end if;
      perform 1 from app_private.participants where id=(v_split->>'participantId')::uuid and trip_id=v_actor.trip_id and active;
      if not found then raise exception using errcode='22023',message='invalid_beneficiary'; end if;
      v_sum := v_sum + (v_split->>'amountMinor')::bigint;
    end loop;
    if v_sum <> v_amount then raise exception using errcode='23514',message='split_total_mismatch'; end if;
    if v_op = 'create' then
      insert into app_private.expenses(trip_id,payer_id,description,spent_on,amount_minor,currency,created_by,updated_by)
        values(v_actor.trip_id,v_payer,v_description,v_date,v_amount,v_currency,v_actor.id,v_actor.id) returning id into v_id;
    else
      update app_private.expenses set payer_id=v_payer,description=v_description,spent_on=v_date,
        amount_minor=v_amount,currency=v_currency,version=version+1,updated_by=v_actor.id,updated_at=clock_timestamp() where id=v_id;
      delete from app_private.expense_splits where expense_id=v_id;
    end if;
    insert into app_private.expense_splits(trip_id,expense_id,participant_id,amount_minor)
      select v_actor.trip_id,v_id,(value->>'participantId')::uuid,(value->>'amountMinor')::bigint
      from jsonb_array_elements(p_command->'splits');
  end if;
  v_result := app_private.expense_json(v_id);
  insert into app_private.expense_revisions(expense_id,version,actor_link_id,snapshot)
    values(v_id,(v_result->>'version')::integer,v_actor.id,v_result);
  insert into app_private.audit_events(trip_id,actor_link_id,action,entity_id,entity_version)
    values(v_actor.trip_id,v_actor.id,'expense.' || v_op,v_id,(v_result->>'version')::integer);
  update app_private.trip set ledger_version=ledger_version+1 where id=v_actor.trip_id;
  insert into app_private.idempotency_keys(actor_link_id,scope,key,request,result)
    values(v_actor.id,'expense',p_key,p_command,v_result);
  return v_result;
end $$;

create function app_api.list_expenses(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor app_private.access_links; v_result jsonb;
begin
  v_actor := app_private.require_session(p_session_hash);
  select coalesce(jsonb_agg(app_private.expense_json(e.id) order by e.spent_on desc,e.id),'[]'::jsonb)
    into v_result from app_private.expenses e where e.trip_id=v_actor.trip_id and e.state='active';
  return v_result;
end $$;

-- Sin políticas públicas: denegación por defecto. Solo funciones autorizadas del BFF.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='app_private' loop
    execute format('alter table app_private.%I enable row level security',t.tablename);
  end loop;
end $$;
revoke all on all tables in schema app_private from public,cusco_bff;
revoke all on all functions in schema app_private,app_api from public,cusco_bff;
grant usage on schema app_api to cusco_bff;
grant execute on function app_api.mutate_expense(text,uuid,jsonb),app_api.list_expenses(text) to cusco_bff;
commit;
