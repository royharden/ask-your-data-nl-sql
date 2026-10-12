// Validation for the question and schema the browser sends to jev-route and
// llm, so a client cannot inflate paid prompts or smuggle in odd identifiers.
import { HttpError } from "./http.ts";

export type SampleValue = string | number | boolean | null;

export interface SchemaCol {
  column: string;
  type: string;
  samples?: SampleValue[];
}

export interface SchemaTable {
  table: string; // qualified: demo.orders
  columns: SchemaCol[];
}

export const MAX_QUESTION_CHARS = 500;
const MAX_TABLES = 60;
const MAX_COLUMNS_PER_TABLE = 100;
const MAX_TOTAL_COLUMNS = 1000;
const MAX_SAMPLES = 3;
const MAX_SAMPLE_CHARS = 200;

const TABLE_RE = /^(demo|uploads)\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TYPE_RE = /^[A-Za-z][A-Za-z0-9 _(),-]{0,63}$/;

export function parseQuestion(value: unknown): string {
  const q = typeof value === "string" ? value.trim() : "";
  if (!q) throw new HttpError(400, "A question is required");
  if (q.length > MAX_QUESTION_CHARS) {
    throw new HttpError(413, `Questions are limited to ${MAX_QUESTION_CHARS} characters`);
  }
  return q;
}

function parseSample(value: unknown): SampleValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= MAX_SAMPLE_CHARS) return value;
  throw new HttpError(422, "Invalid schema sample value");
}

export function parseSchema(value: unknown): SchemaTable[] {
  if (!Array.isArray(value)) throw new HttpError(400, "schema must be an array");
  if (value.length > MAX_TABLES) throw new HttpError(422, `schema is limited to ${MAX_TABLES} tables`);

  let totalColumns = 0;
  return value.map((t) => {
    const table = (t as { table?: unknown })?.table;
    const columns = (t as { columns?: unknown })?.columns;
    if (typeof table !== "string" || !TABLE_RE.test(table)) {
      throw new HttpError(422, "Invalid schema table name");
    }
    if (!Array.isArray(columns) || columns.length > MAX_COLUMNS_PER_TABLE) {
      throw new HttpError(422, `Each table is limited to ${MAX_COLUMNS_PER_TABLE} columns`);
    }
    totalColumns += columns.length;
    if (totalColumns > MAX_TOTAL_COLUMNS) {
      throw new HttpError(422, `schema is limited to ${MAX_TOTAL_COLUMNS} columns`);
    }
    return {
      table,
      columns: columns.map((c) => {
        const column = (c as { column?: unknown })?.column;
        const type = (c as { type?: unknown })?.type;
        const samples = (c as { samples?: unknown })?.samples;
        if (typeof column !== "string" || !COLUMN_RE.test(column)) {
          throw new HttpError(422, "Invalid schema column name");
        }
        if (typeof type !== "string" || !TYPE_RE.test(type)) {
          throw new HttpError(422, "Invalid schema column type");
        }
        if (samples !== undefined && (!Array.isArray(samples) || samples.length > MAX_SAMPLES)) {
          throw new HttpError(422, `Each column is limited to ${MAX_SAMPLES} samples`);
        }
        return { column, type, samples: (samples ?? []).map(parseSample) };
      }),
    };
  });
}
