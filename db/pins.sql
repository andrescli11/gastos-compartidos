-- PIN authentication is an explicitly selected low-friction access policy.
-- No failed-attempt counter, quota or temporary lock is created by this migration.
begin;
create table app_private.pin_credentials (
 link_id uuid primary key references app_private.access_links(id),
 verifier text not null check(verifier ~ '^scrypt1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$'),
 version integer not null default 1 check(version>0),
 enabled boolean not null default true,
 updated_at timestamptz not null default clock_timestamp()
);
alter table app_private.pin_credentials enable row level security;
create table app_private.pin_audit_events (
 id uuid primary key default gen_random_uuid(),
 actor_link_id uuid not null references app_private.access_links(id),
 target_link_id uuid not null references app_private.access_links(id),
 action text not null check(action in ('pin.set','pin.disable','pin.login')),
 created_at timestamptz not null default clock_timestamp()
);
create index pin_audit_actor_idx on app_private.pin_audit_events(actor_link_id);
create index pin_audit_target_idx on app_private.pin_audit_events(target_link_id);
alter table app_private.pin_audit_events enable row level security;

create function app_api.pin_users() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'displayName',case when l.role='admin' then 'Administrador' else p.display_name end,'role',l.role) order by l.role desc,p.display_name,l.id),'[]'::jsonb)
 from app_private.access_links l join app_private.pin_credentials c on c.link_id=l.id
 left join app_private.participants p on p.id=l.participant_id and p.trip_id=l.trip_id
 where c.enabled and l.revoked_at is null and (l.expires_at is null or l.expires_at>clock_timestamp()) and (l.role='admin' or p.active);
