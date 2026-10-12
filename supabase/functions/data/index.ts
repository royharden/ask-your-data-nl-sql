// "data" edge function: schema introspection, CSV upload, validated SQL run.
// Everything goes through SECURITY DEFINER RPCs callable only by service_role;
// the demo/uploads schemas are never read or written through the Data API.
// @deno-types="npm:@types/papaparse@5.5.2"
import Papa from "npm:papaparse@5.7.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { HttpError, json, readJsonBody, serve } from "../_shared/http.ts";
import type { SampleValue, SchemaTable } from "../_shared/schema.ts";
import { countCall } from "../_shared/usage.ts";

const MAX_BODY_BYTES = 64 * 1024; // schema / run
const MAX_UPLOAD_BODY_BYTES = 12 * 1024 * 1024; // a 5 MB CSV after JSON escaping
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 50_000;
const MAX_UPLOAD_COLUMNS = 100;
const MAX_NAME_CHARS = 255;
const INSERT_CHUNK_ROWS = 2_000;
const MAX_SQL_CHARS = 10_000;
const ROW_LIMIT = 1000;
const SAMPLE_CHARS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BLOCKED_KEYWORDS = new Set([
  "insert", "update", "delete", "merge", "into", "drop", "alter", "create", "grant", "revoke", "truncate",
  "copy", "vacuum", "analyze", "call", "do", "set", "reset", "listen", "notify", "comment", "lock",
  "reindex", "refresh", "import", "export",
]);

// Functions/relations that read server settings (request.headers carries the
// caller's API key), execute SQL text, touch large objects or catalogs.
const BLOCKED_NAMES =
  /^(pg_.*|current_setting|set_config|information_schema|query_to_.*|table_to_.*|cursor_to_.*|schema_to_.*|database_to_.*|dblink.*|lo_.*|txid_.*|nextval|setval|currval|lastval|inet_server_.*|inet_client_.*)$/;

// Queries may only read demo.* and uploads.*.
const BLOCKED_SCHEMAS = new Set([
  "public", "auth", "storage", "extensions", "vault", "pgsodium", "pgsodium_masks", "graphql",
  "graphql_public", "realtime", "_realtime", "_analytics", "net", "cron", "pgmq", "supabase_functions",
  "supabase_migrations", "pgbouncer", "information_schema",
]);

interface SchemaInfoRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
}

interface ChartSpec {
  type: "bar" | "line" | "pie" | "table";
  x?: string;
  y?: string | string[];
}

serve("data", async (req, db) => {
  const { body, size } = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  const action = String(body.action ?? "");
  if (action !== "upload" && size > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  if (action !== "schema" && action !== "upload" && action !== "run") {
    throw new HttpError(400, "Unknown action");
  }

  await countCall(db, "data");

  if (action === "schema") {
    return await getSchema(db);
  }
  if (action === "upload") {
    return await uploadCsv(db, body);
  }
  return await runSql(db, body);
});

// ---------- schema ----------

function sampleValue(v: unknown): SampleValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > SAMPLE_CHARS ? s.slice(0, SAMPLE_CHARS) : s;
}

async function getSchema(db: SupabaseClient): Promise<Response> {
  const [info, samples] = await Promise.all([
    db.rpc("get_schema_info"),
    db.rpc("get_table_samples", { p_limit: 3 }),
  ]);
  if (info.error || samples.error) {
    console.error("[data] schema RPC failed", info.error ?? samples.error);
    throw new HttpError(500, "Could not load the schema");
  }

  const rows = (Array.isArray(info.data) ? info.data : []) as SchemaInfoRow[];
  const sampleRows = (samples.data ?? {}) as Record<string, Record<string, unknown>[]>;

  // Group columns by table
  const tables = new Map<string, SchemaTable>();
  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    let table = tables.get(key);
    if (!table) {
      table = { table: key, columns: [] };
      tables.set(key, table);
    }
    table.columns.push({
      column: row.column_name,
      type: row.data_type,
      samples: (sampleRows[key] ?? []).slice(0, 3).map((r) => sampleValue(r[row.column_name])),
    });
  }

  return json({ tables: Array.from(tables.values()) });
}

// ---------- upload ----------

function tableSlug(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = `t_${s}`;
  return s.slice(0, 40) || "upload";
}

function columnSlugs(headers: string[]): string[] {
  const seen = new Set<string>();
  return headers.map((h) => {
    let base = h
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "col";
    if (/^[0-9]/.test(base)) base = `c_${base}`;
    base = base.slice(0, 55);
    let s = base;
    for (let n = 2; seen.has(s); n++) s = `${base}_${n}`;
    seen.add(s);
    return s;
  });
}

