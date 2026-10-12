// "jev-route" edge function: one fan-out request to TypeSafe System One.
// Jev checks answerability, picks the table, selects relevant columns.
// Without TYPESAFE_API_KEY it falls back to a keyword-based mock router so the
// demo keeps working. The question and routing rows are recorded here with the
// service-role client (clients can no longer write those tables).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { HttpError, json, readJsonBody, serve, UpstreamError } from "../_shared/http.ts";
import { route, type JevAnswers, type Policy } from "../_shared/routing.ts";
import { parseQuestion, parseSchema, type SchemaTable } from "../_shared/schema.ts";
import { paidFetch } from "../_shared/usage.ts";

const MODEL = "jev-1.13.0";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE = { counter: "jev-route", name: "Jev routing" };
const INPUT_COST_PER_MILLION = 0.042; // USD; output tokens are free
const MAX_COLUMNS = 40;
const MAX_BODY_BYTES = 512 * 1024;

interface Question {
  id: string;
  question: string;
  criteria?: string;
  options?: Record<string, string>;
}

interface TypeSafeAnswer {
  id?: string;
  choice?: string;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface RouteResponse {
  answers: Record<string, TypeSafeAnswer>;
  model: string;
  usage: Record<string, number>;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  mocked?: boolean;
}

const TRUE_CRITERIA =
  "Every fact the question needs exists in `schema`.";
const FALSE_CRITERIA =
  "The question needs data that is not in `schema`, or it is not a data question.";

serve("jev-route", async (req, db) => {
  const { body } = await readJsonBody(req, MAX_BODY_BYTES);
  const question = parseQuestion(body.user_question);
  const schema = parseSchema(body.schema);
  const mode = body.mode === "mock" ? "mock" : "live";
  const policy = body.policy === undefined ? null : parsePolicy(body.policy);

  const questionId = await recordQuestion(db, question, mode);
  const result = Deno.env.get("TYPESAFE_API_KEY")
    ? await routeWithJev(db, question, schema)
    : mockRoute(question, schema);
  await recordRouting(db, questionId, question, schema, result, policy);

  return json({ ...result, question_id: questionId });
});

function parsePolicy(value: unknown): Policy {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p !== "object") throw new HttpError(422, "Invalid policy");
  const out = {} as Policy;
  for (const key of ["answerableMin", "tableMinConfidence", "ambiguityAsk", "colKeep"] as const) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new HttpError(422, "Invalid policy");
    }
    out[key] = v;
  }
  return out;
}

