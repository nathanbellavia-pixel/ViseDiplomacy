"use server";

import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";
import { NATIONS, type Nation, type Phase, type Room, type RoomPlayer } from "@/lib/types";
import { buildInitialTerritories } from "@/lib/game/setup";
import { submitBotOrders } from "@/lib/game/resolve";

export interface ActionState {
  error?: string;
}

// Alphabet without ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

async function getIdentity() {
  const user = await currentUser();
  if (!user) redirect("/");
  const displayName =
    user.firstName ??
    user.username ??
    user.emailAddresses[0]?.emailAddress.split("@")[0] ??
    "Joueur";
  return { userId: user.id, displayName, avatarUrl: user.imageUrl ?? null };
}

export async function createRoom(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { userId, displayName, avatarUrl } = await getIdentity();
  const supabase = getSupabaseServer();

  const name = String(formData.get("name") ?? "").trim();
  const isPublic = formData.get("visibility") !== "private";
  const totalPhases = Number(formData.get("total_phases"));
  const phaseDuration = Number(formData.get("phase_duration"));

  if (!name || name.length > 60) {
    return { error: "Le nom de la partie doit faire entre 1 et 60 caractères." };
  }
  if (!Number.isInteger(totalPhases) || totalPhases < 10 || totalPhases > 80) {
    return { error: "Le nombre de phases doit être compris entre 10 et 80." };
  }
  if (!Number.isInteger(phaseDuration) || phaseDuration < 1 || phaseDuration > 10) {
    return { error: "La durée d'une phase doit être comprise entre 1 et 10 minutes." };
  }

  let room: Room | null = null;
  // Retry a few times in the (unlikely) event of a join-code collision.
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    const { data, error } = await supabase
      .from("rooms")
      .insert({
        code: generateCode(),
        name,
        host_id: userId,
        is_public: isPublic,
        total_phases: totalPhases,
        phase_duration_minutes: phaseDuration,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") continue;
      return { error: "Impossible de créer la partie. Réessayez." };
    }
    room = data as Room;
  }
  if (!room) return { error: "Impossible de générer un code de partie. Réessayez." };

  const { error: playerError } = await supabase.from("room_players").insert({
    room_id: room.id,
    user_id: userId,
    display_name: displayName,
    avatar_url: avatarUrl,
    is_host: true,
  });
  if (playerError) {
    return { error: "Partie créée mais impossible de vous y inscrire. Réessayez." };
  }

  redirect(`/rooms/${room.id}`);
}

