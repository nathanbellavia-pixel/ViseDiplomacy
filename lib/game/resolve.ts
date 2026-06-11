// Server-side phase resolution engine.
//
// Entry point: maybeResolve(roomId). It resolves the active phase when every
// human who still has a decision to make has submitted, or when the deadline
// passed — then opens the next phase of the seasonal cycle (movement →
// retreat → movement → retreat → adjustment → next year), auto-submits bot
// orders, and keeps cascading while no human input is required.
//
// Idempotency: a phase is claimed with an atomic active→resolving update;
// concurrent triggers lose the claim and back off.

import { getSupabaseServer } from "@/lib/supabase/server";
import type {
  DislodgedUnit,
  Nation,
  Order,
  Phase,
  PhaseSummary,
  Room,
  RoomPlayer,
  SummaryOrder,
  Territory,
} from "@/lib/types";
import {
  adjudicate,
  validRetreats,
  type AdjOrder,
  type AdjResult,
  type AdjUnit,
} from "./adjudicator";
import { defaultBot, type BotBoard } from "./bots";
import { PROVINCES } from "./map-data";
import { HOME_SCS } from "./setup";
import { buildSlots, supplyCenterCount, unitCount, unitsOnBoard } from "./logic";

const name = (p: string | null | undefined) =>
  p ? (PROVINCES[p.split("/")[0]]?.name ?? p) : "?";

interface Ctx {
  room: Room;
  phase: Phase;
  players: RoomPlayer[];
  territories: Territory[];
  orders: Order[];
}

async function loadCtx(roomId: string): Promise<Ctx | null> {
  const supabase = getSupabaseServer();
  const [{ data: room }, { data: phase }, { data: players }, { data: territories }] =
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
      supabase.from("room_players").select().eq("room_id", roomId),
      supabase.from("territories").select().eq("room_id", roomId),
    ]);
  if (!room || (room as Room).status !== "active" || !phase) return null;
  const { data: orders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", (phase as Phase).id)
    .eq("is_submitted", true);
  return {
    room: room as Room,
    phase: phase as Phase,
    players: (players ?? []) as RoomPlayer[],
    territories: (territories ?? []) as Territory[],
    orders: (orders ?? []) as Order[],
  };
}

// Humans who still owe a decision for this phase.
function pendingHumans(ctx: Ctx): RoomPlayer[] {
  const submitted = new Set(ctx.orders.map((o) => o.player_id));
  const humans = ctx.players.filter(
    (p) => !p.is_bot && !p.is_eliminated && p.nation
  );
  return humans.filter((p) => {
    if (submitted.has(p.id)) return false;
    if (ctx.phase.type === "movement") {
      return unitCount(ctx.territories, p.nation!) > 0;
    }
    if (ctx.phase.type === "retreat") {
      return (ctx.phase.summary?.dislodged ?? []).some((d) => d.nation === p.nation);
    }
    // adjustment
    return (
      supplyCenterCount(ctx.territories, p.nation!) !==
      unitCount(ctx.territories, p.nation!)
    );
  });
}

export async function maybeResolve(roomId: string): Promise<void> {
  // cascade through phases that need no human input (e.g. bot-only retreats)
  for (let depth = 0; depth < 8; depth++) {
    const ctx = await loadCtx(roomId);
    if (!ctx) return;
    const expired =
      !!ctx.phase.ends_at && new Date(ctx.phase.ends_at).getTime() <= Date.now();
    if (!expired && pendingHumans(ctx).length > 0) return;

    // claim the phase — only one resolver wins
    const supabase = getSupabaseServer();
    const { data: claimed } = await supabase
      .from("phases")
      .update({ status: "resolving" })
      .eq("id", ctx.phase.id)
      .eq("status", "active")
      .select();
    if (!claimed || claimed.length === 0) return;

    try {
      if (ctx.phase.type === "movement") await resolveMovement(ctx);
      else if (ctx.phase.type === "retreat") await resolveRetreat(ctx);
      else await resolveAdjustment(ctx);
    } catch (err) {
      // release the claim so a later trigger can retry
      await supabase
        .from("phases")
        .update({ status: "active" })
        .eq("id", ctx.phase.id)
        .eq("status", "resolving");
      throw err;
    }
  }
}

