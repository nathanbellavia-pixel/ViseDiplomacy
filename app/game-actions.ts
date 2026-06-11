"use server";

import { currentUser } from "@clerk/nextjs/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Phase, Room, RoomPlayer, Territory } from "@/lib/types";
import {
  buildSlots,
  moveTargets,
  supplyCenterCount,
  supportDestinations,
  unitCount,
  unitsOnBoard,
} from "@/lib/game/logic";
import { HOME_SCS } from "@/lib/game/setup";
import { maybeResolve } from "@/lib/game/resolve";

export interface ActionState {
  error?: string;
}

// Client-side order shape; everything is re-validated server-side.
export interface LocalOrder {
  prov: string;
  type: "hold" | "move" | "support-hold" | "support-move";
  target?: string;
  targetCoast?: string | null;
  aux?: string;
}

interface GameContext {
  room: Room;
  phase: Phase;
  me: RoomPlayer;
  territories: Territory[];
}

async function loadGame(roomId: string): Promise<GameContext | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: "Non connecté." };
  const supabase = getSupabaseServer();

  const [{ data: room }, { data: phase }, { data: me }, { data: territories }] =
    await Promise.all([
      supabase.from("rooms").select().eq("id", roomId).maybeSingle(),
      supabase
        .from("phases")
        .select()
        .eq("room_id", roomId)
        .eq("status", "active")
        .order("phase_number", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("room_players")
        .select()
        .eq("room_id", roomId)
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase.from("territories").select().eq("room_id", roomId),
    ]);

  if (!room || (room as Room).status !== "active")
    return { error: "La partie n'est pas active." };
  if (!phase) return { error: "Aucune phase active." };
  if (!me) return { error: "Vous n'êtes pas dans cette partie." };
  const typedMe = me as RoomPlayer;
  if (typedMe.is_eliminated) return { error: "Vous êtes éliminé (spectateur)." };
  if (!typedMe.nation) return { error: "Aucune nation attribuée." };

  return {
    room: room as Room,
    phase: phase as Phase,
    me: typedMe,
    territories: (territories ?? []) as Territory[],
  };
}

export async function submitOrders(
  roomId: string,
  orders: LocalOrder[]
): Promise<ActionState> {
  const ctx = await loadGame(roomId);
  if ("error" in ctx) return ctx;
  const { phase, me, territories } = ctx;
  if (phase.type !== "movement")
    return { error: "Les ordres de mouvement ne sont pas ouverts." };

  const supabase = getSupabaseServer();
  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("phase_id", phase.id)
    .eq("player_id", me.id)
    .eq("is_submitted", true)
    .limit(1);
  if (existing && existing.length > 0)
    return { error: "Vos ordres sont déjà validés." };

  const units = unitsOnBoard(territories).filter((u) => u.nation === me.nation);
  const unitByProv = new Map(units.map((u) => [u.prov, u]));
  const allUnits = unitsOnBoard(territories);
  const unitAt = new Map(allUnits.map((u) => [u.prov, u]));

  const rows: Record<string, unknown>[] = [];
  const ordered = new Set<string>();
  for (const o of orders) {
    const unit = unitByProv.get(o.prov);
    if (!unit) return { error: `Aucune de vos unités en ${o.prov}.` };
    if (ordered.has(o.prov)) return { error: `Deux ordres pour ${o.prov}.` };
    ordered.add(o.prov);

    const base = {
      room_id: roomId,
      phase_id: phase.id,
      player_id: me.id,
      nation: me.nation,
      unit_type: unit.unit,
      unit_territory: unit.prov,
      status: "submitted",
      is_submitted: true,
    };

    if (o.type === "hold") {
      rows.push({ ...base, order_type: "hold" });
    } else if (o.type === "move") {
      if (!o.target) return { error: "Cible de mouvement manquante." };
      const valid = moveTargets(unit).some(
        (t) => t.prov === o.target && (t.coast ?? null) === (o.targetCoast ?? null)
      );
      // fleets moving to a split-coast province must specify a legal coast
      if (!valid) return { error: `Mouvement illégal: ${o.prov} → ${o.target}.` };
      rows.push({
        ...base,
        order_type: "move",
        target_territory: o.targetCoast ? `${o.target}/${o.targetCoast}` : o.target,
      });
    } else {
      if (!o.aux) return { error: "Unité soutenue manquante." };
      const supported = unitAt.get(o.aux);
      if (!supported) return { error: `Aucune unité à soutenir en ${o.aux}.` };
      const dest = supportDestinations(unit, supported);
      if (o.type === "support-hold") {
        if (!dest.canSupportHold)
          return { error: `Soutien défensif illégal: ${o.prov} S ${o.aux}.` };
        rows.push({
          ...base,
          order_type: "support",
          aux_territory: o.aux,
          target_territory: o.aux,
        });
      } else {
        if (!o.target || !dest.moveDestinations.includes(o.target))
          return {
            error: `Soutien offensif illégal: ${o.prov} S ${o.aux} → ${o.target}.`,
          };
        rows.push({
          ...base,
          order_type: "support",
          aux_territory: o.aux,
          target_territory: o.target,
        });
      }
    }
  }

  // unordered units hold by default
  for (const u of units) {
    if (!ordered.has(u.prov)) {
      rows.push({
        room_id: roomId,
        phase_id: phase.id,
        player_id: me.id,
        nation: me.nation,
        unit_type: u.unit,
        unit_territory: u.prov,
        order_type: "hold",
        status: "submitted",
        is_submitted: true,
      });
    }
  }

  await supabase
    .from("orders")
    .delete()
    .eq("phase_id", phase.id)
    .eq("player_id", me.id);
  const { error } = await supabase.from("orders").insert(rows);
  if (error) return { error: "Impossible d'enregistrer les ordres. Réessayez." };
  await maybeResolve(roomId); // fires when every human has submitted
  return {};
}

