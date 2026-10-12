// Daily cap on paid upstream calls (TypeSafe/Jev, OpenAI), counted per fetch.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { DailyLimitError, UpstreamError, UsageUnavailableError } from "./http.ts";

const DEFAULT_DAILY_CALL_LIMIT = 200;
const MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

function dailyLimit(): number {
  const raw = (Deno.env.get("DAILY_CALL_LIMIT") ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_DAILY_CALL_LIMIT;
}

// Atomically count one call for `fn` today via the SECURITY DEFINER
// increment_usage_counter RPC. Fails closed: an RPC error or a null /
// non-integer result throws UsageUnavailableError (503), and a count over the
// cap throws DailyLimitError (429).
export async function countCall(db: SupabaseClient, fn: string): Promise<number> {
  let data: unknown = null;
  let error: unknown = null;
  try {
    ({ data, error } = await db.rpc("increment_usage_counter", { p_fn: fn }));
  } catch (err) {
    error = err;
  }
  if (error) {
    console.error(`[usage] counter RPC failed for ${fn}`, error);
    throw new UsageUnavailableError();
  }
  if (typeof data !== "number" || !Number.isInteger(data) || data < 1) {
    console.error(`[usage] counter returned a non-integer for ${fn}`, data);
    throw new UsageUnavailableError();
  }
  if (data > dailyLimit()) throw new DailyLimitError();
  return data;
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 2 ** attempt * 250));
}

export interface PaidService {
  counter: string; // usage_counters.fn key
  name: string; // shown to the client on failure
}

// fetch() for paid upstream APIs. Every attempt is counted right before it is
// sent; a daily limit is never retried. Retries only on 429/529 or a network
// error (including timeout), at most MAX_ATTEMPTS in total.
export async function paidFetch(
  db: SupabaseClient,
  service: PaidService,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    await countCall(db, service.counter);
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      console.error(`[${service.counter}] ${service.name} network error`, err);
      throw new UpstreamError(service.name, 0);
    }
    if ((res.status === 429 || res.status === 529) && attempt < MAX_ATTEMPTS) {
      await res.body?.cancel().catch(() => {});
      await backoff(attempt);
      continue;
    }
    return res;
  }
}
