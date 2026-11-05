-- Private, recoverable import previews. No original file uploads or public grants.
begin;
alter table app_private.trip add column start_date date, add column end_date date,
 add constraint trip_dates_complete check ((start_date is null and end_date is null) or (start_date is not null and end_date is not null and start_date<=end_date));
create table app_private.import_jobs (
 id uuid primary key default gen_random_uuid(),
 trip_id uuid not null references app_private.trip(id),
 owner_participant_id uuid references app_private.participants(id),
 created_by_link_id uuid not null references app_private.access_links(id),
 version integer not null default 1 check(version > 0),
 state text not null default 'preview' check(state in ('preview','persisted','cancelled','expired')),
 source_type text not null check(source_type in ('manual','csv','excel')),
 rows jsonb not null check(jsonb_typeof(rows)='array' and jsonb_array_length(rows)<=200),
 results jsonb not null default '[]' check(jsonb_typeof(results)='array'),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '7 days'
);
create index import_jobs_owner_idx on app_private.import_jobs(trip_id,owner_participant_id,created_at);
create index import_jobs_expiry_idx on app_private.import_jobs(expires_at);
create table app_private.import_commands (
 actor_link_id uuid not null references app_private.access_links(id),
 key uuid not null,
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 job_id uuid not null references app_private.import_jobs(id),
 result jsonb not null,
 expires_at timestamptz not null,
 primary key(actor_link_id,key)
);
create table app_private.import_saved_rows (
 job_id uuid not null references app_private.import_jobs(id),
 row_id uuid not null,
 expense_id uuid not null unique references app_private.expenses(id),
 preview_version integer not null check(preview_version>0),
 source_row integer not null,
 source_sheet text not null default '' check(length(source_sheet)<=120),
 saved_at timestamptz not null default clock_timestamp(),
 primary key(job_id,row_id)
);
alter table app_private.import_saved_rows enable row level security;
revoke all on app_private.import_saved_rows from public,cusco_bff;
alter table app_private.import_jobs enable row level security;
alter table app_private.import_commands enable row level security;
revoke all on app_private.import_jobs,app_private.import_commands from public,cusco_bff;

create function app_private.expire_imports() returns void
language plpgsql security definer set search_path='' as $$
begin
 update app_private.import_jobs set state='expired',rows='[]',results='[]',version=version+1
 where expires_at<=clock_timestamp() and state<>'expired';
 delete from app_private.import_commands where expires_at<=clock_timestamp();
end $$;

create function app_private.import_duplicates(p_trip uuid,p_row jsonb) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(e.id order by e.id),'[]'::jsonb)
 from app_private.expenses e where e.trip_id=p_trip and e.state='active'
 and e.amount_minor::text=p_row->>'amountMinor' and e.currency=p_row->>'currency'
 and e.spent_on::text=p_row->>'spentOn';
$$;

