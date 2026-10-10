// "llm" edge function: write SQL, explain results, describe missing data.
// Falls back to templated mock output when OPENAI_API_KEY is missing or
// mock mode is on (Jev still runs live in that case).
import { handleWithUsage, json } from "../_shared/usage.ts";

interface ChartSpec {
  type: "bar" | "line" | "pie" | "table";
  x?: string;
  y?: string | string[];
}
interface SchemaCol {
  column: string;
  type: string;
  samples?: unknown[];
}
interface SchemaTable {
  table: string;
  columns: SchemaCol[];
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

Deno.serve(async (req: Request) => {
  return handleWithUsage(req, "llm", async () => {
    const body = await req.json();
    const action = body.action;
    const mock = Boolean(body.mock);

    if (action === "write_sql") {
      return json(await writeSql(body, mock));
    }
    if (action === "explain") {
      return json(await explain(body, mock));
    }
    if (action === "missing") {
      return json(await missing(body, mock));
    }
    return json({ error: `Unknown action: ${action}` }, 400);
  });
});

function getBaseUrl(): string {
  return Deno.env.get("OPENAI_BASE_URL") || DEFAULT_BASE_URL;
}
function getModel(): string {
  return Deno.env.get("OPENAI_MODEL") || DEFAULT_MODEL;
}
function hasKey(): boolean {
  return Boolean(Deno.env.get("OPENAI_API_KEY"));
}

async function chat(
  messages: { role: string; content: string }[],
): Promise<string | null> {
  const res = await fetch(`${getBaseUrl()}/chat/completions`, {
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
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? null;
}

function schemaText(tables: SchemaTable[]): string {
  return tables
    .map((t) => `${t.table}(${t.columns.map((c) => `${c.column} ${c.type}`).join(", ")})`)
    .join("\n");
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
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = String(body.question ?? "");
  const tables = (body.schema ?? []) as SchemaTable[];
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

  const content = await chat([
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
    return { error: "Could not parse LLM JSON output", raw: content.slice(0, 500) };
  }
}

async function explain(
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = String(body.question ?? "");
  const sql = String(body.sql ?? "");
  const rows = (body.rows ?? []) as Record<string, unknown>[];

  if (mock || !hasKey()) {
    return { explanation: mockExplain(question, rows), mocked: true, model: "mock" };
  }

  const prompt = `User question: ${question}

SQL that was run:
${sql}

First rows of the result (JSON):
${JSON.stringify(rows.slice(0, 50))}

Write a 2-3 sentence plain-English answer to the question. Name actual numbers from the rows. Return JSON: {"explanation": "..."}`;

  const content = await chat([
    { role: "system", content: "You explain data results clearly and concisely." },
    { role: "user", content: prompt },
  ]);
  if (!content) return { error: "Empty response from LLM" };
  try {
    return {
      explanation: String(JSON.parse(content).explanation ?? ""),
      mocked: false,
      model: getModel(),
    };
  } catch {
    return { explanation: content.slice(0, 400), mocked: false, model: getModel() };
  }
}

async function missing(
  body: Record<string, unknown>,
  mock: boolean,
): Promise<unknown> {
  const question = String(body.question ?? "");
  const tables = (body.schema ?? []) as SchemaTable[];

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

  const content = await chat([
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