const BOOL_RE = /^(true|false)$/i;
const INT_RE = /^-?\d{1,18}$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d{1,3})?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function validDate(m: RegExpMatchArray): boolean {
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Single pass per column: each value is only tested against the types still
// possible, so wide files stay cheap. Types are limited to the whitelist
// create_upload_table accepts.
function inferType(values: (string | undefined)[]): string {
  let bool = true, int = true, num = true, date = true, ts = true;
  let seen = false;
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v === "") continue;
    seen = true;
    if (bool && !BOOL_RE.test(v)) bool = false;
    if (int && !INT_RE.test(v)) int = false;
    if (num && !NUM_RE.test(v)) num = false;
    if (date) {
      const m = v.match(DATE_RE);
      if (!m || !validDate(m)) date = false;
    }
    if (ts) {
      const m = v.match(TS_RE);
      if (!m || !validDate(m) || isNaN(Date.parse(v.replace(" ", "T")))) ts = false;
    }
    if (!bool && !int && !num && !date && !ts) return "text";
  }
  if (!seen) return "text";
  if (bool) return "boolean";
  if (int) return "bigint";
  if (num) return "numeric";
  if (date) return "date";
  if (ts) return "timestamptz";
  return "text";
}

function cellValue(v: string | undefined, type: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (type === "text") return v;
  const t = v.trim();
  return t === "" ? null : t;
}

async function uploadCsv(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === "string" ? body.name : "upload";
  if (name.length > MAX_NAME_CHARS) throw new HttpError(422, "File name is too long");
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) throw new HttpError(400, "No CSV data provided");
  if (new TextEncoder().encode(csv).byteLength > MAX_CSV_BYTES) {
    throw new HttpError(413, "CSV exceeds the 5 MB limit");
  }

  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const rows = parsed.data;
  if (headers.length === 0) throw new HttpError(400, "CSV has no columns");
  if (headers.length > MAX_UPLOAD_COLUMNS) {
    throw new HttpError(413, `CSV exceeds the ${MAX_UPLOAD_COLUMNS} column limit`);
  }
  if (rows.length === 0) throw new HttpError(400, "No data rows found");
  if (rows.length > MAX_UPLOAD_ROWS) throw new HttpError(413, "CSV exceeds the 50,000 row limit");

  const tableName = tableSlug(name);
  const colNames = columnSlugs(headers);
  const columns = headers.map((h, i) => ({
    name: colNames[i],
    type: inferType(rows.map((r) => r[h])),
  }));

  // create_upload_table creates the table on the first call and appends each
  // chunk; it is the only write path into the uploads schema.
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_ROWS).map((r) => {
      const out: Record<string, string | null> = {};
      headers.forEach((h, ci) => {
        out[colNames[ci]] = cellValue(r[h], columns[ci].type);
      });
      return out;
    });
    const { error } = await db.rpc("create_upload_table", {
      p_table: tableName,
      p_columns: columns,
      p_rows: chunk,
    });
    if (error) {
      if (error.code === "42P07") {
        throw new HttpError(409, `A table named uploads.${tableName} already exists with different columns`);
      }
      console.error("[data] create_upload_table failed", error);
      throw new HttpError(500, "Failed to save the uploaded table");
    }
  }

  return json({ table: `uploads.${tableName}`, rows: rows.length, columns: colNames });
}

// ---------- run ----------

interface Token {
  kind: "word" | "ident" | "string" | "number" | "punct";
  value: string;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_CONT = /[A-Za-z0-9_\u0080-￿]/;

// Minimal Postgres lexer: enough to see keywords, identifiers and qualified
// names outside string literals. Constructs whose quoting rules differ from
// plain '...' (dollar quotes, E'' / U&'' escapes, block comments) are
// rejected rather than interpreted. Returns an error message or tokens.
function tokenize(sql: string): Token[] | string {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") return "Block comments are not allowed";
    if (ch === "$") return "Dollar quoting and parameters are not allowed";
    if (ch === "\\") return "Backslashes are not allowed";
    if (ch === "&" && (sql[i + 1] === "'" || sql[i + 1] === '"')) {
      return "Unicode escape strings are not allowed";
    }
    if (ch === "'") {
      if (i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z_\u0080-￿]/.test(sql[i - 2]))) {
        return "Escape string literals are not allowed";
      }
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= n) return "Unterminated string literal";
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        if (sql[j] === "\\") return "Backslashes are not allowed";
        value += sql[j++];
      }
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= n) return "Unterminated quoted identifier";
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j++];
      }
      tokens.push({ kind: "ident", value });
      i = j + 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_CONT.test(sql[j])) j++;
      tokens.push({ kind: "word", value: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      tokens.push({ kind: "number", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: ch });
    i++;
  }
  return tokens;
}

