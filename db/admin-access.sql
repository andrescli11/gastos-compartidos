-- Administración de enlaces sin exponer hashes ni permitir autorrotación.
begin;
create function app_api.list_access_links(p_session_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a app_private.access_links; r jsonb;
begin
 a:=app_private.require_session(p_session_hash);
 if a.role<>'admin' then raise exception using errcode='42501',message='admin_required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'role',l.role,'displayName',coalesce(p.display_name,'Administrador'),'version',l.version,'revoked',l.revoked_at is not null,'expired',l.expires_at is not null and l.expires_at<=clock_timestamp(),'own',l.id=a.id) order by l.created_at,l.id),'[]'::jsonb) into r
 from app_private.access_links l left join app_private.participants p on p.id=l.participant_id where l.trip_id=a.trip_id;
 return r;
end $$;
create function app_api.rotate_access_link(p_session_hash text,p_key uuid,p_id uuid,p_version integer,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a app_private.access_links; t app_private.access_links; prior app_private.idempotency_keys; req jsonb; r jsonb; new_id uuid;
begin
 a:=app_private.require_session(p_session_hash);
 if a.role<>'admin' or p_id=a.id then raise exception using errcode='42501',message='rotation_forbidden'; end if;
 if p_key is null or p_version is null or p_version<1 or p_hash is null or p_hash!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='invalid_rotation'; end if;
 if not pg_try_advisory_xact_lock(146146,1) then raise exception using errcode='40001',message='rotation_conflict'; end if;
 req:=jsonb_build_object('id',p_id,'version',p_version,'hash',p_hash);
 select * into prior from app_private.idempotency_keys where actor_link_id=a.id and scope='access.rotate' and key=p_key;
 if found then
  if prior.request<>req then raise exception using errcode='40001',message='idempotency_conflict'; end if;
  -- Nunca volver a entregar un enlace que otro administrador ya revocó.
  if not exists(select 1 from app_private.access_links where id=(prior.result->>'id')::uuid and revoked_at is null and (expires_at is null or expires_at>clock_timestamp())) then raise exception using errcode='40001',message='rotated_link_revoked'; end if;
  return prior.result;
 end if;
 select * into t from app_private.access_links where id=p_id and trip_id=a.trip_id for update;
 if not found then raise exception using errcode='42501',message='link_forbidden'; end if;
 if t.version<>p_version then raise exception using errcode='40001',message='version_conflict'; end if;
 if t.version=2147483647 then raise exception using errcode='40001',message='version_limit'; end if;
 if t.revoked_at is null then
  update app_private.access_links set revoked_at=clock_timestamp(),version=version+1 where id=t.id;
  insert into app_private.access_audit_events(actor_link_id,target_link_id,action) values(a.id,t.id,'link.revoke');
 end if;
 insert into app_private.access_links(trip_id,participant_id,role,token_hash) values(t.trip_id,t.participant_id,t.role,p_hash) returning id into new_id;
 r:=jsonb_build_object('id',new_id,'version',1);
 insert into app_private.idempotency_keys(actor_link_id,scope,key,request,result) values(a.id,'access.rotate',p_key,req,r);
 return r;
end $$;
revoke all on function app_api.list_access_links(text),app_api.rotate_access_link(text,uuid,uuid,integer,text) from public;
grant execute on function app_api.list_access_links(text),app_api.rotate_access_link(text,uuid,uuid,integer,text) to cusco_bff;
commit;
