// "llm" edge function: write SQL, explain results, describe missing data.
// Falls back to templated mock output when OPENAI_API_KEY is missing or
// mock mode is on (Jev still runs live in that case). Every OpenAI request is
// counted against the daily cap right before it is sent.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { HttpError, json, readJsonBody, serve, UpstreamError } from "../_shared/http.ts";
import { parseQuestion, parseSchema, type SchemaTable } from "../_shared/schema.ts";
import { paidFetch } from "../_shared/usage.ts";

interface ChartSpec {
  type: "bar" | "line" | "pie" | "table";
  x?: string;
  y?: string | string[];
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI = { counter: "llm", name: "LLM" };
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SQL_CHARS = 10_000;
const MAX_ROWS = 50;
const MAX_ROW_KEYS = 100;
const MAX_CELL_CHARS = 200;
const MAX_ROWS_JSON_CHARS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve("llm", async (req, db) => {
  const { body } = await readJsonBody(req, MAX_BODY_BYTES);
  const action = body.action;
  const mock = Boolean(body.mock);

  if (action === "write_sql") {
    return json(await writeSql(db, body, mock));
  }
  if (action === "explain") {
    return json(await explain(db, body, mock));
  }
  if (action === "missing") {
    return json(await missing(db, body, mock));
  }
  throw new HttpError(400, "Unknown action");
});

function getBaseUrl(): string {
  return (Deno.env.get("OPENAI_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
}
function getModel(): string {
  return Deno.env.get("OPENAI_MODEL") || DEFAULT_MODEL;
}
function hasKey(): boolean {
  return Boolean(Deno.env.get("OPENAI_API_KEY"));
}

async function chat(
  db: SupabaseClient,
  messages: { role: string; content: string }[],
): Promise<string | null> {
  const res = await paidFetch(db, OPENAI, `${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    // No temperature parameter by design.
    body: JSON.stringify({
      model: getModel(),
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[llm] OpenAI returned ${res.status}: ${text.slice(0, 500)}`);
    throw new UpstreamError(OPENAI.name, res.status);
  }
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = await res.json();
  } catch (err) {
    console.error("[llm] OpenAI returned invalid JSON", err);
    throw new UpstreamError(OPENAI.name, res.status);
  }
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

function schemaText(tables: SchemaTable[]): string {
  return tables
    .map((t) => `${t.table}(${t.columns.map((c) => `${c.column} ${c.type}`).join(", ")})`)
    .join("\n");
}

function parseSql(value: unknown): string {
  const sql = typeof value === "string" ? value : "";
  if (sql.length > MAX_SQL_CHARS) throw new HttpError(422, `SQL is limited to ${MAX_SQL_CHARS} characters`);
  return sql;
}

function parseRows(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) {
    throw new HttpError(422, `rows is limited to ${MAX_ROWS} items`);
  }
  for (const r of value) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length > MAX_ROW_KEYS) {
      throw new HttpError(422, "Invalid result row");
    }
  }
  return value as Record<string, unknown>[];
}

// Result rows as prompt text: long cells clipped, total size capped.
function promptRows(rows: Record<string, unknown>[]): string {
  const clipped = rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === "string" && v.length > MAX_CELL_CHARS ? `${v.slice(0, MAX_CELL_CHARS)}…` : v,
      ]),
    ),
  );
  return JSON.stringify(clipped).slice(0, MAX_ROWS_JSON_CHARS);
}

// Store the explanation on the queries row the data function created for this
// run. Only fills an empty explanation on a recent row.
async function recordExplanation(db: SupabaseClient, queryId: unknown, explanation: string) {
  if (typeof queryId !== "string" || !UUID_RE.test(queryId)) return;
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { error } = await db
    .from("queries")
    .update({ explanation })
    .eq("id", queryId)
    .is("explanation", null)
    .gte("created_at", since);
  if (error) console.error("[llm] could not record explanation", error);
}

// ---------- mock fallbacks ----------

function mockWriteSql(
  question: string,
  tables: SchemaTable[],
): { sql: string; chart: ChartSpec; assumptions: string[] } {
  const main = tables[0];
  const cols = main?.columns ?? [];
  const textCol = cols.find((c) => /text|varchar|char/i.test(c.type))?.column ?? cols[0]?.column ?? "id";
  const numCol =
    cols.find((c) => /numeric|decimal|integer|bigint|real|double/i.test(c.type))?.column ??
    cols[1]?.column ??
    "id";

  const sql =
    `SELECT ${textCol}, SUM(${numCol}) AS total\n` +
    `FROM ${main.table}\n` +
    `GROUP BY ${textCol}\n` +
    `ORDER BY total DESC\n` +
    `LIMIT 20`;

  return {
    sql,
    chart: { type: "bar", x: textCol, y: "total" },
    assumptions: [
      "Mock mode: SQL is a best-effort template.",
      `Grouped by ${textCol}, summed ${numCol}.`,
    ],
  };
}

