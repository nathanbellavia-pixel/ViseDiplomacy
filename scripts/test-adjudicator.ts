// Adjudicator unit tests over real map adjacency.
// Run: node scripts/test-adjudicator.ts   (Node 23+ strips types natively)
import { adjudicate, validRetreats, type AdjUnit, type AdjOrder } from "../lib/game/adjudicator.ts";

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

const A = (prov: string, nation: string): AdjUnit => ({ prov, nation, unit: "army", coast: null });
const F = (prov: string, nation: string, coast: string | null = null): AdjUnit => ({ prov, nation, unit: "fleet", coast });
const mv = (prov: string, target: string, targetCoast: string | null = null): AdjOrder => ({ type: "move", prov, target, targetCoast });
const sup = (prov: string, aux: string, target: string): AdjOrder => ({ type: "support", prov, aux, target });
const cvy = (prov: string, aux: string, target: string): AdjOrder => ({ type: "convoy", prov, aux, target });
const hold = (prov: string): AdjOrder => ({ type: "hold", prov });

// 1. two equal attacks on an empty province bounce (DATC 6.A-style standoff)
{
  console.log("standoff on neutral territory");
  const r = adjudicate([A("par", "France"), A("mun", "Allemagne")], [mv("par", "bur"), mv("mun", "bur")]);
  check("par bounced", r.results.get("par"), "bounced");
  check("mun bounced", r.results.get("mun"), "bounced");
  check("nobody moved", r.moved.size, 0);
  check("bur contested", [...r.contested], ["bur"]);
}

// 2. supported attack dislodges a holder
{
  console.log("supported attack dislodges");
  const r = adjudicate(
    [A("par", "France"), A("gas", "France"), A("bur", "Allemagne")],
    [mv("par", "bur"), sup("gas", "par", "bur"), hold("bur")]
  );
  check("par moved", r.moved.get("par"), { to: "bur", coast: null });
  check("gas support ok", r.results.get("gas"), "success");
  check("bur dislodged", r.results.get("bur"), "dislodged");
  check("attacker origin", r.dislodged.get("bur"), "par");
}

// 3. support cut by an attack from a third province -> attack bounces
{
  console.log("support cut");
  const r = adjudicate(
    [A("par", "France"), A("gas", "France"), A("bur", "Allemagne"), A("spa", "Italie")],
    [mv("par", "bur"), sup("gas", "par", "bur"), hold("bur"), mv("spa", "gas")]
  );
  check("gas cut", r.results.get("gas"), "cut");
  check("par bounced", r.results.get("par"), "bounced");
  check("bur holds", r.results.get("bur"), "success");
  check("spa bounced on gas", r.results.get("spa"), "bounced");
}

// 4. attack from the supported battle's province does NOT cut
{
  console.log("no cut from the attacked province");
  const r = adjudicate(
    [A("par", "France"), A("gas", "France"), A("bur", "Allemagne")],
    [mv("par", "bur"), sup("gas", "par", "bur"), mv("bur", "gas")]
  );
  // bur attacks gas (strength 1) vs gas defense 1 -> bounce, support not cut
  check("gas support holds", r.results.get("gas"), "success");
  check("par succeeds", r.results.get("par"), "success");
  check("bur dislodged", r.results.get("bur"), "dislodged");
}

// 5. head-to-head: stronger side wins, loser dislodged in place
{
  console.log("head-to-head");
  const r = adjudicate(
    [A("bur", "France"), A("mun", "Allemagne"), A("ruh", "France")],
    [mv("bur", "mun"), mv("mun", "bur"), sup("ruh", "bur", "mun")]
  );
  check("bur wins h2h", r.moved.get("bur"), { to: "mun", coast: null });
  check("mun dislodged", r.results.get("mun"), "dislodged");
  check("equal h2h would bounce", adjudicate(
    [A("bur", "France"), A("mun", "Allemagne")],
    [mv("bur", "mun"), mv("mun", "bur")]
  ).moved.size, 0);
}

// 6. rotation cycle of three units succeeds
{
  console.log("rotation cycle");
  const r = adjudicate(
    [A("tyr", "Autriche-Hongrie"), A("mun", "Allemagne"), A("boh", "Russie")],
    [mv("tyr", "mun"), mv("mun", "boh"), mv("boh", "tyr")]
  );
  check("tyr→mun", r.results.get("tyr"), "success");
  check("mun→boh", r.results.get("mun"), "success");
  check("boh→tyr", r.results.get("boh"), "success");
}

