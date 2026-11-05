begin;
do $$
declare trip uuid; p uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); k uuid:=gen_random_uuid(); r jsonb; again jsonb;
begin
 select id into trip from app_private.trip;
 insert into app_private.participants(id,trip_id,display_name) values(p,trip,'Disposable access fixture');
 insert into app_private.access_links(id,trip_id,role,token_hash) values(a,trip,'admin',repeat('a',64));
 insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values(l,trip,p,'participant',repeat('b',64));
 insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values(trip,a,repeat('c',64),1,now()+interval '1 hour'),(trip,l,repeat('d',64),1,now()+interval '1 hour');
 if jsonb_array_length(app_api.list_access_links(repeat('c',64)))<2 then raise exception 'admin list missing'; end if;
 begin perform app_api.list_access_links(repeat('d',64)); raise exception 'participant listed links'; exception when insufficient_privilege then null; end;
 begin perform app_api.rotate_access_link(repeat('c',64),k,a,1,repeat('e',64)); raise exception 'self rotation allowed'; exception when insufficient_privilege then null; end;
 r:=app_api.rotate_access_link(repeat('c',64),k,l,1,repeat('e',64));
 again:=app_api.rotate_access_link(repeat('c',64),k,l,1,repeat('e',64));
 if r<>again then raise exception 'rotation replay changed result'; end if;
 if not exists(select 1 from app_private.access_links where id=l and revoked_at is not null) then raise exception 'old link active'; end if;
 begin perform app_api.session_context(repeat('d',64)); raise exception 'old session survived'; exception when invalid_authorization_specification then null; end;
 begin perform app_api.rotate_access_link(repeat('c',64),k,l,1,repeat('f',64)); raise exception 'changed replay allowed'; exception when serialization_failure then null; end;
 perform app_api.revoke_link(repeat('c',64),(r->>'id')::uuid);
 begin perform app_api.rotate_access_link(repeat('c',64),k,l,1,repeat('e',64)); raise exception 'revoked result replay exposed'; exception when serialization_failure then null; end;
 if has_function_privilege('anon','app_api.list_access_links(text)','execute') then raise exception 'anon function permission'; end if;
 if not has_function_privilege('cusco_bff','app_api.rotate_access_link(text,uuid,uuid,integer,text)','execute') then raise exception 'bff permission absent'; end if;
end $$;
rollback;
