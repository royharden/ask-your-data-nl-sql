export interface SchemaCol {
  column: string;
  type: string;
  samples?: (string | number | boolean | null)[];
}

export interface SchemaTable {
  table: string; // qualified, e.g. demo.orders
  columns: SchemaCol[];
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

export interface ChartSpec {
  type: "bar" | "line" | "pie" | "table";
  x?: string;
  y?: string | string[];
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  columns: string[];
  row_count: number;
  exec_ms: number;
  sql: string;
  error?: string;
}

export interface Policy {
  answerableMin: number;
  tableMinConfidence: number;
  ambiguityAsk: number;
  colKeep: number;
}

export const PRESETS: Record<"Strict" | "Balanced" | "Loose", Policy> = {
  Strict: { answerableMin: 0.6, tableMinConfidence: 0.7, ambiguityAsk: 0.4, colKeep: 0.6 },
  Balanced: { answerableMin: 0.4, tableMinConfidence: 0.55, ambiguityAsk: 0.6, colKeep: 0.5 },
  Loose: { answerableMin: 0.2, tableMinConfidence: 0.4, ambiguityAsk: 0.8, colKeep: 0.4 },
};

export interface FiredRule {
  rule: string;
  detail: string;
}
