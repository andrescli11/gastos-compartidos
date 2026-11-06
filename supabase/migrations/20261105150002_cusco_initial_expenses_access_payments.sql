-- Esquema fuente versionado; generar migración con Supabase CLI antes de desplegar.
-- Solo una base vacía de desarrollo. Nunca se ejecuta automáticamente al arrancar Next.js.
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
-- Fuente para aplicar después de schema.sql en una base efímera.
-- Generar migración con Supabase CLI y verificar antes de producción.
create table app_private.rate_limits (
  scope text not null check (scope in ('exchange','read','write','global_exchange','link_exchange')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null check (hits > 0 and hits <= 201),
  expires_at timestamptz not null,
  primary key (scope,key_hash)
);
create index rate_limits_expiry_idx on app_private.rate_limits(expires_at);
alter table app_private.rate_limits enable row level security;
create table app_private.access_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_link_id uuid not null references app_private.access_links(id),
  target_link_id uuid not null references app_private.access_links(id),
  action text not null check (action in ('session.exchange','session.logout','link.revoke')),
  created_at timestamptz not null default now()
);
create index access_audit_actor_idx on app_private.access_audit_events(actor_link_id);
create index access_audit_target_idx on app_private.access_audit_events(target_link_id);
alter table app_private.access_audit_events enable row level security;

-- Un único contador por sujeto/ámbito: UPSERT serializa cuotas concurrentes.
-- La llamada del BFF debe confirmar esta transacción ANTES del intento protegido:
-- una autenticación fallida no puede revertir el consumo de cuota preauth.
create function app_private.consume_quota(p_key_hash text,p_scope text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_now timestamptz; v_hits integer; v_hash text;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='invalid_quota_key';
  end if;
  v_limit := case p_scope when 'exchange' then 20 when 'read' then 120 when 'write' then 60
    when 'global_exchange' then 200 when 'link_exchange' then 10 else null end;
  if v_limit is null then raise exception using errcode='22023',message='invalid_quota_scope'; end if;
  -- El bucket global no se puede fragmentar pasando claves diferentes.
  v_hash := case when p_scope='global_exchange' then repeat('0',64) else p_key_hash end;
  -- Un intento usa la hora inicial de su sentencia. El UPSERT nunca hace
  -- retroceder la ventana si una petición anterior esperó a una posterior.
  v_now := statement_timestamp();
  insert into app_private.rate_limits(scope,key_hash,window_start,hits,expires_at)
    values(p_scope,v_hash,date_trunc('minute',v_now),1,v_now+interval '1 day')
  on conflict (scope,key_hash) do update set
    window_start=greatest(app_private.rate_limits.window_start,excluded.window_start),
    hits=case when app_private.rate_limits.window_start>=excluded.window_start
      then least(app_private.rate_limits.hits+1,v_limit+1) else 1 end,
    expires_at=greatest(app_private.rate_limits.expires_at,excluded.expires_at)
  returning hits into v_hits;
  return v_hits <= v_limit;
end $$;
create function app_api.consume_quota(p_key_hash text,p_scope text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_scope is null or p_scope not in ('exchange','read','write','global_exchange') then
    raise exception using errcode='22023',message='invalid_quota_scope';
  end if;
  return app_private.consume_quota(p_key_hash,p_scope);
end $$;

create function app_api.exchange_link(p_link_hash text,p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_link app_private.access_links; v_expires timestamptz;
begin
  if p_link_hash is null or p_session_hash is null or p_link_hash !~ '^[0-9a-f]{64}$'
    or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='28000',message='invalid_link';
  end if;
  select * into v_link from app_private.access_links where token_hash=p_link_hash for share;
  if not found or v_link.revoked_at is not null
    or (v_link.expires_at is not null and v_link.expires_at <= clock_timestamp()) then
    raise exception using errcode='28000',message='invalid_link';
  end if;
  if v_link.role='participant' then
    perform 1 from app_private.participants where id=v_link.participant_id and trip_id=v_link.trip_id and active for share;
    if not found then raise exception using errcode='28000',message='invalid_link'; end if;
  end if;
  if not app_private.consume_quota(p_link_hash,'link_exchange') then
    -- El error revierte este contador interno; queda saturado en 10 y seguirá
    -- denegando dentro de la ventana. Cuotas IP/global se confirman por separado.
    raise exception using errcode='P0001',message='rate_limited';
  end if;
  v_expires := least(clock_timestamp()+interval '8 hours',coalesce(v_link.expires_at,'infinity'::timestamptz));
  insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at)
    values(v_link.trip_id,v_link.id,p_session_hash,v_link.version,v_expires);
  insert into app_private.access_audit_events(actor_link_id,target_link_id,action)
    values(v_link.id,v_link.id,'session.exchange');
  return jsonb_build_object('expiresAt',v_expires);
end $$;

create function app_api.session_context(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor app_private.access_links; v_participants jsonb;
begin
  v_actor := app_private.require_session(p_session_hash);
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name) order by p.id),'[]'::jsonb)
    into v_participants from app_private.participants p where p.trip_id=v_actor.trip_id and p.active;
  return jsonb_build_object('role',v_actor.role,'participantId',v_actor.participant_id,'participants',v_participants);
