// Phase-rule unit tests: retreats, winter adjustments, victory and draws.
// Run: node scripts/test-rules.ts   (Node 23+ strips types natively)
import {
  VICTORY_SC_COUNT,
  drawAccepted,
  findVictor,
  planBuilds,
  planDisbands,
  planRetreats,
} from "../lib/game/phase-logic.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
    failures++;
  }
}

// 1. retreats: legal choice, illegal destination, no order
{
  console.log("retreat basics");
  const plan = planRetreats(
    [
      { prov: "bur", options: ["mar", "pic"] },
      { prov: "mun", options: ["boh"] },
      { prov: "kie", options: ["hol"] },
    ],
    new Map([
      ["bur", "mar"], // legal
      ["mun", "par"], // not among the legal options (e.g. attacker's origin)
      // kie: no order at all
    ])
  );
  check("legal retreat moves", plan.moves.get("bur"), "mar");
  check("illegal destination destroys", plan.destroyed.includes("mun"), true);
  check("no order destroys", plan.destroyed.includes("kie"), true);
  check("exactly one unit retreats", plan.moves.size, 1);
}

// 2. two retreats into the same province destroy both units
{
  console.log("double retreat destruction");
  const plan = planRetreats(
    [
      { prov: "ven", options: ["tus", "apu"] },
      { prov: "rom", options: ["tus", "nap"] },
    ],
    new Map([
      ["ven", "tus"],
      ["rom", "tus"],
    ])
  );
  check("nobody moves", plan.moves.size, 0);
  check("both destroyed", plan.destroyed.sort(), ["rom", "ven"]);
}

// 3. coastal retreat collisions are detected on the province, not the coast
{
  console.log("coastal retreat collision");
  const plan = planRetreats(
    [
      { prov: "mao", options: ["spa/nc"] },
      { prov: "lyo", options: ["spa/sc"] },
    ],
    new Map([
      ["mao", "spa/nc"],
      ["lyo", "spa/sc"],
    ])
  );
  check("same province collides", plan.destroyed.sort(), ["lyo", "mao"]);
}

// 4. builds: only free home supply centers, fleets need a real coast
{
  console.log("fall builds on home centers");
  const free = new Set(["par", "bre", "mar"]);
  const accepted = planBuilds(
    [
      { prov: "par", unit: "army", coast: null }, // ok: free home SC
      { prov: "bur", unit: "army", coast: null }, // not a home SC
      { prov: "bre", unit: "fleet", coast: null }, // ok: coastal home SC
    ],
    3,
    free
  );
  check(
    "home SC builds accepted",
    accepted.map((b) => b.prov),
    ["par", "bre"]
  );
  check("fleet inland rejected", planBuilds([{ prov: "par", unit: "fleet", coast: null }], 1, free), []);
  check(
    "build cap respected",
    planBuilds(
      [
        { prov: "par", unit: "army", coast: null },
        { prov: "bre", unit: "army", coast: null },
      ],
      1,
      free
    ).length,
    1
  );
  check(
    "occupied/foreign center rejected",
    planBuilds([{ prov: "mun", unit: "army", coast: null }], 1, free),
    []
  );
  const stp = new Set(["stp"]);
  check(
    "split-coast fleet needs a coast",
    planBuilds([{ prov: "stp", unit: "fleet", coast: null }], 1, stp),
    []
  );
  check(
    "split-coast fleet with coast ok",
    planBuilds([{ prov: "stp", unit: "fleet", coast: "nc" }], 1, stp),
    [{ prov: "stp", unit: "fleet", coast: "nc" }]
  );
}

// 5. disbands: player choices first, then the forced remainder
{
  console.log("forced disbands");
  const units = new Set(["par", "bur", "gas", "mar"]);
  check(
    "requested disbands honoured",
    planDisbands(2, ["gas", "mar"], ["par", "bur", "gas", "mar"], units),
    ["gas", "mar"]
  );
  check(
    "shortfall forced from ranking",
    planDisbands(2, ["gas"], ["par", "bur", "gas", "mar"], units),
    ["gas", "par"]
  );
  check(
    "no requests: all forced",
    planDisbands(1, [], ["bur", "par"], units),
    ["bur"]
  );
  check(
    "ghost units ignored",
    planDisbands(1, ["lon"], ["par"], units),
    ["par"]
  );
}

// 6. solo victory requires 18 of 34 supply centers — 17 is not enough
{
  console.log("18-center solo victory");
  check("threshold is 18", VICTORY_SC_COUNT, 18);
  check(
    "17 centers do not win",
    findVictor([
      { nation: "France", sc: 17 },
      { nation: "Russie", sc: 10 },
    ]),
    null
  );
  check(
    "18 centers win",
    findVictor([
      { nation: "Russie", sc: 7 },
      { nation: "France", sc: 18 },
    ]),
    "France"
  );
}

// 7. mutual draw: every non-eliminated power must accept
{
  console.log("mutual draw acceptance");
  const p = (
    nation: string | null,
    draw_vote: boolean,
    is_bot = false,
    is_eliminated = false
  ) => ({ nation, draw_vote, is_bot, is_eliminated });

  check(
    "all humans accept -> draw",
    drawAccepted([p("France", true), p("Russie", true), p("Italie", true, true)]),
    true
  );
  check(
    "one human refuses -> no draw",
    drawAccepted([p("France", true), p("Russie", false)]),
    false
  );
  check(
    "eliminated players do not block",
    drawAccepted([p("France", true), p("Russie", false, false, true), p("Italie", true)]),
    true
  );
  check(
    "no human vote -> no draw (bots alone cannot end the game)",
    drawAccepted([p("Italie", false, true), p("Russie", false, true)]),
    false
  );
  check(
    "unassigned players ignored",
    drawAccepted([p(null, false), p("France", true), p("Russie", true)]),
    true
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nALL RULES TESTS PASSED");
