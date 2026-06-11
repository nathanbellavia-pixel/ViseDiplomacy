// Generates lib/game/map-data.ts and lib/game/map-svg.ts from the open-source
// jDip/Mila assets in assets/ (standard.map + standard.svg, GPL, see headers).
// Run: node scripts/generate-map-data.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const mapTxt = readFileSync("assets/standard.map", "utf8");
const svgTxt = readFileSync("assets/standard.svg", "utf8");

// ---------------------------------------------------------------- adjacency
// dpjudge .map semantics: each "TYPE LOC ABUTS ..." line lists reachable
// locations. An UPPERCASE abut is reachable by fleets (if it is not LAND);
// a lowercase abut only by armies. Multi-coast provinces (bul, spa, stp)
// have one lowercase army-level entry plus one entry per coast for fleets.
const entries = [];
for (const line of mapTxt.split(/\r?\n/)) {
  const m = line.match(/^(WATER|COAST|LAND|SHUT)\s+(\S+)\s+ABUTS\s*(.*)$/);
  if (m) entries.push({ kind: m[1], loc: m[2], abuts: m[3].trim().split(/\s+/).filter(Boolean) });
}

const baseOf = (t) => t.toLowerCase().split("/")[0];
const types = {}; // province -> land|coast|water
for (const e of entries) {
  if (e.kind === "SHUT") continue;
  const base = baseOf(e.loc);
  const t = e.kind === "WATER" ? "water" : e.kind === "LAND" ? "land" : "coast";
  // coast entries win over a previously seen plain entry
  if (!(base in types) || t === "coast") types[base] = types[base] === "coast" ? "coast" : t;
}
delete types.swi;

const armyAdj = {};
const fleetAdj = {};
const coasts = {}; // province -> ["nc","sc"] etc.

for (const e of entries) {
  if (e.kind === "SHUT") continue;
  const loc = e.loc.toLowerCase();
  const base = baseOf(e.loc);
  const isCoastVariant = e.loc.includes("/");
  const isArmyEntry = !isCoastVariant; // plain entry (incl. lowercase bul/spa/stp)

  if (isCoastVariant) {
    (coasts[base] ??= []).push(loc.split("/")[1]);
  }

  // Armies: every abut whose base province is not water (and not Switzerland)
  if (isArmyEntry && e.kind !== "WATER") {
    armyAdj[base] = [
      ...new Set(e.abuts.map(baseOf).filter((p) => p !== "swi" && types[p] !== "water")),
    ].sort();
  }

  // Fleets: only from water/coast locations; multi-coast provinces only via
  // their coast variants (the lowercase plain entry is army-only).
  const isFleetLoc =
    e.kind === "WATER" || (e.kind === "COAST" && (isCoastVariant || e.loc === e.loc.toUpperCase()));
  if (isFleetLoc) {
    const targets = e.abuts
      .filter((t) => t === t.toUpperCase()) // uppercase = fleet-reachable
      .map((t) => t.toLowerCase())
      .filter((t) => types[baseOf(t)] !== "land" && baseOf(t) !== "swi");
    fleetAdj[loc] = [...new Set(targets)].sort();
  }
}

// Sanity: symmetry of both graphs
let warnings = 0;
for (const [a, list] of Object.entries(armyAdj)) {
  for (const b of list) {
    if (!armyAdj[b]?.includes(a)) {
      console.warn(`asym army: ${a} -> ${b}`);
      warnings++;
    }
  }
}
for (const [a, list] of Object.entries(fleetAdj)) {
  for (const b of list) {
    if (!fleetAdj[b]?.includes(a)) {
      console.warn(`asym fleet: ${a} -> ${b}`);
      warnings++;
    }
  }
}