export async function submitRetreats(
  roomId: string,
  retreats: { prov: string; to: string | null }[]
): Promise<ActionState> {
  const ctx = await loadGame(roomId);
  if ("error" in ctx) return ctx;
  const { phase, me } = ctx;
  if (phase.type !== "retreat")
    return { error: "Ce n'est pas une phase de retraite." };

  const mine = (phase.summary?.dislodged ?? []).filter(
    (d) => d.nation === me.nation
  );
  if (mine.length === 0) return { error: "Aucune retraite à ordonner." };

  const supabase = getSupabaseServer();
  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("phase_id", phase.id)
    .eq("player_id", me.id)
    .eq("is_submitted", true)
    .limit(1);
  if (existing && existing.length > 0)
    return { error: "Vos retraites sont déjà validées." };

  const rows: Record<string, unknown>[] = [];
  for (const d of mine) {
    const wanted = retreats.find((r) => r.prov === d.prov);
    const to =
      wanted?.to && d.options.includes(wanted.to) ? wanted.to : null;
    rows.push({
      room_id: roomId,
      phase_id: phase.id,
      player_id: me.id,
      nation: me.nation,
      unit_type: d.unit,
      unit_territory: d.prov,
      order_type: to ? "retreat" : "disband",
      target_territory: to,
      status: "submitted",
      is_submitted: true,
    });
  }
  await supabase
    .from("orders")
    .delete()
    .eq("phase_id", phase.id)
    .eq("player_id", me.id);
  const { error } = await supabase.from("orders").insert(rows);
  if (error) return { error: "Impossible d'enregistrer les retraites." };
  await maybeResolve(roomId);
  return {};
}

