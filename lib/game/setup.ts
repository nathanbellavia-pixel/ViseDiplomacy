import type { Nation } from "@/lib/types";
import { PROVINCES } from "./map-data";

// Canonical starting units, standard Diplomacy 1901
// (coast is only meaningful for fleets on split-coast provinces)
export const STARTING_UNITS: {
  nation: Nation;
  prov: string;
  unit: "army" | "fleet";
  coast?: string;
}[] = [
  { nation: "Autriche-Hongrie", prov: "bud", unit: "army" },
  { nation: "Autriche-Hongrie", prov: "vie", unit: "army" },
  { nation: "Autriche-Hongrie", prov: "tri", unit: "fleet" },
  { nation: "Angleterre", prov: "edi", unit: "fleet" },
  { nation: "Angleterre", prov: "lon", unit: "fleet" },
  { nation: "Angleterre", prov: "lvp", unit: "army" },
  { nation: "France", prov: "bre", unit: "fleet" },
  { nation: "France", prov: "mar", unit: "army" },
  { nation: "France", prov: "par", unit: "army" },
  { nation: "Allemagne", prov: "kie", unit: "fleet" },
  { nation: "Allemagne", prov: "ber", unit: "army" },
  { nation: "Allemagne", prov: "mun", unit: "army" },
  { nation: "Italie", prov: "nap", unit: "fleet" },
  { nation: "Italie", prov: "rom", unit: "army" },
  { nation: "Italie", prov: "ven", unit: "army" },
  { nation: "Russie", prov: "war", unit: "army" },
  { nation: "Russie", prov: "mos", unit: "army" },
  { nation: "Russie", prov: "sev", unit: "fleet" },
  { nation: "Russie", prov: "stp", unit: "fleet", coast: "sc" },
  { nation: "Empire Ottoman", prov: "ank", unit: "fleet" },
  { nation: "Empire Ottoman", prov: "con", unit: "army" },
  { nation: "Empire Ottoman", prov: "smy", unit: "army" },
];

export const HOME_SCS: Record<Nation, string[]> = {
  "Autriche-Hongrie": ["bud", "tri", "vie"],
  Angleterre: ["edi", "lon", "lvp"],
  France: ["bre", "mar", "par"],
  Allemagne: ["ber", "kie", "mun"],
  Italie: ["nap", "rom", "ven"],
  Russie: ["mos", "sev", "stp", "war"],
  "Empire Ottoman": ["ank", "con", "smy"],
};

// Non-SC provinces that start under national control (classic board colors)
export const HOME_TERRITORIES: Record<Nation, string[]> = {
  "Autriche-Hongrie": ["boh", "gal", "tyr"],
  Angleterre: ["cly", "wal", "yor"],
  France: ["bur", "gas", "pic"],
  Allemagne: ["pru", "ruh", "sil"],
  Italie: ["apu", "pie", "tus"],
  Russie: ["fin", "lvn", "ukr"],
  "Empire Ottoman": ["arm", "syr"],
};

export interface TerritorySeed {
  code: string;
  name: string;
  type: "land" | "sea" | "coast";
  is_supply_center: boolean;
  owner_nation: Nation | null;
  occupant_nation: Nation | null;
  unit_type: "army" | "fleet" | null;
  unit_coast: string | null;
}

// Builds the 75 territory rows for a fresh game.
export function buildInitialTerritories(): TerritorySeed[] {
  const ownerOf: Record<string, Nation> = {};
  for (const [nation, provs] of Object.entries(HOME_SCS)) {
    for (const p of provs) ownerOf[p] = nation as Nation;
  }
  for (const [nation, provs] of Object.entries(HOME_TERRITORIES)) {
    for (const p of provs) ownerOf[p] = nation as Nation;
  }
  const unitAt = new Map(STARTING_UNITS.map((u) => [u.prov, u]));

  return Object.entries(PROVINCES).map(([code, info]) => {
    const unit = unitAt.get(code);
    return {
      code,
      name: info.name,
      // db uses 'sea' where map data uses 'water'
      type: info.type === "water" ? "sea" : info.type,
      is_supply_center: info.sc,
      owner_nation: ownerOf[code] ?? null,
      occupant_nation: unit?.nation ?? null,
      unit_type: unit?.unit ?? null,
      unit_coast: unit?.coast ?? null,
    };
  });
}
