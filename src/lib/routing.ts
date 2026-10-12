// The routing policy lives in supabase/functions/_shared/routing.ts so the
// jev-route Edge Function can record the exact decision the UI shows.
export { defaultChartFor, route } from "../../supabase/functions/_shared/routing.ts";
export type { ColRef, RouteResult } from "../../supabase/functions/_shared/routing.ts";
