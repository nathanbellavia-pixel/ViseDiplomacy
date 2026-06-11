// Server-side deadline trigger: Vercel Cron hits this every minute and any
// active phase past its deadline resolves (clients also fire expirePhase as
// they watch the countdown, so this is the backstop, not the only path).
import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { resolveIfExpired } from "@/lib/game/resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const supabase = getSupabaseServer();
  const { data } = await supabase
    .from("phases")
    .select("room_id")
    .eq("status", "active")
    .lt("ends_at", new Date().toISOString());
  const roomIds = [...new Set((data ?? []).map((r) => r.room_id as string))];

  const errors: string[] = [];
  for (const id of roomIds) {
    try {
      await resolveIfExpired(id);
    } catch (err) {
      errors.push(id);
      console.error("[cron/resolve]", id, err);
    }
  }
  return NextResponse.json({ checked: roomIds.length, errors });
}
