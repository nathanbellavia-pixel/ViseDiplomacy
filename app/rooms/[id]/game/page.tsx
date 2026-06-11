import { notFound, redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Order, Phase, Room, RoomPlayer, Territory } from "@/lib/types";
import GameBoard from "./game-board";

export const dynamic = "force-dynamic";

export default async function GamePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const supabase = getSupabaseServer();
  const { data: roomData } = await supabase
    .from("rooms")
    .select()
    .eq("id", id)
    .maybeSingle();
  if (!roomData) notFound();
  const room = roomData as Room;
  if (room.status === "waiting") redirect(`/rooms/${id}`);

  const [{ data: players }, { data: phase }, { data: territories }] =
    await Promise.all([
      supabase.from("room_players").select().eq("room_id", id).order("joined_at"),
      supabase
        .from("phases")
        .select()
        .eq("room_id", id)
        .eq("status", "active")
        .order("phase_number", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("territories").select().eq("room_id", id).order("code"),
    ]);

  const me = ((players ?? []) as RoomPlayer[]).find((p) => p.user_id === user.id);
  if (!me) redirect(`/rooms/${id}`);
  if (!phase) redirect(`/rooms/${id}`);

  const { data: myOrders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", (phase as Phase).id)
    .eq("player_id", me.id)
    .eq("is_submitted", true);

  return (
    <GameBoard
      initialRoom={room}
      initialPhase={phase as Phase}
      initialPlayers={(players ?? []) as RoomPlayer[]}
      initialTerritories={(territories ?? []) as Territory[]}
      initialMyOrders={(myOrders ?? []) as Order[]}
      me={me}
    />
  );
}
