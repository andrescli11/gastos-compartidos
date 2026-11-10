\set ON_ERROR_STOP on
-- Guarded disposable CI runner only; synthetic credentials never leave this transaction.
begin;
insert into app_private.participants(id,trip_id,display_name) values
 ('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','PIN participant');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
 ('f2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001','participant',repeat('a',64)),
 ('f2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',null,'admin',repeat('b',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values
 ('00000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001',repeat('a',64),1,now()+interval '1 hour'),
 ('00000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002',repeat('b',64),1,now()+interval '1 hour');
do $$
declare
 participant uuid:='f2000000-0000-4000-8000-000000000001'; admin uuid:='f2000000-0000-4000-8000-000000000002';
 first_hash text:='scrypt1$'||repeat('A',22)||'$'||repeat('A',86);
 second_hash text:='scrypt1$'||repeat('B',22)||'$'||repeat('C',86);
 key uuid:=gen_random_uuid(); state jsonb; previous jsonb; verifier jsonb; failed boolean; link_v integer;
begin
 set local role cusco_bff;
 assert jsonb_array_length(app_api.pin_users())=0,'unconfigured PINs do not appear publicly';
 failed:=false;
 begin perform app_api.list_pin_users(repeat('a',64)); exception when insufficient_privilege then failed:=true; end;
 assert failed,'participants cannot administer PINs';
 failed:=false;
 begin perform app_api.manage_pin(repeat('a',64),key,participant,0,'set',first_hash); exception when insufficient_privilege then failed:=true; end;
 assert failed,'participants cannot replace another PIN or their own PIN';
 state:=app_api.manage_pin(repeat('b',64),key,participant,0,'set',first_hash);
 assert state->>'ownSessionRevoked'='false';
 assert app_api.manage_pin(repeat('b',64),key,participant,0,'set',first_hash)=state,'same management key replays without another version increment';
 state:=app_api.pin_users();
 assert jsonb_array_length(state)=1 and not(state->0 ? 'verifier'),'directory never exposes a verifier';
 failed:=false;
 begin perform app_api.session_context(repeat('a',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'PIN change revokes sessions through link version';
 verifier:=app_api.pin_verifier(participant);
 assert verifier->>'version'='1' and verifier->>'linkVersion'='2';
 failed:=false;
 begin perform app_api.exchange_pin(participant,1,2,null,repeat('c',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'null verifier is rejected';
 failed:=false;
 begin perform app_api.exchange_pin(participant,null,2,first_hash,repeat('c',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'null credential version is rejected';
 failed:=false;
 begin perform app_api.exchange_pin(participant,1,null,first_hash,repeat('c',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'null link version is rejected';
 failed:=false;
 begin perform app_api.exchange_pin(participant,1,2,second_hash,repeat('c',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'wrong verifier is rejected';
 state:=app_api.exchange_pin(participant,1,2,first_hash,repeat('c',64));
 assert state ? 'expiresAt';
 state:=app_api.session_context(repeat('c',64));
 assert state->>'role'='participant' and state->>'participantId'='f1000000-0000-4000-8000-000000000001';
 -- The legacy URL remains valid after a PIN change, but its old sessions do not.
 state:=app_api.exchange_link(repeat('a',64),repeat('d',64));
 assert app_api.session_context(repeat('d',64))->>'role'='participant';
 previous:=app_api.pin_verifier(participant);
 perform app_api.manage_pin(repeat('b',64),gen_random_uuid(),participant,1,'set',second_hash);
 failed:=false;
 begin perform app_api.exchange_pin(participant,1,2,first_hash,repeat('e',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'a verification from before reset cannot mint a session after reset';
 failed:=false;
 begin perform app_api.session_context(repeat('c',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'all existing sessions are invalidated';
 failed:=false;
 begin perform app_api.manage_pin(repeat('b',64),gen_random_uuid(),participant,1,'disable',null); exception when serialization_failure then failed:=true; end;
 assert failed,'stale admin version cannot overwrite newer PIN';
 perform app_api.manage_pin(repeat('b',64),gen_random_uuid(),participant,2,'disable',null);
 assert app_api.pin_verifier(participant) is null and jsonb_array_length(app_api.pin_users())=0;
 state:=app_api.list_pin_users(repeat('b',64));
 assert (select count(*) from jsonb_array_elements(state) user_row where user_row->>'id'=participant::text and user_row->>'pinEnabled'='false')=1;
 -- Own admin PIN setup invalidates the administering session, but can log back in with new PIN.
 state:=app_api.manage_pin(repeat('b',64),gen_random_uuid(),admin,0,'set',first_hash);
 assert state->>'ownSessionRevoked'='true';
 failed:=false;
 begin perform app_api.list_pin_users(repeat('b',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed;
 perform app_api.exchange_pin(admin,1,2,first_hash,repeat('f',64));
 assert app_api.session_context(repeat('f',64))->>'role'='admin';
 perform app_api.manage_pin(repeat('f',64),gen_random_uuid(),participant,3,'set',second_hash);
 reset role;
 update app_private.access_links set expires_at=clock_timestamp()-interval '1 minute' where id=participant;
 set local role cusco_bff;
 assert app_api.pin_verifier(participant) is null;
 assert not exists(select 1 from jsonb_array_elements(app_api.pin_users()) item where item->>'id'=participant::text),'expired account hidden';
 failed:=false;
 begin perform app_api.exchange_pin(participant,4,5,second_hash,repeat('1',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'expired account cannot create session';
 reset role;
 update app_private.access_links set expires_at=null,revoked_at=clock_timestamp() where id=participant;
 set local role cusco_bff;
 assert app_api.pin_verifier(participant) is null;
 assert not exists(select 1 from jsonb_array_elements(app_api.pin_users()) item where item->>'id'=participant::text),'revoked account hidden';
 failed:=false;
 begin perform app_api.exchange_pin(participant,4,5,second_hash,repeat('1',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'revoked account cannot create session';
 reset role;
 update app_private.access_links set revoked_at=null where id=participant;
 update app_private.participants set active=false where id='f1000000-0000-4000-8000-000000000001';
 set local role cusco_bff;
 assert app_api.pin_verifier(participant) is null;
 assert not exists(select 1 from jsonb_array_elements(app_api.pin_users()) item where item->>'id'=participant::text),'inactive participant hidden';
 failed:=false;
 begin perform app_api.exchange_pin(participant,4,5,second_hash,repeat('1',64)); exception when invalid_authorization_specification then failed:=true; end;
 assert failed,'inactive participant cannot create session';
 reset role;
 assert not has_table_privilege('cusco_bff','app_private.pin_credentials','SELECT');
 assert not has_table_privilege('cusco_bff','app_private.pin_credentials','UPDATE');
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app_api.pin_users()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');
 assert (select count(*) from app_private.pin_audit_events where target_link_id=participant and action='pin.set')=3,'idempotent retry does not duplicate audit';
 assert not exists(select 1 from app_private.rate_limits where scope like '%pin%'),'no PIN attempt counter or lockout';
end $$;
rollback;