create function app_private.import_rows(p_rows jsonb,p_old jsonb default '[]') returns jsonb
language plpgsql set search_path='' as $$
declare r jsonb; old jsonb; output jsonb:='[]'; ids uuid[]:='{}'; rid uuid; warning jsonb;
begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>200 or octet_length(p_rows::text)>1048576 then
  raise exception using errcode='22023',message='invalid_import_rows'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(r) is distinct from 'object' or exists(select 1 from jsonb_object_keys(r) k where k not in
   ('id','description','spentOn','amountMinor','currency','payerId','splits','selected','reviewed','keepBoth','evidence','sourceRow','sourceSheet','warnings','duplicateExpenseIds')) then
   raise exception using errcode='22023',message='invalid_import_row'; end if;
  rid:=(r->>'id')::uuid;
  if rid is null or rid=any(ids) then raise exception using errcode='22023',message='duplicate_import_row'; end if;
  ids:=array_append(ids,rid);
  if jsonb_typeof(r->'description') is distinct from 'string' or length(r->>'description')>240
   or jsonb_typeof(r->'spentOn') is distinct from 'string' or length(r->>'spentOn')>10
   or jsonb_typeof(r->'amountMinor') is distinct from 'string' or length(r->>'amountMinor')>20
   or jsonb_typeof(r->'currency') is distinct from 'string' or r->>'currency' not in ('','PEN','USD')
   or jsonb_typeof(r->'payerId') is distinct from 'string' or length(r->>'payerId')>36
   or jsonb_typeof(r->'splits') is distinct from 'array' or jsonb_array_length(r->'splits')>200
   or jsonb_typeof(r->'selected') is distinct from 'boolean' or jsonb_typeof(r->'reviewed') is distinct from 'boolean'
   or jsonb_typeof(r->'keepBoth') is distinct from 'boolean' then
   raise exception using errcode='22023',message='invalid_import_row'; end if;
  if exists(select 1 from jsonb_array_elements(r->'splits') s where jsonb_typeof(s) is distinct from 'object'
    or jsonb_typeof(s->'participantId') is distinct from 'string' or length(s->>'participantId')>36
    or jsonb_typeof(s->'amountMinor') is distinct from 'string' or length(s->>'amountMinor')>20
    or exists(select 1 from jsonb_object_keys(s) k where k not in ('participantId','amountMinor'))) then
   raise exception using errcode='22023',message='invalid_import_split'; end if;
  select value into old from jsonb_array_elements(p_old) where (value->>'id')::uuid=rid;
  if old is null then
   if jsonb_typeof(r->'evidence') is distinct from 'string' or length(r->>'evidence')>2000
    or jsonb_typeof(r->'sourceRow') is distinct from 'number' or r->>'sourceRow' !~ '^[1-9][0-9]{0,6}$'
    or (r ? 'sourceSheet' and (jsonb_typeof(r->'sourceSheet') is distinct from 'string' or length(r->>'sourceSheet')>120)) then
    raise exception using errcode='22023',message='invalid_import_evidence'; end if;
   warning:=case when r->>'evidence' ~ '(^|[\t\n\r])[[:space:]]*[=+@-]' then '["FORMULA_LIKE_CONTENT"]'::jsonb else '[]'::jsonb end;
   if jsonb_typeof(r->'warnings')='array' and r->'warnings' ? 'FORMULA_LIKE_CONTENT' and not (warning ? 'FORMULA_LIKE_CONTENT') then warning:=warning||'"FORMULA_LIKE_CONTENT"'::jsonb; end if;
   if jsonb_typeof(r->'warnings')='array' and r->'warnings' ? 'INCONSISTENT_TOTALS' then warning:=warning||'"INCONSISTENT_TOTALS"'::jsonb; end if;
   if jsonb_typeof(r->'warnings')='array' and r->'warnings' ? 'NON_EXPENSE_MOVEMENT' then warning:=warning||'"NON_EXPENSE_MOVEMENT"'::jsonb; end if;
   old:=jsonb_build_object('evidence',r->'evidence','sourceRow',r->'sourceRow','sourceSheet',coalesce(r->'sourceSheet','""'),'warnings',warning);
  end if;
  r:=r||jsonb_build_object('id',rid,'evidence',old->'evidence','sourceRow',old->'sourceRow','sourceSheet',old->'sourceSheet','warnings',old->'warnings','duplicateExpenseIds',case when jsonb_typeof(r->'duplicateExpenseIds')='array' then r->'duplicateExpenseIds' else '[]'::jsonb end);
  output:=output||jsonb_build_array(r);
 end loop;
 return output;
end $$;