// ------------------------------------------------------------ display names
const FR_NAMES = {
  adr: "Mer Adriatique", aeg: "Mer Égée", alb: "Albanie", ank: "Ankara",
  apu: "Apulie", arm: "Arménie", bal: "Mer Baltique", bar: "Mer de Barents",
  bel: "Belgique", ber: "Berlin", bla: "Mer Noire", boh: "Bohême",
  bot: "Golfe de Botnie", bre: "Brest", bud: "Budapest", bul: "Bulgarie",
  bur: "Bourgogne", cly: "Clyde", con: "Constantinople", den: "Danemark",
  eas: "Méditerranée orientale", edi: "Édimbourg", eng: "Manche",
  fin: "Finlande", gal: "Galicie", gas: "Gascogne", gre: "Grèce",
  hel: "Baie d'Heligoland", hol: "Hollande", ion: "Mer Ionienne",
  iri: "Mer d'Irlande", kie: "Kiel", lon: "Londres", lvn: "Livonie",
  lvp: "Liverpool", lyo: "Golfe du Lion", mao: "Atlantique central",
  mar: "Marseille", mos: "Moscou", mun: "Munich", naf: "Afrique du Nord",
  nao: "Atlantique Nord", nap: "Naples", nth: "Mer du Nord",
  nwg: "Mer de Norvège", nwy: "Norvège", par: "Paris", pic: "Picardie",
  pie: "Piémont", por: "Portugal", pru: "Prusse", rom: "Rome", ruh: "Ruhr",
  rum: "Roumanie", ser: "Serbie", sev: "Sébastopol", sil: "Silésie",
  ska: "Skagerrak", smy: "Smyrne", spa: "Espagne", stp: "Saint-Pétersbourg",
  swe: "Suède", syr: "Syrie", tri: "Trieste", tun: "Tunis", tus: "Toscane",
  tyr: "Tyrol", tys: "Mer Tyrrhénienne", ukr: "Ukraine", ven: "Venise",
  vie: "Vienne", wal: "Pays de Galles", war: "Varsovie",
  wes: "Méditerranée occidentale", yor: "Yorkshire",
};

// 34 supply centers
const HOME_SCS = {
  "Autriche-Hongrie": ["bud", "tri", "vie"],
  Angleterre: ["edi", "lon", "lvp"],
  France: ["bre", "mar", "par"],
  Allemagne: ["ber", "kie", "mun"],
  Italie: ["nap", "rom", "ven"],
  Russie: ["mos", "sev", "stp", "war"],
  "Empire Ottoman": ["ank", "con", "smy"],
};
const NEUTRAL_SCS = ["bel", "bul", "den", "gre", "hol", "nwy", "por", "rum", "ser", "spa", "swe", "tun"];
const ALL_SCS = new Set([...Object.values(HOME_SCS).flat(), ...NEUTRAL_SCS]);
if (ALL_SCS.size !== 34) throw new Error(`expected 34 SCs, got ${ALL_SCS.size}`);

// ------------------------------------------------------------- coordinates
// jdipNS:PROVINCE entries hold unit anchor points (coast variants use "-").
const unitCoords = {};
const provRe = /<jdipNS:PROVINCE name="([a-z-]+)">\s*<jdipNS:UNIT x="([\d.]+)" y="([\d.]+)"/g;
let m;
while ((m = provRe.exec(svgTxt))) {
  unitCoords[m[1].replace("-", "/")] = { x: +m[2], y: +m[3] };
}
// Supply-center marker positions (symbol is 20x20, x/y is its corner)
const scCoords = {};
const scRe = /<use height="20" id="sc_([A-Z]+)" width="20" x="([\d.]+)" xlink:href="#SupplyCenter" y="([\d.]+)"/g;
while ((m = scRe.exec(svgTxt))) {
  scCoords[m[1].toLowerCase()] = { x: +m[2] + 10, y: +m[3] + 10 };
}

// The SVG uses a few jDip-era ids that differ from dpjudge codes
const SVG_ALIASES = { nao: "nat", nwg: "nrg", mao: "mid", lyo: "gol", tys: "tyn" };