// ----------------------------------------------------------------- helpers

function toAdjUnits(territories: Territory[]): AdjUnit[] {
  return unitsOnBoard(territories).map((u) => ({
    prov: u.prov,
    nation: u.nation,
    unit: u.unit,
    coast: u.coast,
  }));
}

function botBoard(nation: Nation, territories: Territory[]): BotBoard {
  return {
    nation,
    units: toAdjUnits(territories),
    scOwners: new Map(
      territories
        .filter((t) => t.is_supply_center)
        .map((t) => [t.code, t.owner_nation])
    ),
    occupied: new Map(
      territories
        .filter((t) => t.occupant_nation)
        .map((t) => [t.code, t.occupant_nation!])
    ),
    homeScs: HOME_SCS[nation],
  };
}

async function setTerritoryUnit(
  roomId: string,
  code: string,
  unit: { nation: Nation; type: "army" | "fleet"; coast: string | null } | null
) {
  const supabase = getSupabaseServer();
  await supabase
    .from("territories")
    .update(
      unit
        ? { occupant_nation: unit.nation, unit_type: unit.type, unit_coast: unit.coast }
        : { occupant_nation: null, unit_type: null, unit_coast: null }
    )
    .eq("room_id", roomId)
    .eq("code", code);
}

async function finishPhase(phase: Phase, summary: PhaseSummary) {
  const supabase = getSupabaseServer();
  await supabase
    .from("phases")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), summary })
    .eq("id", phase.id);
}

async function openPhase(
  room: Room,
  next: Pick<Phase, "phase_number" | "year" | "season" | "type">,
  summary: PhaseSummary | null = null
): Promise<void> {
  const supabase = getSupabaseServer();
  const minutes =
    next.type === "retreat"
      ? Math.max(1, Math.ceil(room.phase_duration_minutes / 2))
      : room.phase_duration_minutes;
  const now = new Date();
  const { data: inserted } = await supabase
    .from("phases")
    .insert({
      room_id: room.id,
      ...next,
      status: "active",
      starts_at: now.toISOString(),
      ends_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      summary,
    })
    .select()
    .single();
  if (next.type === "movement") {
    await supabase
      .from("rooms")
      .update({ current_phase: next.phase_number })
      .eq("id", room.id);
  }
  if (inserted) await submitBotOrders(room.id, inserted as Phase);
}

