\set ON_ERROR_STOP on
begin;
insert into app_private.participants(id,trip_id,display_name) values
('71000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Access fixture');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values
('72000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','participant',repeat('a',64)),
('72000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',null,'admin',repeat('b',64)),
('72000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',null,'admin',repeat('c',64));
do $$
declare v_result jsonb; v_rejected boolean; v_i integer;
begin
  set local role cusco_bff;
  v_result := app_api.exchange_link(repeat('a',64),repeat('1',64));
  assert (v_result->>'expiresAt')::timestamptz > now()+interval '7 hours';
  assert (v_result->>'expiresAt')::timestamptz <= clock_timestamp()+interval '8 hours';
  v_result := app_api.session_context(repeat('1',64));
  assert v_result->>'role'='participant';
  assert v_result->>'participantId'='71000000-0000-4000-8000-000000000001';
  assert jsonb_array_length(v_result->'participants')=1;
  assert v_result->'participants'->0->>'displayName'='Access fixture';
  v_rejected := false;
  begin perform app_api.revoke_link(repeat('1',64),'72000000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then v_rejected := true; end;
  assert v_rejected, 'participant cannot revoke links';
  assert app_api.logout_session(repeat('1',64));
  assert app_api.logout_session(repeat('1',64));
  v_rejected := false;
  begin perform app_api.session_context(repeat('1',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'logout invalidates immediately';
  v_rejected := false;
  begin perform app_api.exchange_link(repeat('f',64),repeat('2',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'unknown link';
  perform app_api.exchange_link(repeat('a',64),repeat('3',64));
  perform app_api.exchange_link(repeat('b',64),repeat('4',64));
  assert app_api.revoke_link(repeat('4',64),'72000000-0000-4000-8000-000000000001');
  assert app_api.revoke_link(repeat('4',64),'72000000-0000-4000-8000-000000000001');
  v_rejected := false;
  begin perform app_api.session_context(repeat('3',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'revoked link invalidates all existing sessions';
  v_rejected := false;
  begin perform app_api.exchange_link(repeat('a',64),repeat('5',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'revoked link cannot exchange';
  reset role;
  assert (select count(*) from app_private.access_audit_events where action='link.revoke')=1;
  assert (select count(*) from app_private.access_audit_events where action='session.logout')=1;
  update app_private.access_links set expires_at=now()+interval '30 minutes' where id='72000000-0000-4000-8000-000000000003';
  set local role cusco_bff;
  v_result := app_api.exchange_link(repeat('c',64),repeat('7',64));
  assert (v_result->>'expiresAt')::timestamptz <= now()+interval '30 minutes', 'session never outlives link';
  reset role;
  update app_private.access_links set expires_at=now()-interval '1 second' where id='72000000-0000-4000-8000-000000000003';
  set local role cusco_bff;
  v_rejected := false;
  begin perform app_api.exchange_link(repeat('c',64),repeat('6',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'expired link';
  v_rejected := false;
  begin perform app_api.consume_quota(repeat('d',64),'link_exchange');
  exception when invalid_parameter_value then v_rejected := true; end;
  assert v_rejected, 'private quota scope not exposed';
  -- Límite propio del enlace: una sesión ya fue creada para el admin b.
  for v_i in 1..9 loop
    perform app_api.exchange_link(repeat('b',64),lpad(to_hex(v_i),64,'0'));
  end loop;
  v_rejected := false;
  begin perform app_api.exchange_link(repeat('b',64),repeat('8',64));
  exception when raise_exception then
    v_rejected := (sqlerrm='rate_limited');
  end;
  assert v_rejected, 'link quota blocks excessive successful exchanges';
  reset role;
  update app_private.access_links set revoked_at=null where id='72000000-0000-4000-8000-000000000001';
  update app_private.participants set active=false where id='71000000-0000-4000-8000-000000000001';
  set local role cusco_bff;
  v_rejected := false;
  begin perform app_api.exchange_link(repeat('a',64),repeat('9',64));
  exception when invalid_authorization_specification then v_rejected := true; end;
  assert v_rejected, 'inactive participant cannot exchange';
  -- Ventana fijada durante esta prueba para no depender de un cambio de minuto.
  reset role;
  insert into app_private.rate_limits(scope,key_hash,window_start,hits,expires_at)
    values('exchange',repeat('d',64),date_trunc('minute',statement_timestamp()),20,now()+interval '1 day');
  set local role cusco_bff;
  assert not app_api.consume_quota(repeat('d',64),'exchange');
  reset role;
  update app_private.rate_limits set window_start=window_start-interval '2 minutes' where scope='exchange' and key_hash=repeat('d',64);
  set local role cusco_bff;
  assert app_api.consume_quota(repeat('d',64),'exchange');
  reset role;
  -- El global se conserva en el mismo bucket para todas las claves BFF.
  perform app_private.consume_quota(repeat('e',64),'global_exchange');
  perform app_private.consume_quota(repeat('f',64),'global_exchange');
  assert (select count(*) from app_private.rate_limits where scope='global_exchange')=1;
  assert (select key_hash from app_private.rate_limits where scope='global_exchange')=repeat('0',64);
  assert not has_table_privilege('cusco_bff','app_private.rate_limits','SELECT');
  assert not has_function_privilege('cusco_bff','app_private.consume_quota(text,text)','EXECUTE');
end $$;
create role cusco_access_untrusted nologin;
do $$ begin
  assert not has_schema_privilege('cusco_access_untrusted','app_private','USAGE');
  assert not has_function_privilege('cusco_access_untrusted','app_api.exchange_link(text,text)','EXECUTE');
  assert not has_function_privilege('cusco_access_untrusted','app_api.session_context(text)','EXECUTE');
  assert not has_function_privilege('cusco_access_untrusted','app_api.revoke_link(text,uuid)','EXECUTE');
end $$;
rollback;
\echo 'OK: link exchange, session context/logout, revocation and persistent quotas'
