import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey);

// Calls an Edge Function with the anon key as Bearer token (verify_jwt is on).
// Non-2xx responses carry { error } in the body; surface that message, and
// map the 429 daily cap to the text the UI's limit banner looks for.
export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = (error as { message?: string }).message || `Edge function ${name} failed`;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json();
        if (payload && typeof payload.error === "string") message = payload.error;
      } catch {
        // non-JSON error body: keep the generic message
      }
    }
    if (message === "daily_limit") message = "Daily demo limit reached";
    throw new Error(message);
  }
  return data as T;
}