export async function submitBotOrders(roomId: string, phase: Phase) {
  const supabase = getSupabaseServer();
  const [{ data: players }, { data: territories }] = await Promise.all([
    supabase.from("room_players").select().eq("room_id", roomId),
    supabase.from("territories").select().eq("room_id", roomId),
  ]);
  const bots = ((players ?? []) as RoomPlayer[]).filter(
    (p) => p.is_bot && !p.is_eliminated && p.nation
  );
  const terr = (territories ?? []) as Territory[];
  const rows: Record<string, unknown>[] = [];

  for (const bot of bots) {
    const nation = bot.nation!;
    const board = botBoard(nation, terr);
    const base = { room_id: roomId, phase_id: phase.id, player_id: bot.id, nation };

    if (phase.type === "movement") {
      for (const o of defaultBot.movementOrders(board)) {
        const unit = board.units.find((u) => u.prov === o.prov)!;
        if (o.type === "move") {
          rows.push({
            ...base,
            unit_type: unit.unit,
            unit_territory: o.prov,
            order_type: "move",
            target_territory: o.targetCoast ? `${o.target}/${o.targetCoast}` : o.target,
            status: "submitted",
            is_submitted: true,
          });
        } else if (o.type === "support") {
          rows.push({
            ...base,
            unit_type: unit.unit,
            unit_territory: o.prov,
            order_type: "support",
            aux_territory: o.aux,
            target_territory: o.target,
            status: "submitted",
            is_submitted: true,
          });
        } else {
          rows.push({
            ...base,
            unit_type: unit.unit,
            unit_territory: o.prov,
            order_type: "hold",
            status: "submitted",
            is_submitted: true,
          });
        }
      }
    } else if (phase.type === "retreat") {
      const mine = (phase.summary?.dislodged ?? []).filter((d) => d.nation === nation);
      if (mine.length === 0) continue;
      const orders = defaultBot.retreatOrders(
        board,
        mine.map((d) => ({
          unit: { prov: d.prov, nation: d.nation, unit: d.unit, coast: d.coast },
          attackerFrom: d.attackerFrom,
          options: d.options,
        }))
      );
      for (const o of orders) {
        const d = mine.find((x) => x.prov === o.prov)!;
        rows.push({
          ...base,
          unit_type: d.unit,
          unit_territory: o.prov,
          order_type: o.to ? "retreat" : "disband",
          target_territory: o.to,
          status: "submitted",
          is_submitted: true,
        });
      }
    } else {
      const delta =
        supplyCenterCount(terr, nation) - unitCount(terr, nation);
      if (delta === 0) continue;
      const slots = buildSlots(terr, nation, HOME_SCS[nation]);
      const adj = defaultBot.adjustmentOrders(board, delta, slots);
      for (const b of adj.builds) {
        rows.push({
          ...base,
          unit_type: b.unit,
          unit_territory: b.prov,
          order_type: "build",
          target_territory: b.coast ? `${b.prov}/${b.coast}` : null,
          status: "submitted",
          is_submitted: true,
        });
      }
      for (const prov of adj.disbands) {
        const unit = board.units.find((u) => u.prov === prov);
        rows.push({
          ...base,
          unit_type: unit?.unit ?? "army",
          unit_territory: prov,
          order_type: "disband",
          status: "submitted",
          is_submitted: true,
        });
      }
    }
  }

  if (rows.length > 0) {
    await supabase
      .from("orders")
      .upsert(rows, { onConflict: "phase_id,unit_territory", ignoreDuplicates: true });
  }
}

// ------------------------------------------------------ seasonal transition

// After a movement (or its retreat) phase fully resolves, open what follows.
async function advanceAfter(ctx: Ctx, territoriesNow: Territory[]) {
  const { room, phase } = ctx;
  const supabase = getSupabaseServer();

  if (phase.season === "autumn") {
    // 1. supply centers change hands based on occupation
    for (const t of territoriesNow) {
      if (t.is_supply_center && t.occupant_nation && t.occupant_nation !== t.owner_nation) {
        await supabase
          .from("territories")
          .update({ owner_nation: t.occupant_nation })
          .eq("id", t.id);
        t.owner_nation = t.occupant_nation;
      }
    }
    // 2. eliminations: zero supply centers after fall
    for (const p of ctx.players) {
      if (!p.nation || p.is_eliminated) continue;
      if (supplyCenterCount(territoriesNow, p.nation) === 0) {
        await supabase
          .from("room_players")
          .update({ is_eliminated: true, is_alive: false })
          .eq("id", p.id);
        for (const t of territoriesNow) {
          if (t.occupant_nation === p.nation) {
            await setTerritoryUnit(room.id, t.code, null);
            t.occupant_nation = null;
            t.unit_type = null;
          }
          if (t.owner_nation === p.nation && !t.is_supply_center) {
            await supabase
              .from("territories")
              .update({ owner_nation: null })
              .eq("id", t.id);
            t.owner_nation = null;
          }
        }
      }
    }
  }

  // 3. victory check (17 of 34 supply centers)
  for (const p of ctx.players) {
    if (!p.nation || p.is_eliminated) continue;
    if (supplyCenterCount(territoriesNow, p.nation) >= 17) {
      await endGame(room, p.nation);
      return;
    }
  }

  if (phase.season === "spring") {
    await openPhase(room, {
      phase_number: phase.phase_number + 1,
      year: phase.year,
      season: "autumn",
      type: "movement",
    });
    return;
  }

  // autumn → winter adjustment (same phase number)
  await openPhase(room, {
    phase_number: phase.phase_number,
    year: phase.year,
    season: "winter",
    type: "adjustment",
  });
}

async function endGame(room: Room, winner: Nation | null) {
  const supabase = getSupabaseServer();
  await supabase
    .from("rooms")
    .update({
      status: "finished",
      winner_nation: winner,
      finished_at: new Date().toISOString(),
    })
    .eq("id", room.id);
}