// Returns an error message, or null when the SQL is a single read-only
// SELECT over demo/uploads. The database enforces the same independently:
// the runner executes as sql_runner in a read-only transaction.
function checkReadOnlySql(sql: string): string | null {
  const tokens = tokenize(sql);
  if (typeof tokens === "string") return tokens;
  if (tokens.length === 0) return "Empty SQL";

  if (tokens.some((t) => t.kind === "punct" && t.value === ";")) {
    return "Only a single SQL statement is allowed";
  }

  const first = tokens[0];
  const isSelect = first.kind === "word" && first.value === "select";
  const isWithSelect =
    first.kind === "word" &&
    first.value === "with" &&
    tokens.some((t) => t.kind === "word" && t.value === "select");
  if (!isSelect && !isWithSelect) {
    return "Only SELECT or WITH ... SELECT statements are allowed";
  }

  for (const t of tokens) {
    if (t.kind === "word" && BLOCKED_KEYWORDS.has(t.value)) {
      return "Write and DDL statements are not allowed";
    }
    if ((t.kind === "word" || t.kind === "ident") && BLOCKED_NAMES.test(t.value.toLowerCase())) {
      return `"${t.value}" is not allowed in queries`;
    }
  }

  for (let k = 0; k + 2 < tokens.length; k++) {
    const [a, dot, b] = [tokens[k], tokens[k + 1], tokens[k + 2]];
    if (
      (a.kind === "word" || a.kind === "ident") &&
      dot.kind === "punct" && dot.value === "." &&
      (b.kind === "word" || b.kind === "ident" || (b.kind === "punct" && b.value === "*")) &&
      BLOCKED_SCHEMAS.has(a.value.toLowerCase())
    ) {
      return "Queries may only read the demo and uploads schemas";
    }
  }
  return null;
}

function hasRowLimit(sql: string): boolean {
  const tokens = tokenize(sql);
  return Array.isArray(tokens) && tokens.some((t) => t.kind === "word" && (t.value === "limit" || t.value === "fetch"));
}

// Postgres errors about the user's own SQL are useful to show; anything else
// is logged and replaced with a generic message.
function sqlErrorMessage(error: { code?: string; message?: string }): string {
  const code = error.code ?? "";
  if (code === "57014") return "Query timed out (5 second limit)";
  if (code === "25006") return "Only read-only queries are allowed";
  if (/^(22|42|54|P0)/.test(code) && error.message) return error.message;
  console.error("[data] run_readonly_sql failed", error);
  return "Query failed";
}

const CHART_TYPES = new Set(["bar", "line", "pie", "table"]);

function parseChart(value: unknown): ChartSpec {
  const c = value as { type?: unknown; x?: unknown; y?: unknown } | null;
  if (!c || typeof c !== "object" || typeof c.type !== "string" || !CHART_TYPES.has(c.type)) {
    return { type: "bar" };
  }
  const field = (v: unknown) => (typeof v === "string" && v.length <= 128 ? v : undefined);
  const chart: ChartSpec = { type: c.type as ChartSpec["type"] };
  const x = field(c.x);
  if (x !== undefined) chart.x = x;
  if (Array.isArray(c.y)) {
    chart.y = c.y.slice(0, 10).map(field).filter((v): v is string => v !== undefined);
  } else {
    const y = field(c.y);
    if (y !== undefined) chart.y = y;
  }
  return chart;
}

// Record the run for a pipeline question (the browser no longer writes to
// the queries table). The llm function adds the explanation later.
async function recordQuery(
  db: SupabaseClient,
  body: Record<string, unknown>,
  sql: string,
  rowCount: number,
  execMs: number,
): Promise<string | null> {
  const questionId = body.question_id;
  if (typeof questionId !== "string" || !UUID_RE.test(questionId)) return null;
  const { data, error } = await db
    .from("queries")
    .insert({
      question_id: questionId,
      sql,
      chart: parseChart(body.chart),
      valid: true,
      row_count: rowCount,
      exec_ms: execMs,
      edited_by_user: false,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[data] could not record query", error);
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

async function runSql(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const raw = typeof body.sql === "string" ? body.sql : "";
  if (raw.length > MAX_SQL_CHARS) {
    throw new HttpError(422, `SQL is limited to ${MAX_SQL_CHARS} characters`);
  }
  const sql = raw.trim().replace(/[;\s]+$/, "");
  if (!sql) return json({ error: "Empty SQL" }, 400);

  const problem = checkReadOnlySql(sql);
  if (problem) return json({ error: problem }, 400);

  // Add LIMIT 1000 if none present (the runner also caps rows at 1000).
  const finalSql = hasRowLimit(sql) ? sql : `${sql}\nLIMIT ${ROW_LIMIT}`;

  const started = performance.now();
  const { data, error } = await db.rpc("run_readonly_sql", { query: finalSql });
  const execMs = Math.round(performance.now() - started);

  if (error) return json({ error: sqlErrorMessage(error), exec_ms: execMs }, 400);

  const result = (data ?? {}) as { rows?: unknown; columns?: unknown; truncated?: unknown };
  const rows = (Array.isArray(result.rows) ? result.rows : []) as Record<string, unknown>[];
  const columns = Array.isArray(result.columns)
    ? (result.columns as string[])
    : rows.length
      ? Object.keys(rows[0])
      : [];

  const queryId = await recordQuery(db, body, finalSql, rows.length, execMs);

  return json({
    rows,
    columns,
    row_count: rows.length,
    exec_ms: execMs,
    sql: finalSql,
    truncated: result.truncated === true,
    query_id: queryId,
  });
}
