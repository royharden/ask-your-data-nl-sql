// Routing policy: pure TypeScript with no imports so it runs both in the
// browser (src/lib/routing.ts re-exports it) and in the jev-route Edge
// Function, which re-runs it to record the decision server-side.

export interface ChartSpec {
  type: "bar" | "line" | "pie" | "table";
  x?: string;
  y?: string | string[];
}

export interface FiredRule {
  rule: string;
  detail: string;
}

export interface Policy {
  answerableMin: number;
  tableMinConfidence: number;
  ambiguityAsk: number;
  colKeep: number;
}

export interface JevAnswers {
  answerable?: { noul?: number };
  table?: {
    choice?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
  };
  col__?: unknown; // dynamic: col__<table>__<column>
  needs_join?: { noul?: number };
  ambiguous?: { noul?: number };
  [key: string]: unknown;
}

export interface RoutingSchemaTable {
  table: string;
  columns: { column: string; type: string; samples?: (string | number | boolean | null)[] }[];
}

export interface ColRef {
  table: string;
  column: string;
  noul: number;
}

export interface RouteResult {
  decision: "answer" | "clarify_table" | "refuse_unanswerable" | "ask_clarification";
  stop: boolean;
  schemaSlice: RoutingSchemaTable[];
  selectedCols: ColRef[];
  firedRules: FiredRule[];
  joinTables: string[];
  reason: string;
}

function colProb(answer: unknown): number {
  const a = answer as { noul?: number } | undefined;
  return a?.noul ?? 0;
}

export function route(
  answers: JevAnswers,
  policy: Policy,
  fullSchema: RoutingSchemaTable[],
): RouteResult {
  const firedRules: FiredRule[] = [];
  const answerableProb = (answers.answerable as { noul?: number } | undefined)?.noul ?? 0;
  const table = answers.table ?? {};
  const tableChoice = table.choice ?? "uncertain";
  const tableConfidence = table.confidence ?? 0;
  const needsJoinProb = (answers.needs_join as { noul?: number } | undefined)?.noul ?? 0;
  const ambiguityProb = (answers.ambiguous as { noul?: number } | undefined)?.noul ?? 0;

  // Rule 1: answerability gate
  if (answerableProb < policy.answerableMin) {
    firedRules.push({
      rule: "answerable gate",
      detail: `answerable (${answerableProb.toFixed(2)}) < answerableMin (${policy.answerableMin})`,
    });
    return {
      decision: "refuse_unanswerable",
      stop: true,
      schemaSlice: [],
      selectedCols: [],
      firedRules,
      joinTables: [],
      reason: "This can't be answered from your data.",
    };
  }

  // Rule 2: table uncertainty gate
  if (tableChoice === "uncertain" || tableConfidence < policy.tableMinConfidence) {
    firedRules.push({
      rule: "table uncertainty",
      detail:
        tableChoice === "uncertain"
          ? "Jev picked `uncertain` for the main table"
          : `table confidence (${tableConfidence.toFixed(2)}) < tableMinConfidence (${policy.tableMinConfidence})`,
    });
    return {
      decision: "clarify_table",
      stop: true,
      schemaSlice: [],
      selectedCols: [],
      firedRules,
      joinTables: [],
      reason: "Which table did you mean?",
    };
  }

  // Rule 3: column selection
  const selectedCols: ColRef[] = [];
  const mainTable = fullSchema.find((t) => t.table === tableChoice);
  if (mainTable) {
    for (const col of mainTable.columns) {
      const key = `col__${tableChoice}__${col.column}`;
      const prob = colProb(answers[key]);
      const isKey = /(^|_)id$|_id$/i.test(col.column) || /^id$/i.test(col.column);
      if (prob >= policy.colKeep || isKey) {
        selectedCols.push({ table: tableChoice, column: col.column, noul: prob });
        if (isKey && prob < policy.colKeep) {
          firedRules.push({
            rule: "key always included",
            detail: `${tableChoice}.${col.column} included for joins`,
          });
        }
      }
    }
  }

  // Rule 4: join tables
  const joinTables: string[] = [];
  if (needsJoinProb >= 0.5) {
    firedRules.push({
      rule: "needs_join",
      detail: `needs_join (${needsJoinProb.toFixed(2)}) >= 0.5, adding related tables`,
    });
    for (const t of fullSchema) {
      if (t.table === tableChoice) continue;
      // include a table if it shares a key column with the main table
      const sharesKey = t.columns.some(
        (c) =>
          /(^|_)id$|_id$/i.test(c.column) &&
          mainTable?.columns.some((mc) => mc.column === c.column),
      );
      if (sharesKey) joinTables.push(t.table);
    }
    for (const jt of joinTables) {
      const jtTable = fullSchema.find((t) => t.table === jt);
      if (!jtTable) continue;
      for (const col of jtTable.columns) {
        const key = `col__${jt}__${col.column}`;
        const prob = colProb(answers[key]);
        const isKey = /(^|_)id$|_id$/i.test(col.column) || /^id$/i.test(col.column);
        if (prob >= policy.colKeep || isKey) {
          selectedCols.push({ table: jt, column: col.column, noul: prob });
        }
      }
    }
  }

  // Rule 5: ambiguity chip (non-blocking)
  let decision: RouteResult["decision"] = "answer";
  let reason = "Proceeding to SQL.";
  if (ambiguityProb >= policy.ambiguityAsk) {
    firedRules.push({
      rule: "ambiguous",
      detail: `ambiguous (${ambiguityProb.toFixed(2)}) >= ambiguityAsk (${policy.ambiguityAsk})`,
    });
    decision = "ask_clarification";
    reason = "Ambiguous - show clarifying chips, user can still run it.";
  }

  // Build the schema slice
  const sliceTables = new Set<string>([tableChoice, ...joinTables]);
  const schemaSlice: RoutingSchemaTable[] = [];
  for (const t of fullSchema) {
    if (!sliceTables.has(t.table)) continue;
    const cols = selectedCols.filter((c) => c.table === t.table);
    schemaSlice.push({
      table: t.table,
      columns: cols.length
        ? t.columns.filter((c) => cols.some((s) => s.column === c.column))
        : t.columns,
    });
  }

  return { decision, stop: false, schemaSlice, selectedCols, firedRules, joinTables, reason };
}

export function defaultChartFor(kind: string): ChartSpec {
  switch (kind) {
    case "trend":
      return { type: "line" };
    case "share":
      return { type: "pie" };
    case "ranking":
      return { type: "bar" };
    default:
      return { type: "table" };
  }
}
