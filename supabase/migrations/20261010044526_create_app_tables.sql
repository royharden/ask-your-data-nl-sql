/*
# App tables for Ask Your Data

1. New Tables (all in `public`)
   - `questions`  - each natural-language question the user asked.
     - `id` (uuid pk), `text`, `dataset` (demo | upload name), `mode` (live | mock), `created_at`
   - `routing`    - Jev router results per question.
     - `id` (uuid pk), `question_id` (fk), `jev_request` (jsonb), `jev_response` (jsonb),
       `model`, `latency_ms` (int), `input_tokens` (int), `cost_usd` (numeric),
       `decision` (text), `fired_rules` (jsonb), `schema_slice` (jsonb), `policy` (jsonb)
   - `queries`    - generated/executed SQL results per question.
     - `id` (uuid pk), `question_id` (fk), `sql`, `chart` (jsonb), `valid` (bool),
       `error` (text), `row_count` (int), `exec_ms` (int), `explanation` (text),
       `edited_by_user` (bool), `created_at`
   - `usage_counters` - per-day per-function call counter for abuse limits.
     - `day` (date), `fn` (text), `calls` (int), primary key (day, fn)

2. Security
   - RLS enabled on all four tables with permissive anon policies (single
     public demo workspace, no auth in this app).
*/

CREATE TABLE IF NOT EXISTS public.questions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text       text NOT NULL,
  dataset    text NOT NULL DEFAULT 'demo',
  mode       text NOT NULL DEFAULT 'live',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.routing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id   uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  jev_request   jsonb,
  jev_response  jsonb,
  model         text,
  latency_ms    int,
  input_tokens  int,
  cost_usd      numeric(12,6),
  decision      text,
  fired_rules   jsonb,
  schema_slice  jsonb,
  policy        jsonb
);

CREATE TABLE IF NOT EXISTS public.queries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id    uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  sql            text NOT NULL,
  chart          jsonb,
  valid          boolean NOT NULL DEFAULT false,
  error          text,
  row_count      int,
  exec_ms        int,
  explanation    text,
  edited_by_user boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.usage_counters (
  day   date NOT NULL,
  fn    text NOT NULL,
  calls int  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

ALTER TABLE public.questions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_questions_select" ON public.questions;
CREATE POLICY "anon_questions_select" ON public.questions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_questions_insert" ON public.questions;
CREATE POLICY "anon_questions_insert" ON public.questions
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_questions_update" ON public.questions;
CREATE POLICY "anon_questions_update" ON public.questions
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_questions_delete" ON public.questions;
CREATE POLICY "anon_questions_delete" ON public.questions
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_routing_select" ON public.routing;
CREATE POLICY "anon_routing_select" ON public.routing
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_routing_insert" ON public.routing;
CREATE POLICY "anon_routing_insert" ON public.routing
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_routing_update" ON public.routing;
CREATE POLICY "anon_routing_update" ON public.routing
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_routing_delete" ON public.routing;
CREATE POLICY "anon_routing_delete" ON public.routing
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_queries_select" ON public.queries;
CREATE POLICY "anon_queries_select" ON public.queries
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_queries_insert" ON public.queries;
CREATE POLICY "anon_queries_insert" ON public.queries
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_queries_update" ON public.queries;
CREATE POLICY "anon_queries_update" ON public.queries
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_queries_delete" ON public.queries;
CREATE POLICY "anon_queries_delete" ON public.queries
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_counters_select" ON public.usage_counters;
CREATE POLICY "anon_counters_select" ON public.usage_counters
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_counters_insert" ON public.usage_counters;
CREATE POLICY "anon_counters_insert" ON public.usage_counters
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_counters_update" ON public.usage_counters;
CREATE POLICY "anon_counters_update" ON public.usage_counters
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_counters_delete" ON public.usage_counters;
CREATE POLICY "anon_counters_delete" ON public.usage_counters
  FOR DELETE TO anon, authenticated USING (true);
