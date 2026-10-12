// Shared HTTP helpers for edge functions: CORS, JSON responses, bounded body
// parsing, typed errors and a request wrapper that never leaks internals.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// An error whose message is safe to show to the client.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The daily cap for paid upstream calls is used up. Never retried.
export class DailyLimitError extends Error {}

// The usage counter could not be read; fail closed.
export class UsageUnavailableError extends Error {}

// A paid upstream API (TypeSafe, OpenAI) failed. Details are logged, not returned.
export class UpstreamError extends Error {
  constructor(public service: string, public status: number) {
    super(`${service} request failed (${status})`);
  }
}

// Service-role client built only from env. Returns null when either variable
// is missing so callers can answer 503 instead of creating a broken client.
export function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Read and parse a JSON object body, rejecting anything over maxBytes with 413
// before it is fully buffered.
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ body: Record<string, unknown>; size: number }> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }
  if (!req.body) throw new HttpError(400, "Request body is required");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return { body: parsed as Record<string, unknown>, size };
}

// Deno.serve wrapper: CORS preflight, POST only, 503 when the service-role
// env is missing, and error mapping (429 daily_limit, 503 counter down,
// 502 upstream, generic 500) with details kept in server logs.
export function serve(
  name: string,
  handler: (req: Request, db: SupabaseClient) => Promise<Response>,
): void {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const db = serviceClient();
    if (!db) {
      console.error(`[${name}] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set`);
      return json({ error: "Service unavailable" }, 503);
    }

    try {
      return await handler(req, db);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof DailyLimitError) return json({ error: "daily_limit" }, 429);
      if (err instanceof UsageUnavailableError) return json({ error: "Service unavailable" }, 503);
      if (err instanceof UpstreamError) {
        return json({ error: `The ${err.service} service is unavailable right now` }, 502);
      }
      console.error(`[${name}] unhandled error`, err);
      return json({ error: "Internal error" }, 500);
    }
  });
}