export async function submitAdjustments(
  roomId: string,
  builds: { prov: string; unit: "army" | "fleet"; coast?: string | null }[],
  disbands: string[]
): Promise<ActionState> {
  const ctx = await loadGame(roomId);
  if ("error" in ctx) return ctx;
  const { phase, me, territories } = ctx;
  if (phase.type !== "adjustment")
    return { error: "Ce n'est pas une phase d'ajustement." };

  const supabase = getSupabaseServer();
  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("phase_id", phase.id)
    .eq("player_id", me.id)
    .eq("is_submitted", true)
    .limit(1);
  if (existing && existing.length > 0)
    return { error: "Vos ajustements sont déjà validés." };

  const delta =
    supplyCenterCount(territories, me.nation!) - unitCount(territories, me.nation!);
  const rows: Record<string, unknown>[] = [];

  if (delta > 0) {
    if (disbands.length > 0) return { error: "Vous ne devez pas dissoudre d'unités." };
    if (builds.length > delta)
      return { error: `Au plus ${delta} construction(s) possible(s).` };
    const slots = buildSlots(territories, me.nation!, HOME_SCS[me.nation!]);
    const used = new Set<string>();
    for (const b of builds) {
      const slot = slots.find((s) => s.prov === b.prov);
      if (!slot || used.has(b.prov))
        return { error: `Construction impossible en ${b.prov}.` };
      used.add(b.prov);
      if (b.unit === "fleet" && !slot.allowFleet)
        return { error: `Pas de flotte possible en ${b.prov}.` };
      if (b.unit === "fleet" && slot.coasts && !slot.coasts.includes(b.coast ?? ""))
        return { error: `Côte requise pour la flotte en ${b.prov}.` };
      rows.push({
        room_id: roomId,
        phase_id: phase.id,
        player_id: me.id,
        nation: me.nation,
        unit_type: b.unit,
        unit_territory: b.prov,
        order_type: "build",
        target_territory: b.unit === "fleet" && b.coast ? `${b.prov}/${b.coast}` : null,
        status: "submitted",
        is_submitted: true,
      });
    }
  } else if (delta < 0) {
    if (builds.length > 0) return { error: "Vous ne pouvez pas construire." };
    if (disbands.length !== -delta)
      return { error: `Vous devez dissoudre exactement ${-delta} unité(s).` };
    const myUnits = unitsOnBoard(territories).filter((u) => u.nation === me.nation);
    const seen = new Set<string>();
    for (const prov of disbands) {
      const unit = myUnits.find((u) => u.prov === prov);
      if (!unit || seen.has(prov))
        return { error: `Dissolution impossible en ${prov}.` };
      seen.add(prov);
      rows.push({
        room_id: roomId,
        phase_id: phase.id,
        player_id: me.id,
        nation: me.nation,
        unit_type: unit.unit,
        unit_territory: prov,
        order_type: "disband",
        status: "submitted",
        is_submitted: true,
      });
    }
  } else if (builds.length > 0 || disbands.length > 0) {
    return { error: "Aucun ajustement nécessaire." };
  }

  await supabase
    .from("orders")
    .delete()
    .eq("phase_id", phase.id)
    .eq("player_id", me.id);
  if (rows.length > 0) {
    const { error } = await supabase.from("orders").insert(rows);
    if (error) return { error: "Impossible d'enregistrer les ajustements." };
  }
  await maybeResolve(roomId);
  return {};
}


export async function sendMessage(
  roomId: string,
  recipientPlayerId: string,
  content: string
): Promise<ActionState> {
  const user = await currentUser();
  if (!user) return { error: "Non connecté." };
  const text = content.trim();
  if (!text || text.length > 2000) return { error: "Message invalide." };

  const supabase = getSupabaseServer();
  const [{ data: me }, { data: recipient }] = await Promise.all([
    supabase
      .from("room_players")
      .select()
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("room_players")
      .select()
      .eq("room_id", roomId)
      .eq("id", recipientPlayerId)
      .maybeSingle(),
  ]);
  if (!me) return { error: "Vous n'êtes pas dans cette partie." };
  const typedRecipient = recipient as RoomPlayer | null;
  if (!typedRecipient || typedRecipient.is_bot)
    return { error: "Destinataire introuvable." };
  if (typedRecipient.id === (me as RoomPlayer).id)
    return { error: "Vous ne pouvez pas vous écrire à vous-même." };

  const { error } = await supabase.from("private_messages").insert({
    room_id: roomId,
    sender_player_id: (me as RoomPlayer).id,
    recipient_player_id: typedRecipient.id,
    sender_user_id: user.id,
    recipient_user_id: typedRecipient.user_id,
    content: text,
  });
  if (error) return { error: "Message non envoyé. Réessayez." };
  return {};
}
