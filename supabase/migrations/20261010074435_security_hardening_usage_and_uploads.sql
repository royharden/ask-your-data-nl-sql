/*
# Security hardening: lock down usage_counters, replace exec_sql with safe functions

1. Changed Tables
   - `usage_counters` - RLS stays enabled; ALL anon/authenticated policies removed.
     The table is now written to ONLY through the `increment_usage_counter`
     SECURITY DEFINER function (callable by service_role only). No direct
     client access.

2. New Functions
   - `public.increment_usage_counter(p_fn text)`
     SECURITY DEFINER. Atomically inserts-or-increments today's row for the
     given function name and returns the new call count as an int.
     `INSERT ... ON CONFLICT (day, fn) DO UPDATE SET calls = usage_counters.calls + 1 RETURNING calls`.
     EXECUTE revoked from PUBLIC, anon, authenticated; granted to service_role.

   - `public.get_schema_info()`
     SECURITY DEFINER. Returns table/column metadata for the demo and uploads
     schemas as JSON. Replaces the dangerous open-ended `exec_sql` for schema
     introspection. EXECUTE granted to service_role only.

   - `public.create_upload_table(p_table text, p_columns jsonb)`
     SECURITY DEFINER. Creates `uploads.<p_table>` with columns whose types
     are restricted to a whitelist (text, bigint, numeric, boolean, date,
     timestamptz). Column names and the table name are validated to match
     `^[a-z_][a-z0-9_]{0,39}$`. Replaces the open-ended `exec_sql` DDL path.
     EXECUTE granted to service_role only.

3. Removed Functions
   - `public.exec_sql(text)` - DROPPED. It allowed arbitrary SQL execution
     through a service-role RPC and was a security risk. Replaced by the
     targeted functions above.

4. Security
   - `usage_counters`: RLS enabled, zero policies, no grants to anon/auth.
     Only the SECURITY DEFINER increment function can write to it.
   - All three new functions: EXECUTE revoked from PUBLIC/anon/authenticated,
     granted to service_role only.
*/
-- -----------------------------------------------------------------------

-- 1. Lock down usage_counters: remove all policies and grants
DROP POLICY IF EXISTS "anon_counters_select" ON public.usage_counters;
DROP POLICY IF EXISTS "anon_counters_insert" ON public.usage_counters;
DROP POLICY IF EXISTS "anon_counters_update" ON public.usage_counters;
DROP POLICY IF EXISTS "anon_counters_delete" ON public.usage_counters;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.usage_counters FROM anon, authenticated;
-- RLS stays enabled (already true); with no policies the table is locked for direct access.

-- 2. Atomic increment function
CREATE OR REPLACE FUNCTION public.increment_usage_counter(p_fn text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_calls int;
BEGIN
  INSERT INTO public.usage_counters (day, fn, calls)
  VALUES (current_date, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = public.usage_counters.calls + 1
  RETURNING calls INTO v_calls;
  RETURN v_calls;
END;
$fn$;

REVOKE ALL ON FUNCTION public.increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage_counter(text) TO service_role;

-- 3. Schema info function (replaces exec_sql for introspection)
CREATE OR REPLACE FUNCTION public.get_schema_info()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(t ORDER BY t.table_schema, t.table_name), '[]'::json)
    FROM (
      SELECT
        json_build_object(
          'table_schema', c.table_schema,
          'table_name', c.table_name,
          'column_name', c.column_name,
          'data_type', c.data_type
        ) AS col
      FROM information_schema.columns c
      WHERE c.table_schema IN ('demo', 'uploads')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    ) s
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_schema_info() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_schema_info() TO service_role;

-- 4. Safe upload table creation (replaces exec_sql for DDL)
CREATE OR REPLACE FUNCTION public.create_upload_table(
  p_table text,
  p_columns jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  col_name text;
  col_type text;
  col_defs text[] := ARRAY[]::text[];
  v_sql text;
BEGIN
  -- Validate table name
  IF p_table !~ '^[a-z_][a-z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'Invalid table name: %', p_table;
  END IF;

  IF jsonb_array_length(p_columns) = 0 THEN
    RAISE EXCEPTION 'At least one column is required';
  END IF;

  FOR col_name, col_type IN
    SELECT j->>'name', j->>'type'
    FROM jsonb_array_elements(p_columns) AS j
  LOOP
    -- Validate column name
    IF col_name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'Invalid column name: %', col_name;
    END IF;
    -- Whitelist types
    IF col_type NOT IN ('text', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz') THEN
      RAISE EXCEPTION 'Unsupported column type: %', col_type;
    END IF;
    col_defs := array_append(col_defs, format('%I %s', col_name, col_type));
  END LOOP;

  v_sql := format('CREATE SCHEMA IF NOT EXISTS uploads; CREATE TABLE IF NOT EXISTS uploads.%I (%s)', p_table, array_to_string(col_defs, ', '));
  EXECUTE v_sql;

  -- Grant read to the read-only runner role and to anon/authenticated for Data API
  EXECUTE format('GRANT SELECT ON uploads.%I TO sql_runner, anon, authenticated', p_table);
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_upload_table(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_upload_table(text, jsonb) TO service_role;

-- 5. Drop the dangerous open-ended exec_sql
DROP FUNCTION IF EXISTS public.exec_sql(text);