$$;
-- Verifiers never leave the BFF. No public/anon/authenticated or direct table grants.
create function app_api.pin_verifier(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare l app_private.access_links; c app_private.pin_credentials;
begin
 select * into l from app_private.access_links where id=p_id;
 if not found or l.revoked_at is not null or (l.expires_at is not null and l.expires_at<=clock_timestamp()) then return null; end if;
 if l.role='participant' and not exists(select 1 from app_private.participants where id=l.participant_id and trip_id=l.trip_id and active) then return null; end if;
 select * into c from app_private.pin_credentials where link_id=p_id and enabled;
 if not found then return null; end if;
 return jsonb_build_object('verifier',c.verifier,'version',c.version,'linkVersion',l.version);
end $$;
create function app_api.exchange_pin(p_id uuid,p_version integer,p_link_version integer,p_verifier text,p_session_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l app_private.access_links; c app_private.pin_credentials; expiry timestamptz;
begin
 if p_version is null or p_version<1 or p_link_version is null or p_link_version<1 or p_verifier is null or p_verifier !~ '^scrypt1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='28000',message='invalid_pin'; end if;
 select * into l from app_private.access_links where id=p_id for share;
 if not found or l.revoked_at is not null or l.version<>p_link_version or (l.expires_at is not null and l.expires_at<=clock_timestamp()) then raise exception using errcode='28000',message='invalid_pin'; end if;
 if l.role='participant' then
  perform 1 from app_private.participants where id=l.participant_id and trip_id=l.trip_id and active for share;
  if not found then raise exception using errcode='28000',message='invalid_pin'; end if;
 end if;
 select * into c from app_private.pin_credentials where link_id=p_id for share;
 if not found or not c.enabled or c.version<>p_version or c.verifier is distinct from p_verifier then raise exception using errcode='28000',message='invalid_pin'; end if;
 expiry:=least(clock_timestamp()+interval '8 hours',coalesce(l.expires_at,'infinity'::timestamptz));
 insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values(l.trip_id,l.id,p_session_hash,l.version,expiry);
 insert into app_private.pin_audit_events(actor_link_id,target_link_id,action) values(l.id,l.id,'pin.login');
 return jsonb_build_object('expiresAt',expiry);
end $$;
create function app_api.list_pin_users(p_session_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor app_private.access_links; result jsonb;
begin
 actor:=app_private.require_session(p_session_hash);
 if actor.role<>'admin' then raise exception using errcode='42501',message='admin_required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'displayName',case when l.role='admin' then 'Administrador' else p.display_name end,'role',l.role,'version',coalesce(c.version,0),'pinEnabled',coalesce(c.enabled,false),'hasPin',c.link_id is not null,'own',l.id=actor.id) order by l.role desc,p.display_name,l.id),'[]'::jsonb)
 into result from app_private.access_links l left join app_private.pin_credentials c on c.link_id=l.id left join app_private.participants p on p.id=l.participant_id and p.trip_id=l.trip_id
 where l.trip_id=actor.trip_id and l.revoked_at is null and (l.expires_at is null or l.expires_at>clock_timestamp()) and (l.role='admin' or p.active);
 return result;
end $$;
create function app_api.manage_pin(p_session_hash text,p_key uuid,p_id uuid,p_expected integer,p_operation text,p_verifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor app_private.access_links; target app_private.access_links; credential app_private.pin_credentials; saved app_private.idempotency_keys; command jsonb; result jsonb;
begin
 actor:=app_private.require_session(p_session_hash);
 if actor.role<>'admin' then raise exception using errcode='42501',message='admin_required'; end if;
 if not pg_try_advisory_xact_lock(146146,1) then raise exception using errcode='40001',message='pin_version_conflict'; end if;
 if p_key is null or p_id is null or p_expected is null or p_expected<0 or p_operation is null or p_operation not in ('set','disable') then raise exception using errcode='22023',message='invalid_pin_command'; end if;
 if p_operation='set' and (p_verifier is null or p_verifier !~ '^scrypt1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$') then raise exception using errcode='22023',message='invalid_pin_verifier'; end if;
 if p_operation='disable' and p_verifier is not null then raise exception using errcode='22023',message='invalid_pin_command'; end if;
 command:=jsonb_build_object('id',p_id,'expectedVersion',p_expected,'operation',p_operation,'verifier',p_verifier);
 select * into saved from app_private.idempotency_keys where actor_link_id=actor.id and scope='pin' and key=p_key;
 if found then
  if saved.request<>command then raise exception using errcode='23505',message='idempotency_conflict'; end if;
  return saved.result;
 end if;
 select * into target from app_private.access_links where id=p_id and trip_id=actor.trip_id for update;
 if not found or target.revoked_at is not null or (target.expires_at is not null and target.expires_at<=clock_timestamp()) then raise exception using errcode='42501',message='pin_forbidden'; end if;
 if target.role='participant' and not exists(select 1 from app_private.participants where id=target.participant_id and trip_id=target.trip_id and active) then raise exception using errcode='42501',message='pin_forbidden'; end if;
 select * into credential from app_private.pin_credentials where link_id=p_id for update;
 if coalesce(credential.version,0)<>p_expected or p_expected=2147483647 or target.version=2147483647 then raise exception using errcode='40001',message='pin_version_conflict'; end if;
 if p_operation='disable' and credential.link_id is null then raise exception using errcode='22023',message='pin_not_configured'; end if;
 if p_operation='set' then
  insert into app_private.pin_credentials(link_id,verifier,version,enabled) values(p_id,p_verifier,1,true)
   on conflict(link_id) do update set verifier=excluded.verifier,version=app_private.pin_credentials.version+1,enabled=true,updated_at=clock_timestamp();
 else update app_private.pin_credentials set enabled=false,version=version+1,updated_at=clock_timestamp() where link_id=p_id;
 end if;
 -- Invalidates existing sessions without inverting require_session's session→link lock order.
 update app_private.access_links set version=version+1 where id=p_id;
 insert into app_private.pin_audit_events(actor_link_id,target_link_id,action) values(actor.id,p_id,case when p_operation='set' then 'pin.set' else 'pin.disable' end);
 result:=jsonb_build_object('ok',true,'ownSessionRevoked',actor.id=p_id);
 insert into app_private.idempotency_keys(actor_link_id,scope,key,request,result) values(actor.id,'pin',p_key,command,result);
 return result;
end $$;
revoke all on app_private.pin_credentials,app_private.pin_audit_events from public,cusco_bff;
revoke all on function app_api.pin_users(),app_api.pin_verifier(uuid),app_api.exchange_pin(uuid,integer,integer,text,text),app_api.list_pin_users(text),app_api.manage_pin(text,uuid,uuid,integer,text,text) from public,cusco_bff;
grant execute on function app_api.pin_users(),app_api.pin_verifier(uuid),app_api.exchange_pin(uuid,integer,integer,text,text),app_api.list_pin_users(text),app_api.manage_pin(text,uuid,uuid,integer,text,text) to cusco_bff;
commit;