// ---------------------------------------------------------------- movement

const RESULT_TEXT: Record<AdjResult, string> = {
  success: "réussit",
  bounced: "rebondit",
  cut: "soutien coupé",
  dislodged: "délogée",
  invalid: "ordre invalide",
};

async function resolveMovement(ctx: Ctx) {
  const { room, phase, territories } = ctx;
  const supabase = getSupabaseServer();
  const units = toAdjUnits(territories);

  // map order rows to adjudicator orders (auto-hold covers missing ones)
  const adjOrders: AdjOrder[] = [];
  for (const o of ctx.orders) {
    if (o.order_type === "move" && o.target_territory) {
      const [target, coast] = o.target_territory.split("/");
      adjOrders.push({ type: "move", prov: o.unit_territory, target, targetCoast: coast ?? null });
    } else if (o.order_type === "support" && o.aux_territory && o.target_territory) {
      adjOrders.push({
        type: "support",
        prov: o.unit_territory,
        aux: o.aux_territory,
        target: o.target_territory,
      });
    } else {
      adjOrders.push({ type: "hold", prov: o.unit_territory });
    }
  }

  const adj = adjudicate(units, adjOrders);

  // persist per-order results
  for (const o of ctx.orders) {
    const result = adj.results.get(o.unit_territory) ?? "invalid";
    await supabase
      .from("orders")
      .update({ status: "resolved", result: result === "success" ? "success" : result })
      .eq("id", o.id);
  }

  // apply the new board in memory, then write the touched territories
  const terrByCode = new Map(territories.map((t) => [t.code, t]));
  const unitByProv = new Map(units.map((u) => [u.prov, u]));
  const newUnits = new Map<string, { nation: Nation; type: "army" | "fleet"; coast: string | null }>();
  for (const u of units) {
    if (adj.dislodged.has(u.prov)) continue; // off the board, pending retreat
    const mv = adj.moved.get(u.prov);
    const dest = mv ? mv.to : u.prov;
    newUnits.set(dest, {
      nation: u.nation as Nation,
      type: u.unit,
      coast: mv ? mv.coast : u.coast,
    });
  }
  const touched = new Set<string>([
    ...adj.moved.keys(),
    ...[...adj.moved.values()].map((m) => m.to),
    ...adj.dislodged.keys(),
  ]);
  for (const code of touched) {
    await setTerritoryUnit(room.id, code, newUnits.get(code) ?? null);
    const t = terrByCode.get(code)!;
    const nu = newUnits.get(code) ?? null;
    t.occupant_nation = nu?.nation ?? null;
    t.unit_type = nu?.type ?? null;
    t.unit_coast = nu?.coast ?? null;
  }

  // dislodgements & their legal retreats
  const occupiedAfter = new Set(newUnits.keys());
  const dislodged: DislodgedUnit[] = [...adj.dislodged.entries()].map(
    ([prov, attackerFrom]) => {
      const u = unitByProv.get(prov)!;
      return {
        prov,
        nation: u.nation as Nation,
        unit: u.unit,
        coast: u.coast,
        attackerFrom,
        options: validRetreats(u, attackerFrom, occupiedAfter, adj.contested),
      };
    }
  );

  const summaryOrders: SummaryOrder[] = ctx.orders.map((o) => ({
    prov: o.unit_territory,
    nation: o.nation,
    unit: o.unit_type,
    type: o.order_type,
    target: o.target_territory,
    aux: o.aux_territory,
    result: adj.results.get(o.unit_territory) ?? "invalid",
  }));
  const events = summaryOrders.map((o) => {
    const what =
      o.type === "move"
        ? `${name(o.prov)} → ${name(o.target)}`
        : o.type === "support"
          ? `${name(o.prov)} soutient ${name(o.aux)}${o.aux !== o.target ? ` → ${name(o.target)}` : ""}`
          : `${name(o.prov)} tient`;
    return `${o.nation} : ${what} — ${RESULT_TEXT[o.result as AdjResult] ?? o.result}`;
  });
  for (const d of dislodged) {
    events.push(`${d.nation} : unité délogée à ${name(d.prov)} (attaque depuis ${name(d.attackerFrom)})`);
  }

  const summary: PhaseSummary = { events, orders: summaryOrders, dislodged };
  await finishPhase(phase, summary);

  if (dislodged.length > 0) {
    await openPhase(
      room,
      {
        phase_number: phase.phase_number,
        year: phase.year,
        season: phase.season,
        type: "retreat",
      },
      summary // retreat phase carries the dislodgement bookkeeping
    );
    return;
  }
  const fresh = [...terrByCode.values()];
  await advanceAfter(ctx, fresh);
}