end $$;

create function app_api.logout_session(p_session_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_link_id uuid;
begin
  -- Cierre idempotente incluso para una sesión expirada: solo afecta al hash
  -- de la cookie presentada. Ninguna identidad enviada en el payload decide actor.
  update app_private.sessions set revoked_at=clock_timestamp()
    where token_hash=p_session_hash and revoked_at is null returning link_id into v_link_id;
  if found then
    insert into app_private.access_audit_events(actor_link_id,target_link_id,action)
      values(v_link_id,v_link_id,'session.logout');
  end if;
  return true;
end $$;

create function app_api.revoke_link(p_session_hash text,p_link_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_actor app_private.access_links; v_target app_private.access_links;
begin
  v_actor := app_private.require_session(p_session_hash);
  if v_actor.role <> 'admin' then raise exception using errcode='42501',message='admin_required'; end if;
  -- Dos administradores que se revocan mutuamente no deben esperar cada uno
  -- con el lock compartido de su propio enlace. El segundo falla/reintenta.
  if not pg_try_advisory_xact_lock(146146,1) then
    raise exception using errcode='40001',message='revocation_conflict';
  end if;
  select * into v_target from app_private.access_links where id=p_link_id and trip_id=v_actor.trip_id for update;
  if not found then raise exception using errcode='42501',message='link_forbidden'; end if;
  if v_target.revoked_at is null then
    update app_private.access_links set revoked_at=clock_timestamp(),version=version+1 where id=v_target.id;
    -- require_session comprueba el enlace en CADA operación. No actualizar
    -- sessions aquí evita invertir el orden session->link de los locks existentes.
    insert into app_private.access_audit_events(actor_link_id,target_link_id,action)
      values(v_actor.id,v_target.id,'link.revoke');
  end if;
  return true;
end $$;

revoke all on app_private.rate_limits,app_private.access_audit_events from public,cusco_bff;
revoke all on function app_private.consume_quota(text,text),app_api.consume_quota(text,text),
  app_api.exchange_link(text,text),app_api.session_context(text),app_api.logout_session(text),
  app_api.revoke_link(text,uuid) from public,cusco_bff;
grant execute on function app_api.consume_quota(text,text),app_api.exchange_link(text,text),
  app_api.session_context(text),app_api.logout_session(text),app_api.revoke_link(text,uuid) to cusco_bff;
-- Fuente: aplicar después de schema.sql y access.sql, antes de habilitar el BFF.
-- Generar migración con CLI y validar en PostgreSQL efímero antes de desplegar.
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