const provinces = {};
for (const code of Object.keys(types).sort()) {
  if (!FR_NAMES[code]) throw new Error(`missing FR name for ${code}`);
  if (!unitCoords[code]) throw new Error(`missing coords for ${code}`);
  provinces[code] = {
    name: FR_NAMES[code],
    type: types[code],
    sc: ALL_SCS.has(code),
    svgId: "_" + (SVG_ALIASES[code] ?? code),
    unit: unitCoords[code],
    ...(scCoords[code] ? { scPos: scCoords[code] } : {}),
    ...(coasts[code] ? { coasts: coasts[code].sort() } : {}),
  };
}
for (const sc of ALL_SCS) if (!provinces[sc]?.scPos) throw new Error(`missing SC pos for ${sc}`);

// Coast-variant unit anchors (for fleets sitting on a specific coast)
const coastUnit = {};
for (const [loc, xy] of Object.entries(unitCoords)) {
  if (loc.includes("/")) coastUnit[loc] = xy;
}

// ------------------------------------------------------------- cleaned svg
let svg = svgTxt
  .replace(/<\?xml[^>]*\?>\s*/, "")
  .replace(/<!DOCTYPE[^>]*>\s*/, "")
  .replace(/<jdipNS:DISPLAY>[\s\S]*?<\/jdipNS:DISPLAY>\s*/, "")
  .replace(/<jdipNS:ORDERDRAWING>[\s\S]*?<\/jdipNS:ORDERDRAWING>\s*/, "")
  .replace(/<jdipNS:PROVINCE_DATA>[\s\S]*?<\/jdipNS:PROVINCE_DATA>\s*/, "")
  .replace(/<g id="SupplyCenterLayer">[\s\S]*?<\/g>\s*/, "")
  .replace(/<g id="MouseLayer"[\s\S]*$/, "</svg>") // MouseLayer is last before </svg>
  .replace(/<g id="OrderLayer">\s*<g id="Layer2"\/>\s*<g id="Layer1"\/>\s*<\/g>\s*/, "")
  .replace(/<g id="(UnitLayer|DislodgedUnitLayer|HighestOrderLayer)"\/>\s*/g, "")
  .replace(/ xmlns:jdipNS="svg.dtd"/, "")
  .replace(/ height="680px"/, "")
  .replace(/ width="918px"/, "");

if (!svg.trimEnd().endsWith("</svg>")) throw new Error("svg cleanup broke structure");

mkdirSync("lib/game", { recursive: true });

writeFileSync(
  "lib/game/map-data.ts",
  `// AUTO-GENERATED by scripts/generate-map-data.mjs — do not edit by hand.
// Source: jDip standard map data (GPL) via github.com/diplomacy/diplomacy.
// Codes are dpjudge province codes; fleet locations may carry a coast
// qualifier ("stp/sc"). ARMY_ADJ/FLEET_ADJ are the complete standard
// Diplomacy adjacency tables.

export type ProvinceType = "land" | "coast" | "water";
export interface ProvinceInfo {
  name: string;
  type: ProvinceType;
  sc: boolean;
  svgId: string;
  unit: { x: number; y: number };
  scPos?: { x: number; y: number };
  coasts?: string[];
}

export const PROVINCES: Record<string, ProvinceInfo> = ${JSON.stringify(provinces, null, 1)};

export const ARMY_ADJ: Record<string, string[]> = ${JSON.stringify(armyAdj, null, 1)};

export const FLEET_ADJ: Record<string, string[]> = ${JSON.stringify(fleetAdj, null, 1)};

// Unit anchor points for fleets on a specific coast of a split-coast province
export const COAST_UNIT_POS: Record<string, { x: number; y: number }> = ${JSON.stringify(coastUnit, null, 1)};
`
);

writeFileSync(
  "lib/game/map-svg.ts",
  `// AUTO-GENERATED by scripts/generate-map-data.mjs — do not edit by hand.
// Cleaned jDip standard map (GPL, by Zach DelProposto) — province shapes keep
// their ids (#_par, ...); fills are overridden at runtime.
export const MAP_VIEWBOX = "0 0 1835 1360";
export const MAP_SVG = ${JSON.stringify(svg)};
`
);

console.log(
  `provinces: ${Object.keys(provinces).length}, armyAdj: ${Object.keys(armyAdj).length}, fleetLocs: ${Object.keys(fleetAdj).length}, SCs: ${ALL_SCS.size}, warnings: ${warnings}`
);