// 7. no self-dislodgement, even supported
{
  console.log("self-dislodgement forbidden");
  const r = adjudicate(
    [A("par", "France"), A("gas", "France"), A("bur", "France")],
    [mv("par", "bur"), sup("gas", "par", "bur"), hold("bur")]
  );
  check("par bounced off own unit", r.results.get("par"), "bounced");
  check("bur stays", r.results.get("bur"), "success");
}

// 8. beleaguered garrison: two supported attacks tie -> defender survives
{
  console.log("beleaguered garrison");
  const r = adjudicate(
    [
      A("bur", "Allemagne"),
      A("par", "France"), A("gas", "France"),
      A("mun", "Italie"), A("ruh", "Italie"),
    ],
    [
      hold("bur"),
      mv("par", "bur"), sup("gas", "par", "bur"),
      mv("mun", "bur"), sup("ruh", "mun", "bur"),
    ]
  );
  check("bur survives", r.results.get("bur"), "success");
  check("par bounced", r.results.get("par"), "bounced");
  check("mun bounced", r.results.get("mun"), "bounced");
}

// 9. chain: follower enters only if leader vacates
{
  console.log("move chain");
  const ok = adjudicate(
    [A("gas", "France"), A("par", "France")],
    [mv("par", "bur"), mv("gas", "par")]
  );
  check("leader moves", ok.results.get("par"), "success");
  check("follower moves", ok.results.get("gas"), "success");
  const blocked = adjudicate(
    [A("gas", "France"), A("par", "France"), A("mun", "Allemagne")],
    [mv("par", "bur"), mv("gas", "par"), mv("mun", "bur")]
  );
  check("leader bounces", blocked.results.get("par"), "bounced");
  check("follower blocked", blocked.results.get("gas"), "bounced");
}

// 10. support-hold beats a lone attack; support-hold on a mover is void
{
  console.log("support hold");
  const r = adjudicate(
    [A("bur", "Allemagne"), A("ruh", "Allemagne"), A("par", "France"), A("gas", "France")],
    [hold("bur"), sup("ruh", "bur", "bur"), mv("par", "bur"), sup("gas", "par", "bur")]
  );
  check("bur survives 2v2", r.results.get("bur"), "success");
  const voided = adjudicate(
    [A("bur", "Allemagne"), A("ruh", "Allemagne"), A("par", "France"), A("gas", "France")],
    [mv("bur", "bel"), sup("ruh", "bur", "bur"), mv("par", "bur"), sup("gas", "par", "bur")]
  );
  check("support-hold on mover void", voided.results.get("ruh"), "invalid");
}

// 11. fleets: coast-aware move + retreat options
{
  console.log("fleets and retreats");
  const r = adjudicate(
    [F("mao", "France"), A("par", "France")],
    [mv("mao", "spa", "nc"), hold("par")]
  );
  check("fleet lands on coast", r.moved.get("mao"), { to: "spa", coast: "nc" });

  const retreats = validRetreats(
    A("bur", "Allemagne"),
    "par",
    new Set(["mun", "bel", "ruh", "bur"]),
    new Set(["gas"])
  );
  check("retreats exclude attacker/occupied/contested", retreats.sort(), ["mar", "pic"]);
}

// 12. illegal move adjudicated as hold + marked invalid
{
  console.log("illegal orders");
  const r = adjudicate([A("par", "France")], [mv("par", "lon")]);
  check("illegal move invalid", r.results.get("par"), "invalid");
  check("unit did not move", r.moved.size, 0);
}

// 13. support declared before the supported move in the order list
{
  console.log("support order listed before the move");
  const r = adjudicate(
    [A("hol", "France"), A("pic", "France"), A("bel", "Allemagne")],
    [sup("hol", "pic", "bel"), mv("pic", "bel"), hold("bel")]
  );
  check("early support is valid", r.results.get("hol"), "success");
  check("supported attack lands", r.results.get("pic"), "success");
  check("defender dislodged", r.results.get("bel"), "dislodged");
}