// ----------------------------------------------------------------- retreat

async function resolveRetreat(ctx: Ctx) {
  const { room, phase } = ctx;
  const supabase = getSupabaseServer();
  const dislodged = phase.summary?.dislodged ?? [];
  const orderByProv = new Map(ctx.orders.map((o) => [o.unit_territory, o]));

  // destination -> retreating provinces (two retreats to one spot disband both)
  const wanted = new Map<string, string[]>();
  for (const d of dislodged) {
    const o = orderByProv.get(d.prov);
    const to =
      o?.order_type === "retreat" && o.target_territory &&
      d.options.includes(o.target_territory)
        ? o.target_territory
        : null;
    if (to) {
      const prov = to.split("/")[0];
      wanted.set(prov, [...(wanted.get(prov) ?? []), d.prov]);
    }
  }

  const events: string[] = [];
  const summaryOrders: SummaryOrder[] = [];
  for (const d of dislodged) {
    const o = orderByProv.get(d.prov);
    const target =
      o?.order_type === "retreat" && o.target_territory && d.options.includes(o.target_territory)
        ? o.target_territory
        : null;
    const destProv = target?.split("/")[0];
    const collided = destProv ? (wanted.get(destProv) ?? []).length > 1 : false;

    let result: string;
    if (target && !collided) {
      const [prov, coast] = target.split("/");
      await setTerritoryUnit(room.id, prov, {
        nation: d.nation,
        type: d.unit,
        coast: coast ?? null,
      });
      result = "success";
      events.push(`${d.nation} : retraite ${name(d.prov)} → ${name(target)}`);
    } else {
      result = "disbanded";
      events.push(
        collided
          ? `${d.nation} : retraite vers ${name(destProv!)} en collision — unité dissoute`
          : `${d.nation} : unité de ${name(d.prov)} dissoute`
      );
    }
    if (o) {
      await supabase.from("orders").update({ status: "resolved", result }).eq("id", o.id);
    }
    summaryOrders.push({
      prov: d.prov,
      nation: d.nation,
      unit: d.unit,
      type: target ? "retreat" : "disband",
      target,
      aux: null,
      result,
    });
  }

  await finishPhase(phase, { events, orders: summaryOrders, dislodged: [] });

  const { data: territories } = await supabase
    .from("territories")
    .select()
    .eq("room_id", room.id);
  await advanceAfter(ctx, (territories ?? []) as Territory[]);
}

// -------------------------------------------------------------- adjustment

