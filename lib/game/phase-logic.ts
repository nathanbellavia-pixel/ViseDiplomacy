// Pure rules for the non-movement parts of the phase cycle: victory, draws,
// retreat conflicts and winter adjustments. Kept free of database and Next.js
// imports (only ./map-data) so node can run the test suite directly.

import { PROVINCES } from "./map-data.ts";

/** Solo victory requires an absolute majority of the 34 supply centers. */
export const VICTORY_SC_COUNT = 18;

/** First nation at 18+ supply centers, or null while nobody has won. */
export function findVictor(
  standings: { nation: string; sc: number }[]
): string | null {
  return standings.find((s) => s.sc >= VICTORY_SC_COUNT)?.nation ?? null;
}

export interface DrawVoter {
  nation: string | null;
  is_bot: boolean;
  is_eliminated: boolean;
  draw_vote: boolean;
}

/**
 * The game ends in a shared draw only when every non-eliminated power
 * accepts. Bots always consent, so the decision rests with the humans —
 * but at least one human must actually have proposed/accepted.
 */
export function drawAccepted(players: DrawVoter[]): boolean {
  const active = players.filter((p) => p.nation && !p.is_eliminated);
  const humans = active.filter((p) => !p.is_bot);
  return (
    active.length >= 2 && humans.length > 0 && humans.every((p) => p.draw_vote)
  );
}

// ----------------------------------------------------------------- retreats

export interface RetreatPlan {
  /** Units that retreat: origin -> destination ("prov" or "prov/coast"). */
  moves: Map<string, string>;
  /** Units destroyed: no order, illegal destination, or collision. */
  destroyed: string[];
}

/**
 * Settle a retreat phase. `wanted` maps each dislodged unit's province to its
 * requested destination (null = disband). A destination outside the unit's
 * legal options disbands it; two retreats into the same province destroy
 * both units.
 */
export function planRetreats(
  dislodged: { prov: string; options: string[] }[],
  wanted: Map<string, string | null>
): RetreatPlan {
  const valid = new Map<string, string>(); // origin -> legal destination
  const byDest = new Map<string, string[]>(); // destination province -> origins
  for (const d of dislodged) {
    const to = wanted.get(d.prov) ?? null;
    if (to && d.options.includes(to)) {
      valid.set(d.prov, to);
      const dest = to.split("/")[0];
      byDest.set(dest, [...(byDest.get(dest) ?? []), d.prov]);
    }
  }
  const moves = new Map<string, string>();
  const destroyed: string[] = [];
  for (const d of dislodged) {
    const to = valid.get(d.prov);
    if (to && (byDest.get(to.split("/")[0]) ?? []).length === 1) {
      moves.set(d.prov, to);
    } else {
      destroyed.push(d.prov);
    }
  }
  return { moves, destroyed };
}

// -------------------------------------------------------------- adjustments

export interface BuildRequest {
  prov: string;
  unit: "army" | "fleet";
  coast: string | null;
}

/**
 * Accept up to `maxBuilds` legal builds: each on a distinct free home supply
 * center, fleets only on coastal provinces, and a named coast where the
 * province has several.
 */
export function planBuilds(
  requested: BuildRequest[],
  maxBuilds: number,
  freeHomeScs: Set<string>
): BuildRequest[] {
  const accepted: BuildRequest[] = [];
  const used = new Set<string>();
  for (const b of requested) {
    if (accepted.length >= maxBuilds) break;
    if (!freeHomeScs.has(b.prov) || used.has(b.prov)) continue;
    const info = PROVINCES[b.prov];
    if (!info) continue;
    if (b.unit === "fleet") {
      if (info.type !== "coast") continue;
      if (info.coasts && (!b.coast || !info.coasts.includes(b.coast))) continue;
    }
    used.add(b.prov);
    accepted.push({ ...b, coast: b.unit === "fleet" ? b.coast : null });
  }
  return accepted;
}

/**
 * Pick exactly `required` units to disband: the player's requested disbands
 * first (when they name real units), then the fallback ranking covers any
 * shortfall — a power may never keep more units than centers.
 */
export function planDisbands(
  required: number,
  requested: string[],
  fallback: string[],
  unitProvs: Set<string>
): string[] {
  const out: string[] = [];
  for (const prov of requested) {
    if (out.length >= required) break;
    if (unitProvs.has(prov) && !out.includes(prov)) out.push(prov);
  }
  for (const prov of fallback) {
    if (out.length >= required) break;
    if (unitProvs.has(prov) && !out.includes(prov)) out.push(prov);
  }
  return out;
}
