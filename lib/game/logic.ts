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
