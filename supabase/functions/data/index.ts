// "data" edge function: schema introspection, CSV upload, validated SQL run.
import { handleWithUsage, json, serviceClient } from "../_shared/usage.ts";

const ALLOWED_SCHEMAS = new Set(["demo", "uploads"]);
const BLOCKED_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|analyze|call|do|set|reset|listen|notify|comment|lock|reindex|refresh|import|export)\b/i;

interface SchemaCol {
  column: string;
  type: string;
  samples: (string | number | boolean | null)[];
}

interface SchemaTable {
  table: string; // qualified: demo.orders
  columns: SchemaCol[];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\.[^.]*$/, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "upload"
  );
}

function inferType(values: unknown[]): string {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonEmpty.length === 0) return "text";
  const allBool = nonEmpty.every((v) => v === "true" || v === "false" || v === true || v === false);
  if (allBool) return "boolean";
  const allInt = nonEmpty.every((v) => /^-?\d+$/.test(String(v)));
  if (allInt) return "bigint";
  const allNum = nonEmpty.every((v) => !isNaN(Number(v)));
  if (allNum) return "numeric";
  const allDate = nonEmpty.every(
    (v) => !isNaN(Date.parse(String(v))) && /\d{4}-\d{2}-\d{2}/.test(String(v)),
  );
  if (allDate) return "date";
  return "text";
}

Deno.serve(async (req: Request) => {
  return handleWithUsage(req, "data", async () => {
    const { action } = await req.json();

    if (action === "schema") {
      return await getSchema();
    }
    if (action === "upload") {
      return await uploadCsv(await req.json());
    }
    if (action === "run") {
      return await runSql(await req.json());
    }
    return json({ error: `Unknown action: ${action}` }, 400);
  });
});

async function getSchema(): Promise<Response> {
  const supabase = serviceClient();
  const { data, error } = await supabase.rpc("exec_sql", {
    query: `
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema IN ('demo', 'uploads')
      ORDER BY table_schema, table_name, ordinal_position
    `,
  });
  if (error) return json({ error: error.message }, 500);

  // Sample values: cheap approach - read a few rows per table via PostgREST.
  const tables = new Map<string, SchemaTable>();
  for (const row of data as Record<string, string>[]) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!tables.has(key)) tables.set(key, { table: key, columns: [] });
    tables.get(key)!.columns.push({ column: row.column_name, type: row.data_type, samples: [] });
  }

  for (const [key, tbl] of tables) {
    const [schema, name] = key.split(".");
    const { data: rows } = await supabase.schema(schema).from(name).select("*").limit(3);
    if (rows && rows.length) {
      for (const col of tbl.columns) {
        col.samples = rows
          .slice(0, 3)
          .map((r: Record<string, unknown>) => r[col.column] ?? null);
      }
    }
  }

  return json({ tables: Array.from(tables.values()) });
}

async function uploadCsv(body: Record<string, unknown>): Promise<Response> {
  const supabase = serviceClient();
  const name = String(body.name ?? "upload");
  const rows = body.rows as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) return json({ error: "No rows provided" }, 400);
  if (rows.length > 50000) return json({ error: "CSV exceeds 50,000 row limit" }, 400);
  const serialized = JSON.stringify(rows);
  if (serialized.length > 5 * 1024 * 1024)
    return json({ error: "CSV exceeds 5 MB limit" }, 400);

  const tableName = slugify(name);
  const colNames = Object.keys(rows[0]);
  if (colNames.length === 0) return json({ error: "CSV has no columns" }, 400);

  // Build typed DDL
  const colDefs = colNames
    .map((c) => {
      const col = slugify(c) || "col";
      const t = inferType(rows.map((r) => r[c]));
      return `${JSON.stringify(col)} ${t}`;
    })
    .join(", ");

  const ddl = `CREATE SCHEMA IF NOT EXISTS uploads;
CREATE TABLE IF NOT EXISTS uploads.${JSON.stringify(tableName)} (${colDefs});`;

  // Create the table via a helper function; we use exec_sql RPC if present,
  // otherwise fall back to direct SQL via service role with the REST DDL endpoint.
  const { error: ddlErr } = await supabase.rpc("exec_sql", { query: ddl });
  if (ddlErr) return json({ error: `Failed to create table: ${ddlErr.message}` }, 500);

  // Insert rows in chunks
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of colNames) {
        out[slugify(c)] =
          r[c] === "" || r[c] === undefined ? null : r[c];
      }
      return out;
    });
    const { error: insErr } = await supabase.schema("uploads").from(tableName).insert(chunk);
    if (insErr) return json({ error: `Failed to insert rows: ${insErr.message}` }, 500);
  }

  return json({ table: `uploads.${tableName}`, rows: rows.length, columns: colNames.map(slugify) });
}

async function runSql(body: Record<string, unknown>): Promise<Response> {
  const supabase = serviceClient();
  const sql = String(body.sql ?? "").trim().replace(/;+\s*$/, "");
  if (!sql) return json({ error: "Empty SQL" }, 400);

  // Single statement only: reject chained statements.
  if (/;\s*\S/.test(sql))
    return json({ error: "Only a single SQL statement is allowed" }, 400);

  // Must be SELECT or WITH ... SELECT
  const isSelect = /^select\b/i.test(sql);
  const isWithSelect = /^with\b[\s\S]*\bselect\b/i.test(sql);
  if (!isSelect && !isWithSelect)
    return json({ error: "Only SELECT or WITH ... SELECT statements are allowed" }, 400);

  if (BLOCKED_KEYWORDS.test(sql))
    return json({ error: "Write and DDL statements are not allowed" }, 400);

  // Add LIMIT 1000 if none present (simple heuristic: top-level limit)
  let finalSql = sql;
  if (!/\blimit\s+\d+/i.test(sql)) {
    finalSql = `${sql}\nLIMIT 1000`;
  }

  const started = performance.now();
  const { data, error } = await supabase.rpc("run_readonly_sql", { query: finalSql });
  const execMs = Math.round(performance.now() - started);

  if (error) return json({ error: error.message, exec_ms: execMs }, 400);

  const result = data as { rows: Record<string, unknown>[]; columns: string[] };
  return json({
    rows: result.rows ?? [],
    columns: result.columns ?? [],
    row_count: (result.rows ?? []).length,
    exec_ms: execMs,
    sql: finalSql,
  });
}
