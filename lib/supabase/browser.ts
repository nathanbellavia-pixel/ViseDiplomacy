"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DiplomacyClient = SupabaseClient<any, any, "diplomacy", any, any>;

let client: DiplomacyClient | null = null;

// All game tables live in the "diplomacy" Postgres schema.
export function getSupabaseBrowser(): DiplomacyClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { db: { schema: "diplomacy" } }
    );
  }
  return client;
}
