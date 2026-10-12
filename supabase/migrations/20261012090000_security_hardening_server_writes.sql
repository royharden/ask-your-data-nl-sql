/*
# Security hardening pass 2: server-side writes, working read-only runner, private uploads

1. Data tables (`questions`, `routing`, `queries`)
   - Every anon/authenticated INSERT, UPDATE and DELETE policy is dropped; the
     SELECT policies stay. Write privileges are revoked from anon/authenticated.
   - Rows are now written only by the Edge Functions (jev-route, data, llm)
     using the service-role client with whitelisted columns.

2. `usage_counters`
   - Re-asserted: RLS on, no policies at all, REVOKE ALL from PUBLIC/anon/
     authenticated. Only `increment_usage_counter()` (service_role) writes it.

3. `demo` and `uploads` schemas
   - anon/authenticated/PUBLIC lose every write privilege and CREATE on both.
   - `uploads` tables are no longer readable by anon/authenticated at all;
     previews and query results are served through the `data` function.
   - The only write path into `uploads` is `create_upload_table()`, which is
     executable by service_role only.

4. `get_schema_info()` - fixed. The old body aggregated an undefined alias
   (`t`) and failed with `column "t" does not exist` on every call. Still
   SECURITY DEFINER, fixed search_path, EXECUTE for service_role only.

5. `get_table_samples(p_limit)` - new. Returns up to 10 sample rows per demo/
   uploads table so the data function no longer reads those schemas via the
   Data API. SECURITY DEFINER, service_role only.

6. `create_upload_table(p_table, p_columns, p_rows)` - replaces the 2-arg
   version. Creates `uploads.<p_table>` (whitelisted types, validated names,
   <= 100 columns) if missing, refuses to reuse a table whose columns differ,
   and inserts up to 5,000 rows per call from JSON. New tables get SELECT for
   `sql_runner` only.

7. `run_readonly_sql(query)` - rewritten. The old version called
   `set_config('role', ...)` inside a SECURITY DEFINER function, which Postgres
   rejects ("cannot set parameter role within security-definer function"), so
   every query failed. The function is now OWNED BY `sql_runner`, so it runs
   with that role's privileges (SELECT on demo/uploads only) without SET ROLE.
   It also:
   - switches the transaction to read-only before running the query;
   - clears PostgREST's request.headers / request.cookies / request.jwt.claims
     so a query cannot read the caller's API key via current_setting();
   - declares `statement_timeout = 5s` (PostgREST 12+ applies function-level
     statement_timeout to the RPC call) and arms `transaction_timeout` on
     Postgres 17+; a wall-clock check between rows backs this up;
   - runs the query through a cursor (single SELECT only; multi-statement and
     SELECT INTO are rejected by Postgres) and returns at most 1,000 rows and
     about 2 MB of JSON as `{ rows, columns, truncated }`.
*/

-- -----------------------------------------------------------------------
-- 1. Data tables: drop every non-SELECT policy, revoke client write grants
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename IN ('questions', 'routing', 'queries') AND cmd <> 'SELECT')
        OR tablename = 'usage_counters'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

ALTER TABLE public.questions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.questions, public.routing, public.queries
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.questions, public.routing, public.queries TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.questions, public.routing, public.queries TO service_role;

-- -----------------------------------------------------------------------
-- 2. usage_counters: no client access at all
REVOKE ALL ON public.usage_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage_counter(text) TO service_role;

-- -----------------------------------------------------------------------
-- 3. demo / uploads: read-only for clients (demo) or private (uploads)
REVOKE CREATE ON SCHEMA demo, uploads FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA demo FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA uploads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA demo, uploads FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA uploads FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA demo
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA uploads
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA demo, uploads TO sql_runner;
GRANT SELECT ON ALL TABLES IN SCHEMA demo, uploads TO sql_runner;

-- -----------------------------------------------------------------------
-- 4. get_schema_info(): fixed aggregate (one JSON object per column)
CREATE OR REPLACE FUNCTION public.get_schema_info()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'table_schema', c.table_schema,
        'table_name',   c.table_name,
        'column_name',  c.column_name,
        'data_type',    c.data_type
      )
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    ),
    '[]'::json
  )
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
  WHERE c.table_schema IN ('demo', 'uploads')
    AND t.table_type = 'BASE TABLE';
$fn$;

REVOKE ALL ON FUNCTION public.get_schema_info() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_schema_info() TO service_role;