async function resolveAdjustment(ctx: Ctx) {
  const { room, phase, territories } = ctx;
  const supabase = getSupabaseServer();
  const events: string[] = [];
  const summaryOrders: SummaryOrder[] = [];
  const terr = [...territories];

  const nations = ctx.players.filter((p) => p.nation && !p.is_eliminated);
  for (const p of nations) {
    const nation = p.nation!;
    const delta = supplyCenterCount(terr, nation) - unitCount(terr, nation);
    if (delta === 0) continue;
    const mine = ctx.orders.filter((o) => o.nation === nation);

    if (delta > 0) {
      const slots = buildSlots(terr, nation, HOME_SCS[nation]);
      let built = 0;
      for (const o of mine) {
        if (o.order_type !== "build" || built >= delta) continue;
        const slot = slots.find((s) => s.prov === o.unit_territory);
        const already = terr.find((t) => t.code === o.unit_territory)?.occupant_nation;
        const ok = slot && !already;
        if (ok) {
          const coast = o.target_territory?.split("/")[1] ?? null;
          await setTerritoryUnit(room.id, o.unit_territory, {
            nation,
            type: o.unit_type,
            coast,
          });
          const t = terr.find((x) => x.code === o.unit_territory)!;
          t.occupant_nation = nation;
          t.unit_type = o.unit_type;
          built++;
          events.push(`${nation} : ${o.unit_type === "army" ? "armée" : "flotte"} construite à ${name(o.unit_territory)}`);
        }
        await supabase
          .from("orders")
          .update({ status: "resolved", result: ok ? "success" : "invalid" })
          .eq("id", o.id);
        summaryOrders.push({
          prov: o.unit_territory,
          nation,
          unit: o.unit_type,
          type: "build",
          target: o.target_territory,
          aux: null,
          result: ok ? "success" : "invalid",
        });
      }
    } else {
      // collect requested disbands, then force the remainder
      const myUnits = unitsOnBoard(terr).filter((u) => u.nation === nation);
      const requested = mine
        .filter((o) => o.order_type === "disband")
        .map((o) => o.unit_territory)
        .filter((prov) => myUnits.some((u) => u.prov === prov));
      const board = botBoard(nation, terr);
      const forced = defaultBot
        .adjustmentOrders(board, delta, [])
        .disbands.filter((prov) => !requested.includes(prov));
      const toDisband = [...new Set([...requested, ...forced])].slice(0, -delta);
      for (const prov of toDisband) {
        await setTerritoryUnit(room.id, prov, null);
        const t = terr.find((x) => x.code === prov)!;
        t.occupant_nation = null;
        t.unit_type = null;
        events.push(`${nation} : unité de ${name(prov)} dissoute`);
        summaryOrders.push({
          prov,
          nation,
          unit: "army",
          type: "disband",
          target: null,
          aux: null,
          result: "success",
        });
      }
      for (const o of mine) {
        await supabase
          .from("orders")
          .update({ status: "resolved", result: "success" })
          .eq("id", o.id);
      }
    }
  }

  await finishPhase(phase, { events, orders: summaryOrders, dislodged: [] });

  // victory can also be detected here ("next resolution check")
  for (const p of nations) {
    if (supplyCenterCount(terr, p.nation!) >= 17) {
      await endGame(room, p.nation!);
      return;
    }
  }

  // game length cap: total_phases counts movement phases
  if (phase.phase_number + 1 > room.total_phases) {
    const ranked = nations
      .map((p) => ({
        nation: p.nation!,
        sc: supplyCenterCount(terr, p.nation!),
        units: unitCount(terr, p.nation!),
      }))
      .sort((a, b) => b.sc - a.sc || b.units - a.units);
    await endGame(room, ranked[0]?.nation ?? null);
    return;
  }

  await openPhase(room, {
    phase_number: phase.phase_number + 1,
    year: phase.year + 1,
    season: "spring",
    type: "movement",
  });
}

// Auto-hold every unit lacking a submitted order, then resolve. Used by the
// expiry triggers (client countdown + cron).
export async function resolveIfExpired(roomId: string): Promise<void> {
  const ctx = await loadCtx(roomId);
  if (!ctx?.phase.ends_at) return;
  if (new Date(ctx.phase.ends_at).getTime() > Date.now()) return;

  if (ctx.phase.type === "movement") {
    const supabase = getSupabaseServer();
    const covered = new Set(ctx.orders.map((o) => o.unit_territory));
    const playerByNation = new Map(
      ctx.players.filter((p) => p.nation).map((p) => [p.nation!, p])
    );
    const rows = toAdjUnits(ctx.territories)
      .filter((u) => !covered.has(u.prov) && playerByNation.has(u.nation as Nation))
      .map((u) => ({
        room_id: roomId,
        phase_id: ctx.phase.id,
        player_id: playerByNation.get(u.nation as Nation)!.id,
        nation: u.nation,
        unit_type: u.unit,
        unit_territory: u.prov,
        order_type: "hold",
        status: "submitted",
        is_submitted: true,
      }));
    if (rows.length > 0) {
      await supabase
        .from("orders")
        .upsert(rows, { onConflict: "phase_id,unit_territory", ignoreDuplicates: true });
    }
  }
  await maybeResolve(roomId);
}
