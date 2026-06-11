// Bot players. The BotBrain interface is the seam for swapping in an AI
// model later: the phase system only ever calls these three methods with
// plain board data and applies whatever orders come back.

import { ARMY_ADJ, FLEET_ADJ } from "./map-data";
import type { AdjOrder, AdjUnit } from "./adjudicator";
import { validRetreats } from "./adjudicator";

export interface BotBoard {
  nation: string;
  units: AdjUnit[]; // every unit on the board
  /** SC ownership: province -> owning nation (or null when neutral). */
  scOwners: Map<string, string | null>;
  /** All occupied provinces. */
  occupied: Map<string, string>; // province -> occupant nation
  homeScs: string[];
}

export interface BotDislodgement {
  unit: AdjUnit;
  attackerFrom: string;
  options: string[]; // valid retreat locations ("prov" or "prov/coast")
}

export interface BotAdjustment {
  builds: { prov: string; unit: "army" | "fleet"; coast: string | null }[];
  disbands: string[];
}

export interface BotBrain {
  movementOrders(board: BotBoard): AdjOrder[];
  retreatOrders(board: BotBoard, dislodged: BotDislodgement[]): { prov: string; to: string | null }[];
  adjustmentOrders(
    board: BotBoard,
    delta: number,
    buildSlots: { prov: string; allowFleet: boolean; coasts: string[] | null }[]
  ): BotAdjustment;
}

function fleetLoc(u: AdjUnit): string {
  return u.coast ? `${u.prov}/${u.coast}` : u.prov;
}

function neighbors(u: AdjUnit): { prov: string; coast: string | null }[] {
  if (u.unit === "army") {
    return (ARMY_ADJ[u.prov] ?? []).map((p) => ({ prov: p, coast: null }));
  }
  return (FLEET_ADJ[fleetLoc(u)] ?? []).map((loc) => {
    const [prov, coast] = loc.split("/");
    return { prov, coast: coast ?? null };
  });
}

// BFS distance from a unit to a set of goal provinces, returning the first
// step of a shortest path. Armies walk ARMY_ADJ, fleets walk FLEET_ADJ.
function firstStepToward(
  u: AdjUnit,
  goals: Set<string>,
  blocked: Set<string>
): { prov: string; coast: string | null } | null {
  const startNeighbors = neighbors(u).filter((n) => !blocked.has(n.prov));
  for (const n of startNeighbors) if (goals.has(n.prov)) return n;

  const seen = new Set<string>([u.unit === "army" ? u.prov : fleetLoc(u)]);
  let frontier = startNeighbors.map((n) => ({ first: n, loc: n.coast ? `${n.prov}/${n.coast}` : n.prov }));
  for (const f of frontier) seen.add(f.loc);

  for (let depth = 0; depth < 12 && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const adj =
        u.unit === "army" ? (ARMY_ADJ[f.loc] ?? []) : (FLEET_ADJ[f.loc] ?? []);
      for (const loc of adj) {
        if (seen.has(loc)) continue;
        seen.add(loc);
        const prov = loc.split("/")[0];
        if (goals.has(prov)) return f.first;
        if (!blocked.has(prov)) next.push({ first: f.first, loc });
      }
    }
    frontier = next;
  }
  return null;
}

