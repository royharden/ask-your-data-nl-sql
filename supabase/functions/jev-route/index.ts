// "jev-route" edge function: one fan-out request to TypeSafe System One.
// Jev checks answerability, picks the table, selects relevant columns.
import { handleWithUsage, json } from "../_shared/usage.ts";

const MODEL = "jev-1.13.0";
const INPUT_COST_PER_MILLION = 0.042; // USD; output tokens are free
const MAX_COLUMNS = 40;
const MAX_RETRIES = 3;

interface SchemaCol {
  column: string;
  type: string;
  samples?: unknown[];
}
export interface SchemaTable {
  table: string; // qualified name like demo.orders
  columns: SchemaCol[];
}

interface Question {
  id: string;
  question: string;
  criteria?: string;
  options?: Record<string, string>;
}

interface TypeSafeAnswer {
  choice?: string;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

const TRUE_CRITERIA =
  "Every fact the question needs exists in `schema`.";
const FALSE_CRITERIA =
  "The question needs data that is not in `schema`, or it is not a data question.";

Deno.serve(async (req: Request) => {
  return handleWithUsage(req, "jev-route", async () => {
    const { user_question, schema } = await req.json();
    if (!user_question || !Array.isArray(schema))
      return json({ error: "user_question and schema are required" }, 400);

    const result = await route(user_question, schema as SchemaTable[]);
    return json(result);
  });
});

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

async function callTypeSafe(
  questions: Question[],
  state: Record<string, unknown>,
): Promise<{ answers: Record<string, TypeSafeAnswer>; usage: Record<string, number>; model: string }> {
  const apiKey = Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured");

  const body = JSON.stringify({
    model: MODEL,
    questions,
    state,
  });

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const started = performance.now();
    try {
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (res.status === 429 || res.status === 529) {
        lastErr = new Error(`TypeSafe returned ${res.status}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`TypeSafe error ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      console.log("TypeSafe response.model:", data.model);

      const answers: Record<string, TypeSafeAnswer> = {};
      for (const a of data.answers ?? []) {
        answers[a.id] = a;
      }

      return {
        answers,
        usage: data.usage ?? {},
        model: data.model ?? MODEL,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function route(userQuestion: string, schema: SchemaTable[]) {
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

  try {
    // One request with everything; fall back to split on size rejection.
    const all = [...routingQs, ...colQs];
    try {
      const r = await callTypeSafe(all, state);
      answers = r.answers;
      usage = r.usage;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/size|too large|413/i.test(msg)) {
        const r1 = await callTypeSafe(routingQs, state);
        const r2 = await callTypeSafe(colQs, state);
        answers = { ...r1.answers, ...r2.answers };
        usage = {
          input_tokens: (r1.usage.input_tokens ?? 0) + (r2.usage.input_tokens ?? 0),
        };
      } else {
        throw err;
      }
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Math.round(performance.now() - started),
    };
  }

  const latencyMs = Math.round(performance.now() - started);
  const inputTokens = usage.input_tokens ?? 0;
  const costUsd = (inputTokens * 0.042) / 1_000_000;

  return {
    answers,
    model: MODEL,
    usage,
    latency_ms: latencyMs,
    input_tokens: inputTokens,
    cost_usd: Number(costUsd.toFixed(8)),
  };
}
