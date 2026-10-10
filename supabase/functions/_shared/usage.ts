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

// Increment today's counter for the function; return { ok, calls }.
// ok=false means the daily demo limit is reached and the caller should 429.
export async function checkAndIncrementUsage(fn: string): Promise<{ ok: boolean; calls: number }> {
  const supabase = serviceClient();
  const limit = parseInt(Deno.env.get("DAILY_CALL_LIMIT") ?? "", 10) || DEFAULT_DAILY_CALL_LIMIT;
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("usage_counters")
    .select("calls")
    .eq("day", today)
    .eq("fn", fn)
    .maybeSingle();

  const current = error ? 0 : (data?.calls ?? 0);
  if (current >= limit) return { ok: false, calls: current };

  const { error: upErr } = await supabase
    .from("usage_counters")
    .upsert({ day: today, fn, calls: current + 1 }, { onConflict: "day,fn" });

  if (upErr) return { ok: true, calls: current + 1 }; // fail open for demo
  return { ok: true, calls: current + 1 };
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
    if (!usage.ok) return json({ error: "Daily demo limit reached" }, 429);
    return await work();
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
