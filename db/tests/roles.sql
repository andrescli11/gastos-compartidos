-- Supabase-equivalent public principals, only in the guarded disposable CI runner.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin nosuperuser nobypassrls; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin nosuperuser nobypassrls; end if;
end $$;
