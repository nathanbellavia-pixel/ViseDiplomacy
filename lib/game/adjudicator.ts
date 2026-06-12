// Server-side Diplomacy adjudicator — DATC subset, convoys included.
//
// Resolution uses bounded fixpoint iteration (min strength counts only
// confirmed supports, max strength also counts undecided ones), so support
// cuts, head-to-head battles and move chains resolve without ordering
// assumptions. Whatever survives the fixpoint is a rotation cycle, which
// succeeds per the rulebook.
//
// Convoys: an army may move to any coastal province reachable through a
// chain of fleets in sea provinces whose convoy orders match the move.
// Disruption is handled by an outer loop: after each full adjudication,
// any convoyed move whose every path lost a fleet to dislodgement is marked
// broken (the army stays put) and the board is re-adjudicated. The broken
// set only grows, so the loop terminates.
//
// Deliberately alias-free (only ./map-data) so node can run the test suite
// without the Next.js toolchain.

import { ARMY_ADJ, FLEET_ADJ, PROVINCES } from "./map-data.ts";

export interface AdjUnit {
  prov: string;
  nation: string;
  unit: "army" | "fleet";
  coast: string | null;
}

export type AdjOrder =
  | { type: "hold"; prov: string }
  | {
      type: "move";
      prov: string;
      target: string;
      targetCoast?: string | null;
      /** Explicitly take the sea route even if a land route exists. */
      viaConvoy?: boolean;
    }
  // aux === target means support-hold
  | { type: "support"; prov: string; aux: string; target: string }
  // fleet at `prov` carries the army at `aux` toward `target`
  | { type: "convoy"; prov: string; aux: string; target: string };

export type AdjResult = "success" | "bounced" | "cut" | "dislodged" | "invalid";

export interface Adjudication {
  /** Outcome of each unit's own order, keyed by origin province. */
  results: Map<string, AdjResult>;
  /** Successful moves: origin -> destination (+ landing coast for fleets). */
  moved: Map<string, { to: string; coast: string | null }>;
  /** Dislodged units: province -> origin of the dislodging attack. */
  dislodged: Map<string, string>;
  /** Provinces left vacant by a standoff — closed to retreats this turn. */
  contested: Set<string>;
  /** Origins of moves that went by convoy (a convoyed attacker does not
   *  block retreats to its origin province). */
  viaConvoy: Set<string>;
}

function fleetLoc(u: AdjUnit): string {
  return u.coast ? `${u.prov}/${u.coast}` : u.prov;
}

export function reachableProvinces(u: AdjUnit): Set<string> {
  if (u.unit === "army") return new Set(ARMY_ADJ[u.prov] ?? []);
  return new Set((FLEET_ADJ[fleetLoc(u)] ?? []).map((loc) => loc.split("/")[0]));
}

function canMove(u: AdjUnit, target: string, coast: string | null): boolean {
  if (u.unit === "army") return (ARMY_ADJ[u.prov] ?? []).includes(target);
  const locs = FLEET_ADJ[fleetLoc(u)] ?? [];
  return coast ? locs.includes(`${target}/${coast}`) : locs.includes(target);
}

// ----------------------------------------------------------------- convoys

function seaTouches(sea: string, prov: string): boolean {
  return (FLEET_ADJ[sea] ?? []).some((loc) => loc.split("/")[0] === prov);
}

/**
 * Is there a chain of convoying fleets (a subset of `fleets`, each in a sea
 * province) linking `from` to `to`? Sea-to-sea steps follow fleet adjacency.
 */
