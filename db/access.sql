-- Fuente para aplicar después de schema.sql en una base efímera.
-- Generar migración con Supabase CLI y verificar antes de producción.
begin;
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
commit;