-- A review acknowledges the duplicate set actually shown, not future ledger changes.
create function app_private.refresh_import_review(p_trip uuid,p_rows jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare r jsonb; duplicates jsonb; output jsonb:='[]'; dates app_private.trip; warning jsonb; before_warning jsonb;
begin
 select * into dates from app_private.trip where id=p_trip;
 for r in select value from jsonb_array_elements(p_rows) loop
  before_warning:=r->'warnings';
  warning:=coalesce((select jsonb_agg(value) from jsonb_array_elements(r->'warnings') where value not in ('"TRIP_DATES_UNKNOWN"'::jsonb,'"OUTSIDE_TRIP_DATES"'::jsonb)),'[]'::jsonb);
  if dates.start_date is null then warning:=warning||'"TRIP_DATES_UNKNOWN"'::jsonb;
  elsif r->>'spentOn'<>'' and ((r->>'spentOn')<dates.start_date::text or (r->>'spentOn')>dates.end_date::text) then warning:=warning||'"OUTSIDE_TRIP_DATES"'::jsonb; end if;
  if not (r->'warnings' @> warning and warning @> r->'warnings') then r:=r||'{"reviewed":false}'::jsonb; end if;
  r:=r||jsonb_build_object('warnings',warning);
  duplicates:=app_private.import_duplicates(p_trip,r);
  if r->'duplicateExpenseIds' is distinct from duplicates then
   r:=r||'{"reviewed":false,"keepBoth":false}'::jsonb;
  end if;
  r:=r||jsonb_build_object('duplicateExpenseIds',duplicates);
  if (r->>'selected')::boolean and exists(select 1 from jsonb_array_elements(p_rows) other
    where other->>'id'<>r->>'id' and (other->>'selected')::boolean
    and other->>'amountMinor'=r->>'amountMinor' and other->>'currency'=r->>'currency' and other->>'spentOn'=r->>'spentOn') then
   if not (r->'warnings' ? 'DUPLICATE_IN_BATCH') then
    r:=r||jsonb_build_object('warnings',(r->'warnings')||'"DUPLICATE_IN_BATCH"'::jsonb);
   end if;
  else
   r:=r||jsonb_build_object('warnings',coalesce((select jsonb_agg(value) from jsonb_array_elements(r->'warnings') where value<>'"DUPLICATE_IN_BATCH"'::jsonb),'[]'::jsonb));
  end if;
  if not (before_warning @> r->'warnings' and r->'warnings' @> before_warning) then r:=r||'{"reviewed":false}'::jsonb; end if;
  output:=output||jsonb_build_array(r);
 end loop;
 return output;
end $$;

create function app_private.import_json(p_id uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare j app_private.import_jobs; rs jsonb;
begin
 select * into j from app_private.import_jobs where id=p_id;
 if not found then return null; end if;
 select coalesce(jsonb_agg(r.value||jsonb_build_object('duplicateExpenseIds',case
   when exists(select 1 from jsonb_array_elements(j.results) x where x->>'rowId'=r.value->>'id' and x->>'status'='persisted') then '[]'::jsonb
   else app_private.import_duplicates(j.trip_id,r.value) end) order by r.ordinality),'[]'::jsonb)
 into rs from jsonb_array_elements(app_private.refresh_import_review(j.trip_id,j.rows)) with ordinality r(value,ordinality);
 return jsonb_build_object('id',j.id,'version',j.version,'state',j.state,'sourceType',j.source_type,'createdAt',j.created_at,'expiresAt',j.expires_at,'tripDates',(select case when t.start_date is null then null else jsonb_build_object('start',t.start_date,'end',t.end_date) end from app_private.trip t where t.id=j.trip_id),'rows',rs,'results',j.results);
end $$;

create function app_api.list_imports(p_session_hash text,p_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a app_private.access_links; j app_private.import_jobs; result jsonb;
begin
 a:=app_private.require_session(p_session_hash);
 perform app_private.expire_imports();
 if p_id is not null then
  select * into j from app_private.import_jobs where id=p_id and trip_id=a.trip_id;
  if not found or (a.role<>'admin' and j.owner_participant_id is distinct from a.participant_id) then raise exception using errcode='42501',message='import_forbidden'; end if;
  return jsonb_build_object('job',app_private.import_json(j.id));
 end if;
 select coalesce(jsonb_agg((app_private.import_json(t.id)||jsonb_build_object('rows','[]'::jsonb,'results','[]'::jsonb)) order by t.created_at desc),'[]'::jsonb) into result
 from (select id,created_at from app_private.import_jobs where trip_id=a.trip_id
 and (a.role='admin' or owner_participant_id=a.participant_id) and state in ('preview','persisted') order by created_at desc limit 50) t;
 return jsonb_build_object('jobs',result);
end $$;

create function app_api.mutate_import(p_session_hash text,p_key uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 a app_private.access_links; j app_private.import_jobs; saved app_private.import_commands;
 op text; fingerprint text; rows_value jsonb; r jsonb; expense jsonb; cmd jsonb; result jsonb; receipt jsonb;
 results_value jsonb; count_selected integer:=0; row_key uuid;
begin
 a:=app_private.require_session(p_session_hash);
 perform 1 from app_private.trip where id=a.trip_id for update;
 perform app_private.expire_imports();
 if p_key is null or jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>1048576 then
  raise exception using errcode='22023',message='invalid_import_command'; end if;
 fingerprint:=encode(sha256(convert_to(p_command::text,'UTF8')),'hex');
 select * into saved from app_private.import_commands where actor_link_id=a.id and key=p_key;
 if found then
  if saved.request_hash<>fingerprint then raise exception using errcode='23505',message='import_idempotency_conflict'; end if;
  -- Revocation/expiry and current job authorization are always revalidated.
  select * into j from app_private.import_jobs where id=saved.job_id;
  if j.expires_at<=clock_timestamp() then raise exception using errcode='40001',message='import_expired'; end if;
  if a.role<>'admin' and j.owner_participant_id is distinct from a.participant_id then raise exception using errcode='42501',message='import_forbidden'; end if;
  return jsonb_build_object('job',app_private.import_json(j.id));
 end if;
 op:=p_command->>'operation';
 if op is null or op not in ('create','save','confirm','cancel') or exists(select 1 from jsonb_object_keys(p_command) k where k not in ('operation','id','expectedVersion','sourceType','rows')) then
  raise exception using errcode='22023',message='invalid_import_command'; end if;
 if op='create' then
  if p_command ? 'id' or p_command ? 'expectedVersion' or p_command->>'sourceType' is null or p_command->>'sourceType' not in ('manual','csv','excel') then raise exception using errcode='22023',message='invalid_import_command'; end if;
  if (select count(*) from app_private.import_jobs where trip_id=a.trip_id and created_at>=clock_timestamp()-interval '1 day'
   and ((a.participant_id is not null and owner_participant_id=a.participant_id) or (a.participant_id is null and created_by_link_id=a.id)))>=20 then
   raise exception using errcode='P0001',message='rate_limited'; end if;
  rows_value:=app_private.refresh_import_review(a.trip_id,app_private.import_rows(p_command->'rows'));
  if p_command->>'sourceType'<>'manual' and exists(select 1 from jsonb_array_elements(rows_value) r group by r->>'sourceSheet',r->>'sourceRow' having count(*)>1) then raise exception using errcode='22023',message='duplicate_import_source'; end if;
  insert into app_private.import_jobs(trip_id,owner_participant_id,created_by_link_id,source_type,rows)
   values(a.trip_id,a.participant_id,a.id,p_command->>'sourceType',rows_value) returning * into j;
 else
  if p_command ? 'sourceType' then raise exception using errcode='22023',message='invalid_import_command'; end if;
  select * into j from app_private.import_jobs where id=(p_command->>'id')::uuid and trip_id=a.trip_id for update;
  if not found or (a.role<>'admin' and j.owner_participant_id is distinct from a.participant_id) then raise exception using errcode='42501',message='import_forbidden'; end if;
  if j.state<>'preview' or j.expires_at<=clock_timestamp() or jsonb_typeof(p_command->'expectedVersion') is distinct from 'number' or (p_command->>'expectedVersion')::integer<>j.version then
   raise exception using errcode='40001',message='import_version_conflict'; end if;
  if op='save' then
   rows_value:=app_private.refresh_import_review(a.trip_id,app_private.import_rows(p_command->'rows',j.rows));
   if j.source_type<>'manual' and exists(select 1 from jsonb_array_elements(rows_value) r group by r->>'sourceSheet',r->>'sourceRow' having count(*)>1) then raise exception using errcode='22023',message='duplicate_import_source'; end if;
   -- Successful rows are immutable and remain traceable during partial retry.
   for r in select value from jsonb_array_elements(app_private.refresh_import_review(j.trip_id,j.rows)) loop
    if exists(select 1 from jsonb_array_elements(j.results) x where x->>'rowId'=r->>'id' and x->>'status'='persisted') then
     rows_value:=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(rows_value) where value->>'id'<>r->>'id')||jsonb_build_array(r);
    end if;
   end loop;
   if j.source_type<>'manual' and exists(select 1 from jsonb_array_elements(rows_value) r group by r->>'sourceSheet',r->>'sourceRow' having count(*)>1) then raise exception using errcode='22023',message='duplicate_import_source'; end if;
   if jsonb_array_length(rows_value)>200 then raise exception using errcode='22023',message='invalid_import_rows'; end if;
   update app_private.import_jobs set rows=rows_value,version=version+1 where id=j.id returning * into j;
  elsif op='cancel' then
   if p_command ? 'rows' then raise exception using errcode='22023',message='invalid_import_command'; end if;
   update app_private.import_jobs set rows='[]',state='cancelled',version=version+1 where id=j.id returning * into j;
  else
   if p_command ? 'rows' then raise exception using errcode='22023',message='invalid_import_command'; end if;
   rows_value:='[]'; results_value:=j.results;
   for r in select value from jsonb_array_elements(app_private.refresh_import_review(j.trip_id,j.rows)) loop
    if exists(select 1 from jsonb_array_elements(j.results) x where x->>'rowId'=r->>'id' and x->>'status'='persisted') or not (r->>'selected')::boolean then
     rows_value:=rows_value||jsonb_build_array(r); continue; end if;
    count_selected:=count_selected+1;
    results_value:=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(results_value) where value->>'rowId'<>r->>'id');
    begin
     if not (r->>'reviewed')::boolean
      or (r->'duplicateExpenseIds' is distinct from app_private.import_duplicates(j.trip_id,r)
       and not ((r->>'keepBoth')::boolean and r->'warnings' ? 'DUPLICATE_IN_BATCH'
        and not exists(select 1 from jsonb_array_elements(app_private.import_duplicates(j.trip_id,r)) d
         where not (r->'duplicateExpenseIds' @> jsonb_build_array(d))
         and not exists(select 1 from jsonb_array_elements(results_value) x where x->>'status'='persisted' and x->'expenseId'=d))))
      or ((jsonb_array_length(r->'duplicateExpenseIds')>0 or r->'warnings' ? 'DUPLICATE_IN_BATCH') and not (r->>'keepBoth')::boolean) then
      raise exception using errcode='22023',message='import_review_required'; end if;
     cmd:=jsonb_build_object('operation','create','payerId',r->'payerId','description',r->'description','spentOn',r->'spentOn','amountMinor',r->'amountMinor','currency',r->'currency','splits',r->'splits');
     -- Stable identity per job+row. Trip lock also serializes concurrent confirmations.
     row_key:=substr(encode(sha256(convert_to(j.id::text||':'||(r->>'id'),'UTF8')),'hex'),1,32)::uuid;
     expense:=app_api.mutate_expense(p_session_hash,row_key,cmd);
     update app_private.expenses set source=case when j.source_type='manual' then 'bulk' else j.source_type end where id=(expense->>'id')::uuid;
     -- Revision reflects the source as well as the exact reviewed financial fields.
     update app_private.expense_revisions set snapshot=app_private.expense_json((expense->>'id')::uuid) where expense_id=(expense->>'id')::uuid and version=(expense->>'version')::integer;
     insert into app_private.import_saved_rows(job_id,row_id,expense_id,preview_version,source_row,source_sheet)
      values(j.id,(r->>'id')::uuid,(expense->>'id')::uuid,j.version,(r->>'sourceRow')::integer,coalesce(r->>'sourceSheet',''));
     receipt:=jsonb_build_object('rowId',r->'id','status','persisted','expenseId',expense->'id');
     r:=r||jsonb_build_object('selected',false,'reviewed',false,'keepBoth',false,'evidence','','warnings','[]'::jsonb,'duplicateExpenseIds','[]'::jsonb);
    exception
     when insufficient_privilege then receipt:=jsonb_build_object('rowId',r->'id','status','failed','code','FORBIDDEN');
     when invalid_parameter_value or invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation or not_null_violation or foreign_key_violation or numeric_value_out_of_range then
      receipt:=jsonb_build_object('rowId',r->'id','status','failed','code','INVALID_ROW');
     when unique_violation or serialization_failure then receipt:=jsonb_build_object('rowId',r->'id','status','failed','code','CONFLICT');
    end;
    results_value:=results_value||jsonb_build_array(receipt);
    rows_value:=rows_value||jsonb_build_array(r);
   end loop;
   if count_selected=0 then raise exception using errcode='22023',message='no_reviewed_rows'; end if;
   if not exists(select 1 from jsonb_array_elements(rows_value) x where (x->>'selected')::boolean) then
    -- Completed: discard unselected original evidence, retain only normalized saved rows.
    rows_value:=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(rows_value) x where exists(select 1 from jsonb_array_elements(results_value) y where y->>'rowId'=x->>'id' and y->>'status'='persisted'));
    j.state:='persisted';
    end if;
   update app_private.import_jobs set rows=rows_value,results=results_value,state=j.state,version=version+1 where id=j.id returning * into j;
  end if;
 end if;
 result:=jsonb_build_object('job',app_private.import_json(j.id));
 insert into app_private.import_commands(actor_link_id,key,request_hash,job_id,result,expires_at)
 values(a.id,p_key,fingerprint,j.id,jsonb_build_object('jobId',j.id),j.expires_at);
 return result;
end $$;
revoke all on all functions in schema app_private from public,cusco_bff;
revoke execute on function app_api.list_imports(text,uuid),app_api.mutate_import(text,uuid,jsonb) from public,cusco_bff;
grant execute on function app_api.list_imports(text,uuid),app_api.mutate_import(text,uuid,jsonb) to cusco_bff;
commit;
