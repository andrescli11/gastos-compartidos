-- The platform's optional RLS event-trigger helper is not an application RPC.
-- Revoking public execute does not disable the owner-run event trigger.
begin;
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
 end if;
end $$;
commit;
