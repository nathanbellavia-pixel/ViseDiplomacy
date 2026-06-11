// Daily safety net (Vercel Cron, once a day): force-resolve phases whose
// deadline passed more than 30 minutes ago and that nobody resolved — e.g.
// every player closed their browser. The PRIMARY deadline trigger is each
// client POSTing /api/resolve-phase when its countdown reaches zero.
import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { resolveIfExpired } from "@/lib/game/resolve";

export const dynamic = "force-dynamic";

const GRACE_MS = 30 * 60_000;

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
    .lt("ends_at", new Date(Date.now() - GRACE_MS).toISOString());
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