async function recordQuestion(
  db: SupabaseClient,
  text: string,
  mode: "live" | "mock",
): Promise<string | null> {
  const { data, error } = await db
    .from("questions")
    .insert({ text, dataset: "demo", mode })
    .select("id")
    .single();
  if (error) {
    console.error("[jev-route] could not record question", error);
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

async function recordRouting(
  db: SupabaseClient,
  questionId: string | null,
  question: string,
  schema: SchemaTable[],
  result: RouteResponse,
  policy: Policy | null,
): Promise<void> {
  if (!questionId) return;
  const rr = policy ? route(result.answers as JevAnswers, policy, schema) : null;
  const { error } = await db.from("routing").insert({
    question_id: questionId,
    jev_request: { user_question: question, schema },
    jev_response: result,
    model: result.model,
    latency_ms: result.latency_ms,
    input_tokens: result.input_tokens,
    cost_usd: result.cost_usd,
    decision: rr?.decision ?? null,
    fired_rules: rr?.firedRules ?? null,
    schema_slice: rr?.schemaSlice ?? null,
    policy,
  });
  if (error) console.error("[jev-route] could not record routing", error);
}

function buildQuestions(tables: SchemaTable[]): Question[] {
  const tableNames = tables.map((t) => t.table);
  const qs: Question[] = [
    {
      id: "answerable",
      question:
        "Can `user_question` be answered using only the tables and columns in `schema`?",
      criteria: `true: ${TRUE_CRITERIA} false: ${FALSE_CRITERIA}`,
    },
    {
      id: "table",
      question:
        "Which table in `schema` is the main table needed to answer `user_question`?",
      criteria:
        "Pick exactly one option. Choose `uncertain` when no single table clearly fits.",
      options: Object.fromEntries([
        ...tableNames.map((t) => [
          t,
          `The ${t.split(".")[1]} table.`,
        ]),
        ["uncertain", "No single table clearly fits."],
      ]),
    },
    {
      id: "needs_join",
      question:
        "Does answering `user_question` require combining more than one table in `schema`?",
    },
    {
      id: "ambiguous",
      question:
        "Is `user_question` ambiguous enough that two reasonable analysts would write different queries?",
    },
  ];
  return qs;
}

function buildColumnQuestions(
  tables: SchemaTable[],
  topTables: string[],
): Question[] {
  const qs: Question[] = [];
  let count = 0;
  for (const t of tables) {
    if (!topTables.includes(t.table)) continue;
    for (const c of t.columns) {
      if (count >= MAX_COLUMNS) break;
      qs.push({
        id: `col__${t.table}__${c.column}`,
        question: `Is column \`${c.column}\` of table \`${t.table}\` needed to answer \`user_question\`?`,
      });
      count++;
    }
  }
  return qs;
}

// One TypeSafe request. paidFetch counts every attempt (and retry) against the
// daily cap before sending it; failures are logged here, never returned.
async function callTypeSafe(
  db: SupabaseClient,
  questions: Question[],
  state: Record<string, unknown>,
): Promise<{ answers: Record<string, TypeSafeAnswer>; usage: Record<string, number>; model: string }> {
  const res = await paidFetch(db, TYPESAFE, TYPESAFE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("TYPESAFE_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, questions, state }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[jev-route] TypeSafe returned ${res.status}: ${text.slice(0, 500)}`);
    throw new UpstreamError(TYPESAFE.name, res.status);
  }

  let data: { answers?: unknown; usage?: Record<string, number>; model?: string };
  try {
    data = await res.json();
  } catch (err) {
    console.error("[jev-route] TypeSafe returned invalid JSON", err);
    throw new UpstreamError(TYPESAFE.name, res.status);
  }
  console.log("TypeSafe response.model:", data.model);

  const answers: Record<string, TypeSafeAnswer> = {};
  for (const a of Array.isArray(data.answers) ? data.answers : []) {
    if (a && typeof a.id === "string") answers[a.id] = a;
  }

  return {
    answers,
    usage: data.usage ?? {},
    model: data.model ?? MODEL,
  };
}

async function routeWithJev(
  db: SupabaseClient,
  userQuestion: string,
  schema: SchemaTable[],
): Promise<RouteResponse> {
  const started = performance.now();

  const state = {
    user_question: userQuestion,
    schema: Object.fromEntries(
      schema.map((t) => [
        t.table,
        t.columns.map((c) => ({
          column: c.column,
          type: c.type,
          samples: (c.samples ?? []).slice(0, 3),
        })),
      ]),
    ),
  };

  const routingQs = buildQuestions(schema);
  const colQs = buildColumnQuestions(schema, schema.map((t) => t.table));

  let answers: Record<string, TypeSafeAnswer> = {};
  let usage: Record<string, number> = {};

  // One request with everything; fall back to split on size rejection. Each
  // split request is counted separately.
  try {
    const r = await callTypeSafe(db, [...routingQs, ...colQs], state);
    answers = r.answers;
    usage = r.usage;
  } catch (err) {
    if (!(err instanceof UpstreamError && err.status === 413) || colQs.length === 0) throw err;
    const r1 = await callTypeSafe(db, routingQs, state);
    const r2 = await callTypeSafe(db, colQs, state);
    answers = { ...r1.answers, ...r2.answers };
    usage = {
      input_tokens: (Number(r1.usage.input_tokens) || 0) + (Number(r2.usage.input_tokens) || 0),
    };
  }

  const latencyMs = Math.round(performance.now() - started);
  const inputTokens = Number(usage.input_tokens) || 0;
  const costUsd = (inputTokens * INPUT_COST_PER_MILLION) / 1_000_000;

  return {
    answers,
    model: MODEL,
    usage,
    latency_ms: latencyMs,
    input_tokens: inputTokens,
    cost_usd: Number(costUsd.toFixed(8)),
  };
}

// ---------- mock router (no TYPESAFE_API_KEY) ----------

const STOP_PARTS = new Set(["id", "at", "on", "of", "the", "and", "usd"]);
const REVENUE_WORDS = new Set(["revenue", "sale", "sold", "spend", "spent", "money", "earn", "earned"]);
const TIME_WORDS = new Set([
  "trend", "month", "monthly", "week", "weekly", "day", "daily", "year", "yearly", "quarter", "date", "when", "time",
]);
const AMBIGUOUS_WORDS = new Set([
  "best", "worst", "top", "good", "bad", "popular", "performing", "busiest", "important", "interesting",
]);
const METRIC_WORDS = new Set([
  "revenue", "sale", "count", "number", "average", "avg", "total", "sum", "quantity", "price", "many", "much",
  "most", "highest", "lowest", "size",
]);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).map(stem);
}

function nameParts(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 3 && !STOP_PARTS.has(p))
    .map(stem);
}

