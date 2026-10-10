// Shared helpers for edge functions: CORS, service-role client, usage limits.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  return null;
}

export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

const DEFAULT_DAILY_CALL_LIMIT = 200;

// Atomically increment today's counter via a SECURITY DEFINER function and
// check against the limit. Returns { ok, calls }. On error, fail closed
// (ok=false) so the caller returns 503 instead of proceeding.
export async function checkAndIncrementUsage(fn: string): Promise<{ ok: boolean; calls: number }> {
  const supabase = serviceClient();
  const limit = parseInt(Deno.env.get("DAILY_CALL_LIMIT") ?? "", 10) || DEFAULT_DAILY_CALL_LIMIT;

  const { data, error } = await supabase.rpc("increment_usage_counter", { p_fn: fn });

  if (error) {
    // Fail closed: deny the request rather than allowing it through.
    return { ok: false, calls: 0 };
  }

  const calls = (data as number) ?? 0;
  return { ok: calls <= limit, calls };
}

export async function handleWithUsage(
  req: Request,
  fn: string,
  work: () => Promise<Response>,
): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  try {
    const usage = await checkAndIncrementUsage(fn);
    if (!usage.ok) {
      // Distinguish "over limit" (429) from "counter error" (503 fail-closed)
      return json(
        { error: usage.calls > 0 ? "Daily demo limit reached" : "Usage counter unavailable" },
        usage.calls > 0 ? 429 : 503,
      );
    }
    return await work();
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