export const defaultBot: BotBrain = {
  movementOrders(board) {
    const { nation, units, scOwners, occupied, homeScs } = board;
    const mine = units
      .filter((u) => u.nation === nation)
      .sort((a, b) => a.prov.localeCompare(b.prov));
    const orders: AdjOrder[] = [];
    const claimed = new Set<string>(); // destinations already taken this turn
    const movers = new Map<string, { target: string; coast: string | null }>();

    // 1. defend: an empty home SC of ours with an enemy next door gets garrisoned
    const threatenedHomes = homeScs.filter((sc) => {
      if (occupied.has(sc)) return false;
      if (scOwners.get(sc) !== nation) return false;
      return units.some((u) => u.nation !== nation && neighbors(u).some((n) => n.prov === sc));
    });

    for (const u of mine) {
      const adj = neighbors(u);
      const defend = adj.find((n) => threatenedHomes.includes(n.prov) && !claimed.has(n.prov));
      if (defend) {
        orders.push({ type: "move", prov: u.prov, target: defend.prov, targetCoast: defend.coast });
        claimed.add(defend.prov);
        movers.set(u.prov, { target: defend.prov, coast: defend.coast });
      }
    }

    // 2. grab adjacent unowned, unoccupied supply centers
    for (const u of mine) {
      if (movers.has(u.prov)) continue;
      const grab = neighbors(u).find(
        (n) =>
          scOwners.has(n.prov) &&
          scOwners.get(n.prov) !== nation &&
          !occupied.has(n.prov) &&
          !claimed.has(n.prov)
      );
      if (grab) {
        orders.push({ type: "move", prov: u.prov, target: grab.prov, targetCoast: grab.coast });
        claimed.add(grab.prov);
        movers.set(u.prov, { target: grab.prov, coast: grab.coast });
      }
    }

    // 3. support a neighbour's grab, or attack an enemy-held SC with support
    for (const u of mine) {
      if (movers.has(u.prov)) continue;
      const reach = new Set(neighbors(u).map((n) => n.prov));
      const toHelp = mine.find((m) => {
        const mv = movers.get(m.prov);
        return mv && reach.has(mv.target) && m.prov !== u.prov;
      });
      if (toHelp) {
        const mv = movers.get(toHelp.prov)!;
        orders.push({ type: "support", prov: u.prov, aux: toHelp.prov, target: mv.target });
        movers.set(u.prov, { target: u.prov, coast: null }); // committed
        continue;
      }
      // attack an adjacent enemy-occupied SC if a sibling can support it
      const attackable = neighbors(u).find(
        (n) =>
          scOwners.has(n.prov) &&
          occupied.has(n.prov) &&
          occupied.get(n.prov) !== nation &&
          !claimed.has(n.prov)
      );
      if (attackable) {
        const supporter = mine.find(
          (m) =>
            !movers.has(m.prov) &&
            m.prov !== u.prov &&
            neighbors(m).some((n) => n.prov === attackable.prov)
        );
        if (supporter) {
          orders.push({ type: "move", prov: u.prov, target: attackable.prov, targetCoast: attackable.coast });
          orders.push({ type: "support", prov: supporter.prov, aux: u.prov, target: attackable.prov });
          claimed.add(attackable.prov);
          movers.set(u.prov, { target: attackable.prov, coast: attackable.coast });
          movers.set(supporter.prov, { target: supporter.prov, coast: null });
        }
      }
    }

    // 4. march remaining units toward the nearest foreign SC
    const goals = new Set(
      [...scOwners.entries()].filter(([, owner]) => owner !== nation).map(([p]) => p)
    );
    const ownPositions = new Set(mine.filter((m) => !movers.has(m.prov)).map((m) => m.prov));
    for (const u of mine) {
      if (movers.has(u.prov)) continue;
      const blocked = new Set([...claimed, ...ownPositions]);
      blocked.delete(u.prov);
      const step = firstStepToward(u, goals, blocked);
      if (step && !claimed.has(step.prov) && !ownPositions.has(step.prov)) {
        orders.push({ type: "move", prov: u.prov, target: step.prov, targetCoast: step.coast });
        claimed.add(step.prov);
        movers.set(u.prov, { target: step.prov, coast: step.coast });
      } else {
        orders.push({ type: "hold", prov: u.prov });
      }
    }
    return orders;
  },

  retreatOrders(board, dislodged) {
    return dislodged.map((d) => {
      if (d.options.length === 0) return { prov: d.unit.prov, to: null };
      const score = (loc: string) => {
        const prov = loc.split("/")[0];
        if (board.scOwners.get(prov) === board.nation) return 0; // own SC first
        if (board.scOwners.has(prov)) return 1;
        return 2;
      };
      const best = [...d.options].sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0];
      return { prov: d.unit.prov, to: best };
    });
  },

  adjustmentOrders(board, delta, buildSlots) {
    if (delta > 0) {
      const mine = board.units.filter((u) => u.nation === board.nation);
      let fleets = mine.filter((u) => u.unit === "fleet").length;
      let armies = mine.length - fleets;
      const builds: BotAdjustment["builds"] = [];
      for (const slot of buildSlots.slice(0, delta)) {
        if (slot.allowFleet && fleets < armies) {
          builds.push({ prov: slot.prov, unit: "fleet", coast: slot.coasts?.[0] ?? null });
          fleets++;
        } else {
          builds.push({ prov: slot.prov, unit: "army", coast: null });
          armies++;
        }
      }
      return { builds, disbands: [] };
    }
    if (delta < 0) {
      // disband units farthest from our nearest owned SC
      const ownedScs = new Set(
        [...board.scOwners.entries()]
          .filter(([, o]) => o === board.nation)
          .map(([p]) => p)
      );
      const mine = board.units
        .filter((u) => u.nation === board.nation)
        .sort((a, b) => a.prov.localeCompare(b.prov));
      const distance = (u: AdjUnit) => {
        if (ownedScs.has(u.prov)) return 0;
        return firstStepToward(u, ownedScs, new Set()) ? 1 : 99;
      };
      const ranked = [...mine].sort((a, b) => distance(b) - distance(a) || a.prov.localeCompare(b.prov));
      return { builds: [], disbands: ranked.slice(0, -delta).map((u) => u.prov) };
    }
    return { builds: [], disbands: [] };
  },
};

export { validRetreats };