// 14. convoy across one sea province (London → Brest via the Channel)
{
  console.log("2-province convoy");
  const r = adjudicate(
    [A("lon", "Angleterre"), F("eng", "Angleterre")],
    [mv("lon", "bre"), cvy("eng", "lon", "bre")]
  );
  check("army lands by sea", r.moved.get("lon"), { to: "bre", coast: null });
  check("move flagged as convoyed", r.viaConvoy.has("lon"), true);
  check("convoying fleet ok", r.results.get("eng"), "success");
}

// 15. chained convoy through three sea provinces (Liverpool → Tunis)
{
  console.log("3-fleet convoy chain");
  const r = adjudicate(
    [
      A("lvp", "Angleterre"),
      F("nao", "Angleterre"),
      F("mao", "Angleterre"),
      F("wes", "France"), // foreign fleets may take part in the chain
    ],
    [
      mv("lvp", "tun"),
      cvy("nao", "lvp", "tun"),
      cvy("mao", "lvp", "tun"),
      cvy("wes", "lvp", "tun"),
    ]
  );
  check("army crosses three seas", r.moved.get("lvp"), { to: "tun", coast: null });
  check("convoyed flag", r.viaConvoy.has("lvp"), true);
}

// 16. convoy without orders from the fleets is an invalid move
{
  console.log("convoy needs convoy orders");
  const r = adjudicate(
    [A("lon", "Angleterre"), F("eng", "Angleterre")],
    [mv("lon", "bre"), hold("eng")]
  );
  check("no convoy order: move invalid", r.results.get("lon"), "invalid");
}

// 17. dislodging a convoying fleet disrupts the convoy
{
  console.log("convoy disruption");
  const r = adjudicate(
    [
      A("lon", "Angleterre"), F("eng", "Angleterre"),
      F("mao", "France"), F("iri", "France"),
    ],
    [
      mv("lon", "bre"), cvy("eng", "lon", "bre"),
      mv("mao", "eng"), sup("iri", "mao", "eng"),
    ]
  );
  check("convoying fleet dislodged", r.results.get("eng"), "dislodged");
  check("convoyed move fails", r.results.get("lon"), "bounced");
  check("army stays home", r.moved.has("lon"), false);
  check("attacker enters the sea", r.moved.get("mao"), { to: "eng", coast: null });
}

// 18. a convoyed attack still dislodges with support
{
  console.log("supported convoyed attack");
  const r = adjudicate(
    [
      A("lon", "Angleterre"), F("eng", "Angleterre"), F("pic", "Angleterre"),
      A("bre", "France"),
    ],
    [
      mv("lon", "bre"), cvy("eng", "lon", "bre"), sup("pic", "lon", "bre"),
      hold("bre"),
    ]
  );
  check("convoyed attack lands", r.moved.get("lon"), { to: "bre", coast: null });
  check("defender dislodged", r.results.get("bre"), "dislodged");
}

// 19. multi-coast fleet moves must name a coast on split-coast provinces
{
  console.log("multi-coast moves (Spain, Bulgaria, St-Petersburg)");
  const spa = adjudicate([F("mao", "France")], [mv("mao", "spa", "nc")]);
  check("Spain north coast", spa.moved.get("mao"), { to: "spa", coast: "nc" });
  const bul = adjudicate([F("con", "Empire Ottoman")], [mv("con", "bul", "ec")]);
  check("Bulgaria east coast", bul.moved.get("con"), { to: "bul", coast: "ec" });
  const stp = adjudicate([F("bot", "Russie")], [mv("bot", "stp", "sc")]);
  check("St-Petersburg south coast", stp.moved.get("bot"), { to: "stp", coast: "sc" });
  const missing = adjudicate([F("mao", "France")], [mv("mao", "spa")]);
  check("coast required on split-coast", missing.results.get("mao"), "invalid");
  const wrong = adjudicate([F("mao", "France")], [mv("mao", "spa", "ec")]);
  check("nonexistent coast rejected", wrong.results.get("mao"), "invalid");
}

// 20. retreats: never back into the attacker's origin province
{
  console.log("illegal retreat back to attacker origin");
  const options = validRetreats(A("bur", "Allemagne"), "par", new Set(), new Set());
  check("attacker origin excluded", options.includes("par"), false);
  check("other neighbours open", options.includes("gas"), true);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nALL ADJUDICATOR TESTS PASSED");