-- -----------------------------------------------------------------------
-- 5. get_table_samples(): a few rows per demo/uploads table for previews
CREATE OR REPLACE FUNCTION public.get_table_samples(p_limit int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
AS $fn$
DECLARE
  r      record;
  v_rows jsonb;
  v_out  jsonb := '{}'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    p_limit := 3;
  END IF;

  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('demo', 'uploads')
      AND c.relkind IN ('r', 'p')
    ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT * FROM %I.%I LIMIT %s) x',
      r.schema_name, r.table_name, p_limit
    ) INTO v_rows;
    v_out := v_out || jsonb_build_object(r.schema_name || '.' || r.table_name, v_rows);
  END LOOP;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_table_samples(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_table_samples(int) TO service_role;

-- -----------------------------------------------------------------------
-- 6. create_upload_table(): the only write path into the uploads schema
DROP FUNCTION IF EXISTS public.create_upload_table(text, jsonb);

CREATE OR REPLACE FUNCTION public.create_upload_table(
  p_table   text,
  p_columns jsonb,
  p_rows    jsonb DEFAULT '[]'::jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $fn$
DECLARE
  v_col      jsonb;
  v_name     text;
  v_type     text;
  v_defs     text[] := ARRAY[]::text[];
  v_expected text[] := ARRAY[]::text[];
  v_existing text[];
  v_names    text[] := ARRAY[]::text[];
  v_rel      regclass;
  v_inserted int := 0;
BEGIN
  IF p_table IS NULL OR p_table !~ '^[a-z_][a-z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'Invalid table name' USING ERRCODE = '22023';
  END IF;
  IF p_columns IS NULL OR jsonb_typeof(p_columns) <> 'array'
     OR jsonb_array_length(p_columns) < 1 OR jsonb_array_length(p_columns) > 100 THEN
    RAISE EXCEPTION 'Between 1 and 100 columns are required' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'At most 5000 rows per call' USING ERRCODE = '22023';
  END IF;

  FOR v_col IN SELECT value FROM jsonb_array_elements(p_columns) LOOP
    v_name := v_col->>'name';
    v_type := v_col->>'type';
    IF v_name IS NULL OR v_name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'Invalid column name' USING ERRCODE = '22023';
    END IF;
    IF v_type IS NULL OR v_type NOT IN ('text', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz') THEN
      RAISE EXCEPTION 'Unsupported column type' USING ERRCODE = '22023';
    END IF;
    IF v_name = ANY (v_names) THEN
      RAISE EXCEPTION 'Duplicate column name' USING ERRCODE = '22023';
    END IF;
    v_names    := array_append(v_names, v_name);
    v_defs     := array_append(v_defs, format('%I %s', v_name, v_type));
    v_expected := array_append(
      v_expected,
      v_name || ' ' || CASE v_type WHEN 'timestamptz' THEN 'timestamp with time zone' ELSE v_type END
    );
  END LOOP;

  v_rel := to_regclass(format('uploads.%I', p_table));
  IF v_rel IS NULL THEN
    EXECUTE format('CREATE TABLE uploads.%I (%s)', p_table, array_to_string(v_defs, ', '));
    EXECUTE format('REVOKE ALL ON uploads.%I FROM PUBLIC, anon, authenticated', p_table);
    EXECUTE format('GRANT SELECT ON uploads.%I TO sql_runner', p_table);
  ELSE
    SELECT array_agg(a.attname::text || ' ' || format_type(a.atttypid, NULL) ORDER BY a.attnum)
      INTO v_existing
      FROM pg_attribute a
     WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_existing IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Table uploads.% already exists with different columns', p_table
        USING ERRCODE = '42P07';
    END IF;
  END IF;

  IF jsonb_array_length(p_rows) > 0 THEN
    EXECUTE format(
      'INSERT INTO uploads.%I SELECT * FROM jsonb_populate_recordset(NULL::uploads.%I, $1)',
      p_table, p_table
    ) USING p_rows;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_upload_table(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_upload_table(text, jsonb, jsonb) TO service_role;

-- -----------------------------------------------------------------------
-- 7. run_readonly_sql(): runs as sql_runner, read-only, bounded
CREATE OR REPLACE FUNCTION public.run_readonly_sql(query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = demo, uploads, pg_temp
SET statement_timeout = '5s'
AS $fn$
DECLARE
  c_max_rows  constant int := 1000;
  c_max_bytes constant int := 2000000;
  v_started   timestamptz := clock_timestamp();
  v_rec       record;
  v_row       json;
  v_rows      json[] := ARRAY[]::json[];
  v_columns   json := '[]'::json;
  v_count     int := 0;
  v_bytes     bigint := 0;
  v_truncated boolean := false;
BEGIN
  IF query IS NULL OR length(query) = 0 OR length(query) > 10000 THEN
    RAISE EXCEPTION 'Invalid query' USING ERRCODE = '22023';
  END IF;

  -- Nothing after this point may write, whatever the query does.
  PERFORM set_config('transaction_read_only', 'on', true);

  -- PostgREST exposes the caller's headers (including the service-role key)
  -- and JWT claims as settings; hide them from the user query.
  PERFORM set_config('request.headers', '{}', true);
  PERFORM set_config('request.cookies', '{}', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  -- Postgres 17+: a hard cap for the rest of this transaction.
  IF current_setting('server_version_num')::int >= 170000 THEN
    PERFORM set_config('transaction_timeout', '6s', true);
  END IF;

  FOR v_rec IN EXECUTE query LOOP
    IF clock_timestamp() - v_started > interval '5 seconds' THEN
      RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014';
    END IF;
    IF v_count >= c_max_rows THEN
      v_truncated := true;
      EXIT;
    END IF;
    v_row := row_to_json(v_rec);
    v_bytes := v_bytes + octet_length(v_row::text);
    IF v_bytes > c_max_bytes THEN
      IF v_count = 0 THEN
        RAISE EXCEPTION 'Query result row is too large' USING ERRCODE = '54000';
      END IF;
      v_truncated := true;
      EXIT;
    END IF;
    IF v_count = 0 THEN
      SELECT COALESCE(json_agg(k), '[]'::json) INTO v_columns FROM json_object_keys(v_row) AS k;
    END IF;
    v_rows := v_rows || v_row;
    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object(
    'rows', array_to_json(v_rows),
    'columns', v_columns,
    'truncated', v_truncated
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_readonly_sql(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_readonly_sql(text) TO service_role;

-- Hand the function to sql_runner so it executes with only that role's
-- privileges. Changing the owner requires membership in sql_runner and (only
-- at that moment) CREATE on the function's schema.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT sql_runner TO %I', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO sql_runner;
ALTER FUNCTION public.run_readonly_sql(text) OWNER TO sql_runner;
REVOKE CREATE ON SCHEMA public FROM sql_runner;