// Keyword heuristics shaped like a TypeSafe response so the routing policy,
// Jev panel and the rest of the pipeline work without a TypeSafe key.
function mockRoute(question: string, schema: SchemaTable[]): RouteResponse {
  const started = performance.now();
  const q = new Set(words(question));
  const revenueAsked = [...q].some((w) => REVENUE_WORDS.has(w));
  const timeAsked = [...q].some((w) => TIME_WORDS.has(w) || /^q[1-4]$/.test(w));

  // Table name hit 3, column name hit 1, revenue/time synonym hit 0.5. Key
  // columns are not matched by name (route() always keeps them).
  const scores = new Map<string, number>();
  const hitCols = new Set<string>();
  for (const t of schema) {
    let score = nameParts(t.table.split(".")[1] ?? t.table).some((p) => q.has(p)) ? 3 : 0;
    for (const c of t.columns) {
      const isKey = /(^|_)id$/i.test(c.column);
      const nameHit = !isKey && nameParts(c.column).some((p) => q.has(p));
      const synonymHit =
        (revenueAsked && /price|amount|revenue|total|quantity|sales|cost/i.test(c.column)) ||
        (timeAsked && /date|time/i.test(c.type));
      if (nameHit || synonymHit) {
        score += nameHit ? 1 : 0.5;
        hitCols.add(`${t.table}.${c.column}`);
      }
    }
    scores.set(t.table, score);
  }

  const matched = [...scores.entries()].filter(([, s]) => s >= 1);
  const answers: Record<string, TypeSafeAnswer> = {};
  answers.answerable = { noul: matched.length ? 0.86 : 0.12 };

  if (matched.length) {
    // Squared scores keep a clear winner confident as more tables are uploaded.
    const weight = (s: number) => s * s + 0.05;
    const total = [...scores.values()].reduce((sum, s) => sum + weight(s), 0);
    const probabilities = Object.fromEntries(
      [...scores.entries()].map(([t, s]) => [t, Number((weight(s) / total).toFixed(3))]),
    );
    const [choice] = matched.sort((a, b) => b[1] - a[1])[0];
    answers.table = { choice, confidence: probabilities[choice], probabilities };
  } else {
    answers.table = { choice: "uncertain", confidence: 0, probabilities: {} };
  }

  answers.needs_join = { noul: matched.length >= 2 ? 0.8 : 0.15 };
  const vague = [...q].some((w) => AMBIGUOUS_WORDS.has(w)) && ![...q].some((w) => METRIC_WORDS.has(w));
  answers.ambiguous = { noul: vague ? 0.75 : 0.2 };

  for (const cq of buildColumnQuestions(schema, schema.map((t) => t.table))) {
    const [, table, ...rest] = cq.id.split("__");
    const column = rest.join("__");
    answers[cq.id] = {
      noul: hitCols.has(`${table}.${column}`) ? 0.92 : /(^|_)id$/i.test(column) ? 0.5 : 0.55,
    };
  }

  return {
    answers,
    model: "mock",
    usage: { input_tokens: 0 },
    latency_ms: Math.round(performance.now() - started),
    input_tokens: 0,
    cost_usd: 0,
    mocked: true,
  };
}