async function joinRoomRow(room: Room): Promise<ActionState | null> {
  const { userId, displayName, avatarUrl } = await getIdentity();
  const supabase = getSupabaseServer();

  const { data: existing } = await supabase
    .from("room_players")
    .select("id")
    .eq("room_id", room.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return null; // already a member, just enter the lobby

  if (room.status !== "waiting") {
    return { error: "Cette partie a déjà commencé." };
  }

  const { count } = await supabase
    .from("room_players")
    .select("id", { count: "exact", head: true })
    .eq("room_id", room.id);
  if ((count ?? 0) >= room.max_players) {
    return { error: "Cette partie est complète." };
  }

  const { error } = await supabase.from("room_players").insert({
    room_id: room.id,
    user_id: userId,
    display_name: displayName,
    avatar_url: avatarUrl,
  });
  // 23505 = someone double-clicked join; they are in the room, carry on.
  if (error && error.code !== "23505") {
    return { error: "Impossible de rejoindre la partie. Réessayez." };
  }
  return null;
}

export async function joinByCode(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  if (code.length !== 6) {
    return { error: "Le code doit faire 6 caractères." };
  }

  const supabase = getSupabaseServer();
  const { data: room } = await supabase
    .from("rooms")
    .select()
    .eq("code", code)
    .maybeSingle();
  if (!room) return { error: "Aucune partie avec ce code." };

  const failure = await joinRoomRow(room as Room);
  if (failure) return failure;

  redirect(`/rooms/${(room as Room).id}`);
}

export async function joinRoom(roomId: string): Promise<ActionState> {
  const supabase = getSupabaseServer();
  const { data: room } = await supabase
    .from("rooms")
    .select()
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Cette partie n'existe plus." };

  const failure = await joinRoomRow(room as Room);
  if (failure) return failure;

  redirect(`/rooms/${roomId}`);
}

export async function claimNation(
  roomId: string,
  nation: Nation | null
): Promise<ActionState> {
  const { userId } = await getIdentity();
  if (nation !== null && !NATIONS.includes(nation)) {
    return { error: "Nation inconnue." };
  }

  const supabase = getSupabaseServer();
  const { data: room } = await supabase
    .from("rooms")
    .select("status")
    .eq("id", roomId)
    .maybeSingle();
  if (!room || room.status !== "waiting") {
    return { error: "La partie n'accepte plus de changements." };
  }

  const { error } = await supabase
    .from("room_players")
    .update({ nation })
    .eq("room_id", roomId)
    .eq("user_id", userId);
  if (error) {
    return error.code === "23505"
      ? { error: "Cette nation est déjà prise." }
      : { error: "Impossible de choisir cette nation. Réessayez." };
  }
  return {};
}

export async function startGame(roomId: string): Promise<ActionState> {
  const { userId } = await getIdentity();
  const supabase = getSupabaseServer();

  const { data: room } = await supabase
    .from("rooms")
    .select()
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Cette partie n'existe plus." };
  const typedRoom = room as Room;
  if (typedRoom.host_id !== userId) {
    return { error: "Seul l'hôte peut lancer la partie." };
  }
  if (typedRoom.status !== "waiting") {
    return { error: "La partie est déjà lancée." };
  }

  const { data: playersData } = await supabase
    .from("room_players")
    .select()
    .eq("room_id", roomId);
  const players = (playersData ?? []) as RoomPlayer[];

  const taken = new Set(players.map((p) => p.nation).filter(Boolean));
  const available = NATIONS.filter((n) => !taken.has(n)).sort(
    () => Math.random() - 0.5
  );

  // Humans without a nation get one at random, leftovers go to bots.
  for (const player of players.filter((p) => !p.nation)) {
    const nation = available.shift();
    if (!nation) break;
    const { error } = await supabase
      .from("room_players")
      .update({ nation })
      .eq("id", player.id);
    if (error) return { error: "Impossible d'attribuer les nations. Réessayez." };
  }

  if (available.length > 0) {
    const bots = available.map((nation) => ({
      room_id: roomId,
      user_id: null,
      display_name: `Bot ${nation}`,
      nation,
      is_bot: true,
    }));
    const { error } = await supabase.from("room_players").insert(bots);
    if (error) return { error: "Impossible de créer les bots. Réessayez." };
  }

  // Seed the board with the classic 1901 starting positions
  const { error: territoryError } = await supabase
    .from("territories")
    .insert(buildInitialTerritories().map((t) => ({ ...t, room_id: roomId })));
  if (territoryError) {
    return { error: "Impossible d'initialiser le plateau." };
  }

  const now = new Date();
  const { data: phase, error: phaseError } = await supabase
    .from("phases")
    .insert({
      room_id: roomId,
      phase_number: 1,
      year: 1901,
      season: "spring",
      type: "movement",
      status: "active",
      starts_at: now.toISOString(),
      ends_at: new Date(
        now.getTime() + typedRoom.phase_duration_minutes * 60_000
      ).toISOString(),
    })
    .select()
    .single();
  if (phaseError || !phase) return { error: "Impossible de créer la première phase." };

  // bot powers play from the very first phase
  await submitBotOrders(roomId, phase as Phase);

  const { error: roomError } = await supabase
    .from("rooms")
    .update({
      status: "active",
      current_phase: 1,
      started_at: now.toISOString(),
    })
    .eq("id", roomId)
    .eq("status", "waiting");
  if (roomError) return { error: "Impossible de lancer la partie. Réessayez." };

  return {};
}
