// Primary deadline trigger: each game client POSTs here once when its
// countdown reaches zero. Resolution is idempotent (the phase is claimed
// atomically), so simultaneous calls from several clients are safe.
//
// The header token only deters arbitrary external calls — it ships to the
// browser via NEXT_PUBLIC, it is not a real secret.
import { NextResponse } from "next/server";
import { resolveIfExpired } from "@/lib/game/resolve";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = process.env.NEXT_PUBLIC_RESOLVE_TOKEN;
  if (token && req.headers.get("x-resolve-token") !== token) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let roomId: unknown;
  try {
    ({ roomId } = await req.json());
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  if (typeof roomId !== "string" || !/^[0-9a-f-]{36}$/.test(roomId)) {
    return new NextResponse("bad request", { status: 400 });
  }

  await resolveIfExpired(roomId);
  return NextResponse.json({ ok: true });
}
