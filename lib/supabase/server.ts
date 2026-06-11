import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DiplomacyClient = SupabaseClient<any, any, "diplomacy", any, any>;

// Server-side client. Falls back to the anon key when no service role key is
// configured (identity checks are done with Clerk before any write).
export function getSupabaseServer(): DiplomacyClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: "diplomacy" },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
