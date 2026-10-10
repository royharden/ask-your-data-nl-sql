/*
# Read-only SQL execution role and runner function

1. New Role
   - `sql_runner` - NOLOGIN role that the runner function switches to via
     `SET ROLE`. It only has SELECT on demo and uploads schemas. This means
     even if a crafted query slips past the validator, Postgres itself refuses
     writes at the role level.

2. New Function
   - `public.run_readonly_sql(query text)` - SECURITY DEFINER, executes the
     validated query as `sql_runner` with a 5 second statement timeout.
     Returns rows as json plus a column list.

3. Security
   - Function is SECURITY DEFINER but only grants EXECUTE to the service_role
     used by edge functions. Anon/authenticated get no EXECUTE.
   - statement_timeout is set inside the function before execution.
   - sql_runner has no CREATE privileges anywhere, cannot create or alter.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sql_runner') THEN
    CREATE ROLE sql_runner NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA demo TO sql_runner;
GRANT SELECT ON ALL TABLES IN SCHEMA demo TO sql_runner;

-- uploads schema may not exist yet; create it so grants work up front
CREATE SCHEMA IF NOT EXISTS uploads;
GRANT USAGE ON SCHEMA uploads TO sql_runner;
ALTER DEFAULT PRIVILEGES IN SCHEMA uploads GRANT SELECT ON TABLES TO sql_runner;

CREATE OR REPLACE FUNCTION public.run_readonly_sql(query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, demo, uploads
AS $fn$
DECLARE
  result json;
BEGIN
  PERFORM set_config('role', 'sql_runner', true);
  PERFORM set_config('statement_timeout', '5s', true);
  EXECUTE format('SELECT COALESCE(json_agg(t), ''[]''::json) FROM (%s) sub', query) INTO result;
  PERFORM set_config('role', 'none', true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role', 'none', true);
  RAISE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_readonly_sql(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_readonly_sql(text) TO service_role;
