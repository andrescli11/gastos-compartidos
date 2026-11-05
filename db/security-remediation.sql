-- The platform's optional RLS event-trigger helper is not an application RPC.
-- Revoking public execute does not disable the owner-run event trigger.
begin;
-- Schema-local revokes cannot subtract PostgreSQL global default EXECUTE.
-- Future functions owned by the migration role require explicit grants.
alter default privileges revoke execute on functions from public;
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
 end if;
end $$;
commit;
