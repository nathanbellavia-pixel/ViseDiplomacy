import { ARMY_ADJ, FLEET_ADJ, PROVINCES } from "./map-data";
import type { Territory } from "@/lib/types";

export interface BoardUnit {
  prov: string;
  nation: string;
  unit: "army" | "fleet";
  coast: string | null;
}

export interface MoveTarget {
  prov: string;
  coast: string | null;
}

export function unitsOnBoard(territories: Territory[]): BoardUnit[] {
  return territories
    .filter((t) => t.unit_type && t.occupant_nation)
    .map((t) => ({
      prov: t.code,
      nation: t.occupant_nation!,
      unit: t.unit_type!,
      coast: t.unit_coast,
    }));
}

function fleetLoc(u: BoardUnit): string {
  return u.coast ? `${u.prov}/${u.coast}` : u.prov;
}

// All legal move destinations for a unit (no convoys). Fleets get one entry
// per reachable coast of split-coast provinces.
export function moveTargets(u: BoardUnit): MoveTarget[] {
  if (u.unit === "army") {
    return (ARMY_ADJ[u.prov] ?? []).map((prov) => ({ prov, coast: null }));
  }
  return (FLEET_ADJ[fleetLoc(u)] ?? []).map((loc) => {
    const [prov, coast] = loc.split("/");
    return { prov, coast: coast ?? null };
  });
}

export function canReach(u: BoardUnit, prov: string): boolean {
  return moveTargets(u).some((t) => t.prov === prov);
}

// Units this unit could support (hold or move), excluding itself.
export function supportableUnits(me: BoardUnit, units: BoardUnit[]): BoardUnit[] {
  const myReach = new Set(moveTargets(me).map((t) => t.prov));
  return units.filter((u) => {
    if (u.prov === me.prov) return false;
    if (myReach.has(u.prov)) return true; // support hold
    return moveTargets(u).some((t) => myReach.has(t.prov)); // support a move
  });
}

// For a chosen supported unit: where can the support apply?
export function supportDestinations(
  me: BoardUnit,
  supported: BoardUnit
): { canSupportHold: boolean; moveDestinations: string[] } {
  const myReach = new Set(moveTargets(me).map((t) => t.prov));
  return {
    canSupportHold: myReach.has(supported.prov),
    moveDestinations: [
      ...new Set(
        moveTargets(supported)
          .map((t) => t.prov)
          .filter((p) => myReach.has(p) && p !== me.prov)
      ),
    ],
  };
}

// --------------------------------------------------------------- convoys

const seaTouches = (sea: string, prov: string) =>
  (FLEET_ADJ[sea] ?? []).some((l) => l.split("/")[0] === prov);

// Sea provinces currently holding a fleet (only those can convoy).
function fleetSeas(units: BoardUnit[]): Set<string> {
  return new Set(
    units
      .filter((u) => u.unit === "fleet" && PROVINCES[u.prov]?.type === "water")
      .map((u) => u.prov)
  );
}

/**
 * Coastal provinces an army could reach by convoy through the fleets
 * currently at sea (any nation — foreign fleets may convoy too).
 */
export function convoyTargets(army: BoardUnit, units: BoardUnit[]): Set<string> {
  const out = new Set<string>();
  if (army.unit !== "army") return out;
  const fleets = fleetSeas(units);
  const queue = [...fleets].filter((s) => seaTouches(s, army.prov));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const sea = queue.shift()!;
    for (const loc of FLEET_ADJ[sea] ?? []) {
      const prov = loc.split("/")[0];
      if (fleets.has(loc) && !seen.has(loc)) {
        seen.add(loc);
        queue.push(loc);
      } else if (PROVINCES[prov]?.type === "coast" && prov !== army.prov) {
        out.add(prov);
      }
    }
  }
  return out;
}

function bfsConvoyPath(from: string, to: string, fleets: Set<string>): string[] | null {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of fleets) {
    if (seaTouches(s, from)) {
      parent.set(s, null);
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const sea = queue.shift()!;
    if (seaTouches(sea, to)) {
      const path = [sea];
      let p = parent.get(sea) ?? null;
      while (p) {
        path.unshift(p);
        p = parent.get(p) ?? null;
      }
      return path;
    }
    for (const loc of FLEET_ADJ[sea] ?? []) {
      if (fleets.has(loc) && !parent.has(loc)) {
        parent.set(loc, sea);
        queue.push(loc);
      }
    }
  }
  return null;
}

/**
 * Shortest convoy chain (list of sea provinces) carrying `army` to `target`,
 * preferring a route made only of `nation`'s own fleets — those are the ones
 * the player can actually order to convoy.
 */
export function convoyPathFor(
  army: BoardUnit,
  target: string,
  units: BoardUnit[],
  nation: string | null
): string[] | null {
  if (army.unit !== "army") return null;
  if (nation) {
    const own = new Set(
      units
        .filter(
          (u) =>
            u.unit === "fleet" &&
            u.nation === nation &&
            PROVINCES[u.prov]?.type === "water"
        )
        .map((u) => u.prov)
    );
    const ownPath = bfsConvoyPath(army.prov, target, own);
    if (ownPath) return ownPath;
  }
  return bfsConvoyPath(army.prov, target, fleetSeas(units));
}

/**
 * What a fleet at sea can convoy: armies on coasts of its connected group of
 * fleet-occupied sea provinces, and the coastal destinations of that group.
 */
export function fleetConvoyOptions(
  fleet: BoardUnit,
  units: BoardUnit[]
): { armies: string[]; coastals: Set<string> } {
  if (PROVINCES[fleet.prov]?.type !== "water")
    return { armies: [], coastals: new Set() };
  const fleets = fleetSeas(units);
  const queue = [fleet.prov];
  const component = new Set(queue);
  while (queue.length > 0) {
    const sea = queue.shift()!;
    for (const loc of FLEET_ADJ[sea] ?? []) {
      if (fleets.has(loc) && !component.has(loc)) {
        component.add(loc);
        queue.push(loc);
      }
    }
  }
  const coastals = new Set<string>();
  for (const sea of component) {
    for (const loc of FLEET_ADJ[sea] ?? []) {
      const prov = loc.split("/")[0];
      if (PROVINCES[prov]?.type === "coast") coastals.add(prov);
    }
  }
  const armies = units
    .filter((u) => u.unit === "army" && coastals.has(u.prov))
    .map((u) => u.prov);
  return { armies, coastals };
}

// ----------------------------------------------------------- adjustments
export function supplyCenterCount(territories: Territory[], nation: string): number {
  return territories.filter((t) => t.is_supply_center && t.owner_nation === nation).length;
}

export function unitCount(territories: Territory[], nation: string): number {
  return territories.filter((t) => t.occupant_nation === nation).length;
}

export interface BuildSlot {
  prov: string;
  name: string;
  allowFleet: boolean;
  coasts: string[] | null;
}

// Empty, owned home supply centers where this nation may build.
export function buildSlots(
  territories: Territory[],
  nation: string,
  homeScs: string[]
): BuildSlot[] {
  return territories
    .filter(
      (t) =>
        homeScs.includes(t.code) &&
        t.owner_nation === nation &&
        !t.occupant_nation
    )
    .map((t) => ({
      prov: t.code,
      name: t.name,
      allowFleet: PROVINCES[t.code].type === "coast",
      coasts: PROVINCES[t.code].coasts ?? null,
    }));
}