export function convoyPathExists(
  from: string,
  to: string,
  fleets: Set<string>
): boolean {
  const queue = [...fleets].filter((s) => seaTouches(s, from));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const sea = queue.shift()!;
    if (seaTouches(sea, to)) return true;
    for (const next of FLEET_ADJ[sea] ?? []) {
      if (fleets.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

type Tri = "undecided" | "yes" | "no";

interface MoveCtx {
  prov: string;
  target: string;
  coast: string | null;
  nation: string;
  viaConvoy: boolean;
  state: Tri; // does the move succeed?
}

interface SupportCtx {
  prov: string;
  aux: string;
  target: string; // province the support is given into
  nation: string;
  state: Tri; // does the support hold (not cut)?
}

interface PassResult extends Adjudication {
  /** Convoyed moves of this pass: origin -> { target, convoying fleets }. */
  convoyRoutes: Map<string, { target: string; fleets: Set<string> }>;
}

export function adjudicate(units: AdjUnit[], orders: AdjOrder[]): Adjudication {
  // Outer loop: re-adjudicate whenever a convoy turns out to be disrupted.
  const broken = new Set<string>();
  let pass = adjudicatePass(units, orders, broken);
  for (let guard = 0; guard <= units.length; guard++) {
    let changed = false;
    for (const [prov, route] of pass.convoyRoutes) {
      const survivors = new Set(
        [...route.fleets].filter((f) => !pass.dislodged.has(f))
      );
      if (!convoyPathExists(prov, route.target, survivors)) {
        broken.add(prov);
        changed = true;
      }
    }
    if (!changed) break;
    pass = adjudicatePass(units, orders, broken);
  }
  return pass;
}

function adjudicatePass(
  units: AdjUnit[],
  orders: AdjOrder[],
  broken: Set<string>
): PassResult {
  const unitAt = new Map(units.map((u) => [u.prov, u]));
  const results = new Map<string, AdjResult>();
  const orderAt = new Map<string, AdjOrder>();
  for (const o of orders) {
    if (unitAt.has(o.prov) && !orderAt.has(o.prov)) orderAt.set(o.prov, o);
  }
  // unordered units hold
  for (const u of units) {
    if (!orderAt.has(u.prov)) orderAt.set(u.prov, { type: "hold", prov: u.prov });
  }

  // ----------------------------------------------------------- validation
  // 1. raw move intents (needed to match convoy orders)
  const intents = new Map<
    string,
    { target: string; coast: string | null; viaConvoy: boolean }
  >();
  for (const u of units) {
    const o = orderAt.get(u.prov)!;
    if (o.type !== "move" || o.target === u.prov) continue;
    intents.set(u.prov, {
      target: o.target,
      coast: o.targetCoast ?? null,
      viaConvoy: o.viaConvoy === true,
    });
  }

  // 2. convoy orders: a fleet in a sea province carrying a matching army move
  const convoyFleets = new Map<string, Set<string>>(); // "from>to" -> fleets
  for (const u of units) {
    const o = orderAt.get(u.prov)!;
    if (o.type !== "convoy") continue;
    const army = unitAt.get(o.aux);
    const matches =
      u.unit === "fleet" &&
      PROVINCES[u.prov]?.type === "water" &&
      army?.unit === "army" &&
      intents.get(o.aux)?.target === o.target;
    if (matches) {
      const key = `${o.aux}>${o.target}`;
      if (!convoyFleets.has(key)) convoyFleets.set(key, new Set());
      convoyFleets.get(key)!.add(u.prov);
    } else {
      results.set(u.prov, "invalid"); // mismatched convoy is void
    }
  }

  // 3. moves: direct, convoyed, or invalid
  const moves = new Map<string, MoveCtx>();
  const convoyRoutes = new Map<string, { target: string; fleets: Set<string> }>();
  for (const [prov, it] of intents) {
    const u = unitAt.get(prov)!;
    if (broken.has(prov)) {
      // convoy disrupted in a previous pass: the move fails outright
      results.set(prov, "bounced");
      continue;
    }
    const direct = canMove(u, it.target, it.coast);
    const fleets = convoyFleets.get(`${prov}>${it.target}`) ?? new Set<string>();
    const convoyed =
      u.unit === "army" &&
      fleets.size > 0 &&
      convoyPathExists(prov, it.target, fleets) &&
      (it.viaConvoy || !direct);
    if (convoyed || direct) {
      moves.set(prov, {
        prov,
        target: it.target,
        coast: convoyed ? null : it.coast,
        nation: u.nation,
        viaConvoy: convoyed,
        state: "undecided",
      });
      if (convoyed) convoyRoutes.set(prov, { target: it.target, fleets });
    } else {
      results.set(prov, "invalid"); // stays and defends as a hold
    }
  }

  // 4. supports (validity depends on the supported unit's adjudicable move)
  const supports = new Map<string, SupportCtx>();
  for (const u of units) {
    const o = orderAt.get(u.prov)!;
    if (o.type === "support") {
      const supported = unitAt.get(o.aux);
      const reach = reachableProvinces(u);
      const matches =
        supported &&
        reach.has(o.target) &&
        o.aux !== u.prov &&
        (o.aux === o.target
          ? orderAt.get(o.aux)!.type !== "move" || !moves.has(o.aux)
          : moves.get(o.aux)?.target === o.target);
      if (matches) {
        supports.set(u.prov, {
          prov: u.prov,
          aux: o.aux,
          target: o.target,
          nation: u.nation,
          state: "undecided",
        });
      } else {
        results.set(u.prov, "invalid"); // mismatched support is void
      }
    }
  }

  // --------------------------------------------------------------- helpers
  const movesInto = (t: string): MoveCtx[] =>
    [...moves.values()].filter((m) => m.target === t);

  const supportsFor = (prov: string, target: string): SupportCtx[] =>
    [...supports.values()].filter((s) => s.aux === prov && s.target === target);

  // attack strength bounds for a move (1 + supports, excluding supports of a
  // dislodgement of the supporter's own nation's unit)
  const moveStrength = (m: MoveCtx): { min: number; max: number } => {
    const defender = unitAt.get(m.target);
    let min = 1;
    let max = 1;
    for (const s of supportsFor(m.prov, m.target)) {
      // a nation's support never helps dislodge its own unit
      if (defender && defender.nation === s.nation) continue;
      if (s.state === "yes") {
        min++;
        max++;
      } else if (s.state === "undecided") max++;
    }
    return { min, max };
  };

  // hold strength bounds of the unit currently in `prov` (assuming it stays)
  const holdStrength = (prov: string): { min: number; max: number } => {
    let min = 1;
    let max = 1;
    if (moves.has(prov)) return { min: 1, max: 1 }; // failed movers defend with 1
    for (const s of supportsFor(prov, prov)) {
      if (s.state === "yes") {
        min++;
        max++;
      } else if (s.state === "undecided") max++;
    }
    return { min, max };
  };

  // ------------------------------------------------------------- fixpoint
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;

    // 1. support cuts
    for (const s of supports.values()) {
      if (s.state !== "undecided") continue;
      let cut = false;
      let pendingFromTarget = false;
      for (const m of moves.values()) {
        if (m.target !== s.prov || m.nation === s.nation) continue;
        if (m.prov !== s.target) {
          cut = true; // attacked from outside the supported battle: always cuts
          break;
        }
        // attack from the province the support is aimed at only cuts by dislodging
        if (m.state === "yes") cut = true;
        else if (m.state === "undecided") pendingFromTarget = true;
      }
      if (cut) {
        s.state = "no";
        changed = true;
      } else if (!pendingFromTarget) {
        s.state = "yes";
        changed = true;
      }
    }

    // 2. battles
    for (const m of moves.values()) {
      if (m.state !== "undecided") continue;
      const me = moveStrength(m);
      const rivals = movesInto(m.target).filter((r) => r.prov !== m.prov);

      // strongest rival bound: even a bounced rival keeps its prevent
      // strength (standoffs block everyone) — unless it lost a head-to-head,
      // in which case it was thrown back and prevents nothing
      let rivalMin = 0;
      let rivalMax = 0;
      for (const r of rivals) {
        const counter = moves.get(r.target);
        const h2h =
          counter && counter.target === r.prov && !r.viaConvoy && !counter.viaConvoy
            ? counter
            : undefined;
        if (h2h?.state === "yes") continue; // rival dislodged by the h2h winner
        const rs = moveStrength(r);
        // if the h2h is still open the rival may end up preventing nothing
        rivalMin = Math.max(rivalMin, h2h && h2h.state !== "no" ? 0 : rs.min);
        rivalMax = Math.max(rivalMax, rs.max);
      }

      const defender = unitAt.get(m.target);
      const defenderMove = defender ? moves.get(defender.prov) : undefined;
      // convoyed units pass each other at sea: no head-to-head either way
      const headToHead = defenderMove
        ? defenderMove.target === m.prov && !m.viaConvoy && !defenderMove.viaConvoy
        : false;

      // defense bounds
      let defMin = 0;
      let defMax = 0;
      let defenderMayStay = false;
      let defenderStays = false;
      if (defender) {
        if (headToHead) {
          const ds = moveStrength(defenderMove!);
          defMin = ds.min;
          defMax = ds.max;
          defenderMayStay = true;
          defenderStays = true; // in a head-to-head the loser is dislodged in place
        } else if (!defenderMove) {
          const hs = holdStrength(defender.prov);
          defMin = hs.min;
          defMax = hs.max;
          defenderMayStay = true;
          defenderStays = true;
        } else if (defenderMove.state === "yes") {
          // vacated
        } else if (defenderMove.state === "no") {
          defMin = 1;
          defMax = 1;
          defenderMayStay = true;
          defenderStays = true;
        } else {
          defMin = 0;
          defMax = 1;
          defenderMayStay = true;
        }
      }

      // a unit can never dislodge its own nation's unit
      const blockedBySelf = defender && defender.nation === m.nation;

      const beatsRivals = me.min > rivalMax;
      const losesRivals = me.max <= rivalMin;
      const beatsDefense = me.min > defMax;
      const losesDefense = me.max <= defMin;

      if (losesRivals || (defenderMayStay && losesDefense && defenderStays)) {
        m.state = "no";
        changed = true;
      } else if (blockedBySelf && defenderStays) {
        m.state = "no";
        changed = true;
      } else if (
        beatsRivals &&
        (!defender ||
          (defenderStays && beatsDefense && !blockedBySelf) ||
          (!defenderStays && !defenderMayStay))
      ) {
        m.state = "yes";
        changed = true;
      }
    }
  }

  // 3. whatever is still undecided forms rotation cycles (A→B→C→A): succeed
  for (const m of moves.values()) {
    if (m.state === "undecided") m.state = "yes";
  }
  for (const s of supports.values()) {
    if (s.state === "undecided") s.state = "yes";
  }

  // --------------------------------------------------------------- outputs
  const moved = new Map<string, { to: string; coast: string | null }>();
  const dislodged = new Map<string, string>();
  const contested = new Set<string>();
  const viaConvoy = new Set<string>();

  for (const m of moves.values()) {
    if (m.state === "yes") {
      moved.set(m.prov, { to: m.target, coast: m.coast });
      results.set(m.prov, "success");
      if (m.viaConvoy) viaConvoy.add(m.prov);
    } else if (!results.has(m.prov)) {
      results.set(m.prov, "bounced");
    }
  }

  // dislodgements: a unit that stayed and whose province was entered
  for (const m of moves.values()) {
    if (m.state !== "yes") continue;
    const defender = unitAt.get(m.target);
    if (defender && !moved.has(defender.prov)) {
      dislodged.set(defender.prov, m.prov);
      results.set(defender.prov, "dislodged");
    }
  }

  // standoffs: ≥2 attempted moves into a province nobody entered
  const byTarget = new Map<string, MoveCtx[]>();
  for (const m of moves.values()) {
    byTarget.set(m.target, [...(byTarget.get(m.target) ?? []), m]);
  }
  for (const [target, ms] of byTarget) {
    if (ms.length >= 2 && ms.every((m) => m.state === "no")) contested.add(target);
  }

  // supports: cut/success for the ones not already voided or dislodged
  for (const s of supports.values()) {
    if (results.get(s.prov) === "dislodged") continue;
    results.set(s.prov, s.state === "yes" ? "success" : "cut");
  }

  // holds and convoying fleets succeed unless dislodged; keep 'invalid' marks
  for (const u of units) {
    if (!results.has(u.prov)) results.set(u.prov, "success");
  }

  return { results, moved, dislodged, contested, viaConvoy, convoyRoutes };
}

/**
 * Valid retreat destinations for a dislodged unit: adjacent per unit type,
 * empty after resolution, not the attacker's origin (unless the attack came
 * by convoy — pass "" then), not a standoff province.
 * Returns fleet destinations as "prov" or "prov/coast" entries.
 */
export function validRetreats(
  unit: AdjUnit,
  attackerFrom: string,
  occupiedAfter: Set<string>,
  contested: Set<string>
): string[] {
  const out: string[] = [];
  if (unit.unit === "army") {
    for (const p of ARMY_ADJ[unit.prov] ?? []) {
      if (p !== attackerFrom && !occupiedAfter.has(p) && !contested.has(p)) out.push(p);
    }
  } else {
    for (const loc of FLEET_ADJ[fleetLoc(unit)] ?? []) {
      const p = loc.split("/")[0];
      if (p !== attackerFrom && !occupiedAfter.has(p) && !contested.has(p)) out.push(loc);
    }
  }
  return out;
}
