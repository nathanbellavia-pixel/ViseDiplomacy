import { notFound, redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Room, RoomPlayer } from "@/lib/types";
import Lobby from "./lobby";

export const dynamic = "force-dynamic";

export default async function RoomPage({
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

  const { data: playersData } = await supabase
    .from("room_players")
    .select()
    .eq("room_id", id)
    .order("joined_at");
  let players = (playersData ?? []) as RoomPlayer[];

  // Members of a running game go straight to the board.
  const isMember = players.some((p) => p.user_id === user.id);
  if (isMember && room.status === "active") redirect(`/rooms/${id}/game`);
  if (!isMember && room.status === "waiting" && players.length < room.max_players) {
    const displayName =
      user.firstName ??
      user.username ??
      user.emailAddresses[0]?.emailAddress.split("@")[0] ??
      "Joueur";
    const { data: inserted } = await supabase
      .from("room_players")
      .insert({
        room_id: id,
        user_id: user.id,
        display_name: displayName,
        avatar_url: user.imageUrl ?? null,
      })
      .select()
      .single();
    if (inserted) players = [...players, inserted as RoomPlayer];
  } else if (!isMember && room.status !== "waiting") {
    return (
      <div className="glass mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold">Partie en cours</h1>
        <p className="mt-2 text-stone-400">
          Cette partie a déjà commencé sans vous. Retournez au salon pour en
          rejoindre une autre.
        </p>
      </div>
    );
  }

  return <Lobby initialRoom={room} initialPlayers={players} userId={user.id} />;
}