function mockExplain(question: string, rows: Record<string, unknown>[]): string {
  if (!rows.length) return "The query ran successfully but returned no rows.";
  const first = rows[0];
  const keys = Object.keys(first);
  const summary = keys
    .slice(0, 3)
    .map((k) => `${k} ${String(first[k])}`)
    .join(", ");
  return `Mock explanation: the query returned ${rows.length} row${rows.length === 1 ? "" : "s"}; the top row shows ${summary}. Enable the live LLM for a richer narrative answer.`;
}

// ---------- actions ----------

async function writeSql(
  db: SupabaseClient,
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = parseQuestion(body.question);
  const tables = parseSchema(body.schema ?? []);
  if (!tables.length) return { error: "schema is required" };

  if (mock || !hasKey()) {
    const m = mockWriteSql(question, tables);
    return { ...m, mocked: true, model: "mock" };
  }

  const prompt = `You are a PostgreSQL expert. Write ONE read-only SQL query (SELECT or WITH ... SELECT) answering the user question using ONLY these tables and columns:

${schemaText(tables)}

Rules:
- Never reference tables or columns not listed above.
- Qualify table names exactly as given (e.g. demo.orders).
- Postgres dialect. Return a single statement, no semicolon needed.
- Choose a chart: one of "bar", "line", "pie", "table", with x (category/date column name) and y (numeric column name or list).

User question: ${question}

Return JSON: {"sql": "...", "chart": {"type": "bar", "x": "...", "y": "..."}, "assumptions": ["..."]}`;

  const content = await chat(db, [
    { role: "system", content: "You write safe, correct PostgreSQL for analytics." },
    { role: "user", content: prompt },
  ]);
  if (!content) return { error: "Empty response from LLM" };

  try {
    const parsed = JSON.parse(content);
    return {
      sql: String(parsed.sql ?? ""),
      chart: parsed.chart ?? { type: "table" },
      assumptions: parsed.assumptions ?? [],
      mocked: false,
      model: getModel(),
    };
  } catch {
    console.error("[llm] could not parse write_sql output", content.slice(0, 500));
    return { error: "Could not parse LLM JSON output" };
  }
}

async function explain(
  db: SupabaseClient,
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = parseQuestion(body.question);
  const sql = parseSql(body.sql);
  const rows = parseRows(body.rows);

  if (mock || !hasKey()) {
    const explanation = mockExplain(question, rows);
    await recordExplanation(db, body.query_id, explanation);
    return { explanation, mocked: true, model: "mock" };
  }

  const prompt = `User question: ${question}

SQL that was run:
${sql}

First rows of the result (JSON):
${promptRows(rows)}

Write a 2-3 sentence plain-English answer to the question. Name actual numbers from the rows. Return JSON: {"explanation": "..."}`;

  const content = await chat(db, [
    { role: "system", content: "You explain data results clearly and concisely." },
    { role: "user", content: prompt },
  ]);
  if (!content) return { error: "Empty response from LLM" };
  let explanation: string;
  try {
    explanation = String(JSON.parse(content).explanation ?? "");
  } catch {
    explanation = content.slice(0, 400);
  }
  await recordExplanation(db, body.query_id, explanation);
  return { explanation, mocked: false, model: getModel() };
}

async function missing(
  db: SupabaseClient,
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = parseQuestion(body.question);
  const tables = parseSchema(body.schema ?? []);

  if (mock || !hasKey()) {
    return {
      missing:
        "Mock mode: the available tables do not contain the data this question needs.",
      mocked: true,
    };
  }

  const prompt = `The user asked: "${question}"

The available data is only:
${schemaText(tables)}

In ONE sentence, state which data seems to be missing that would be needed to answer the question. Return JSON: {"missing": "..."}`;

  const content = await chat(db, [
    { role: "system", content: "You identify missing data precisely and briefly." },
    { role: "user", content: prompt },
  ]);
  if (!content) return { error: "Empty response from LLM" };
  try {
    return { missing: String(JSON.parse(content).missing ?? ""), mocked: false };
  } catch {
    return { missing: content.slice(0, 200), mocked: false };
  }
}
