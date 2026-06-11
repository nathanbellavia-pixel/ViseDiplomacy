// End-to-end verification of Goal 3: adjudication, phase cycle, bots,
// retreats, elimination, victory.
// Usage: VERIFY_BASE_URL=http://localhost:3000 node scripts/verify-goal3.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
const ROOM_NAME = `Guerre ${Date.now().toString(36).toUpperCase()}`;
const SHOTS = ".verify";
mkdirSync(SHOTS, { recursive: true });

const env = readFileSync(".env.local", "utf8");
const grab = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))[1].trim();
const secretKey = grab("CLERK_SECRET_KEY");
const supabase = createClient(grab("NEXT_PUBLIC_SUPABASE_URL"), grab("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
  db: { schema: "diplomacy" },
});

const log = (m) => console.log(`[verify] ${m}`);
const fail = (m) => {
  throw new Error(m);
};

async function signIn(page, email, userId) {
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
  });
  const { token } = await res.json();
  if (!token) fail(`no sign-in token for ${email}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk?.loaded, { timeout: 60000 });
  await page.evaluate(async (ticket) => {
    const r = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    if (r.status !== "complete") throw new Error(`sign-in status: ${r.status}`);
    await window.Clerk.setActive({ session: r.createdSessionId });
  }, token);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Salon des parties", { timeout: 30000 });
  log(`${email} signed in`);
}

// poll the DB until a condition holds
async function until(label, fn, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 700));
  }
  fail(`TIMEOUT waiting for ${label}`);
}

const territory = async (roomId, code) => {
  const { data } = await supabase
    .from("territories")
    .select()
    .eq("room_id", roomId)
    .eq("code", code)
    .single();
  return data;
};

const activePhase = async (roomId) => {
  const { data } = await supabase
    .from("phases")
    .select()
    .eq("room_id", roomId)
    .eq("status", "active")
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
};

const expireActivePhase = async (roomId) => {
  const phase = await activePhase(roomId);
  if (!phase) fail("no active phase to expire");
  await supabase
    .from("phases")
    .update({ ends_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", phase.id);
  const res = await fetch(`${BASE}/api/cron/resolve`);
  if (!res.ok) fail(`cron endpoint: HTTP ${res.status}`);
  return phase;
};

// UI helper: give a move order via the map and submit
async function orderMove(page, from, to) {
  await page.locator(`[data-unit="${from}"]`).dispatchEvent("click");
  await page.locator(`[data-highlight="${to}"]`).first().waitFor({ timeout: 10000 });
  await page.locator(`[data-highlight="${to}"]`).first().dispatchEvent("click");
  await page.locator(`[data-order-chip="${from}"]`).waitFor({ timeout: 10000 });
}

async function orderSupportMove(page, from, aux, dest) {
  await page.locator(`[data-unit="${from}"]`).dispatchEvent("click");
  await page.getByTestId("order-support").click();
  await page.locator(`[data-unit="${aux}"]`).dispatchEvent("click");
  await page.locator(`[data-highlight="${dest}"]`).first().dispatchEvent("click");
  await page.locator(`[data-order-chip="${from}"]`).waitFor({ timeout: 10000 });
}

const browser = await chromium.launch();
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const a = await ctxA.newPage();
const b = await ctxB.newPage();
a.on("pageerror", (e) => console.log("[A pageerror]", e.message));
b.on("pageerror", (e) => console.log("[B pageerror]", e.message));

try {
  await signIn(a, "alice+clerk_test@example.com", "user_3Eyes9wXBMeZwJET7ToAp1QF8Jl");
  await signIn(b, "bob+clerk_test@example.com", "user_3EyesMjqe5yYGxM7mltw5Dw0FU9");

  // ------------------------------------------------------------ lobby
  await a.goto(`${BASE}/rooms/new`, { waitUntil: "domcontentloaded" });
  await a.fill("#name", ROOM_NAME);
  await a.click("button[type=submit]");
  await a.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const roomId = a.url().split("/").pop();
  log(`room ${roomId}`);
  await b.waitForSelector(`li:has-text("${ROOM_NAME}")`, { timeout: 20000 });
  await b.locator(`li:has-text("${ROOM_NAME}")`).getByRole("button", { name: "Rejoindre" }).click();
  await b.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 });
  await a.getByRole("button", { name: /France/ }).click();
  await b.getByRole("button", { name: /Allemagne/ }).click();
  await a.locator('button:has-text("France")').filter({ hasText: "Vous" }).waitFor({ timeout: 15000 });
  await b.locator('button:has-text("Allemagne")').filter({ hasText: "Vous" }).waitFor({ timeout: 15000 });
  await a.getByRole("button", { name: /Lancer la partie/ }).click();
  await a.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });
  await b.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });

  const phase1 = await activePhase(roomId);
  if (phase1.season !== "spring" || phase1.year !== 1901) fail("phase 1 should be spring 1901");

  // ---- 5. bots submit plausible orders at phase open
  const { data: botPlayers } = await supabase
    .from("room_players")
    .select()
    .eq("room_id", roomId)
    .eq("is_bot", true);
  if (botPlayers.length !== 5) fail(`expected 5 bots, got ${botPlayers.length}`);
  const { data: botOrders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", phase1.id)
    .in("player_id", botPlayers.map((p) => p.id));
  if (botOrders.length !== 16) fail(`expected 16 bot orders (Russia has 4 units), got ${botOrders.length}`);
  const botMoves = botOrders.filter((o) => o.order_type === "move");
  if (botMoves.length < 8) fail(`bots too passive: only ${botMoves.length} moves`);
  if (!botOrders.every((o) => o.is_submitted)) fail("bot orders must be submitted");
  log(`OK 5: bots submitted ${botOrders.length} orders at phase open (${botMoves.length} moves)`);

  // ---- 1. standoff: par→bur vs mun→bur
  await a.locator('[data-unit="par"]').waitFor({ timeout: 20000 });
  await orderMove(a, "par", "bur");
  await a.getByTestId("submit-orders").click();
  await a.locator('[data-testid="orders-locked"]').waitFor({ timeout: 45000 });
  await b.locator('[data-unit="mun"]').waitFor({ timeout: 20000 });
  await orderMove(b, "mun", "bur");
  // B's submit triggers the resolution — the phase advances instead of locking
  await b.getByTestId("submit-orders").click();

  await until("spring 1901 resolved", async () => {
    const { data } = await supabase.from("phases").select().eq("id", phase1.id).single();
    return data.status === "resolved" ? data : null;
  });
  const parOrder = (await supabase.from("orders").select().eq("phase_id", phase1.id).eq("unit_territory", "par").single()).data;
  const munOrder = (await supabase.from("orders").select().eq("phase_id", phase1.id).eq("unit_territory", "mun").single()).data;
  if (parOrder.result !== "bounced" || munOrder.result !== "bounced") {
    fail(`standoff results: par=${parOrder.result} mun=${munOrder.result}`);
  }
  const burT = await territory(roomId, "bur");
  if (burT.occupant_nation) fail("bur should stay empty after the standoff");
  if ((await territory(roomId, "par")).occupant_nation !== "France") fail("par must keep its French army");
  if ((await territory(roomId, "mun")).occupant_nation !== "Allemagne") fail("mun must keep its German army");
  log("OK 1: equal attacks on Bourgogne bounced, map unchanged");

  // results are broadcast: A sees the bounce arrows without reloading
  await a.locator('[data-result-arrow="par"][data-result="bounced"]').waitFor({ timeout: 20000 });
  await a.locator('[data-testid="results-panel"]').waitFor({ timeout: 10000 });
  log("OK: post-resolution feedback rendered (bounced arrow + summary panel)");
  await a.screenshot({ path: `${SHOTS}/h1-standoff.png`, fullPage: true });

  // ------------------------------------------- autumn 1901, doctored board
  const phase2 = await until("autumn 1901 open", async () => {
    const p = await activePhase(roomId);
    return p && p.season === "autumn" && p.type === "movement" ? p : null;
  });

  const place = async (code, nation, unit_type) => {
    await supabase
      .from("territories")
      .update({ occupant_nation: nation, unit_type, unit_coast: null })
      .eq("room_id", roomId)
      .eq("code", code);
  };
  await place("bur", "France", "army");
  await place("ruh", "France", "army");
  await place("pic", "France", "army");
  await place("hol", "France", "army");
  await place("mar", null, null);
  await place("bel", "Allemagne", "army");
  await place("kie", "Allemagne", "army");
  await place("ber", null, null);
  // bots stand down for determinism (their units auto-hold)
  await supabase.from("orders").delete().eq("phase_id", phase2.id);
  log("autumn 1901 board doctored");

  // A: bur→mun (supported by ruh) and pic→bel (supported by hol)
  await a.locator('[data-unit="bur"]').waitFor({ timeout: 20000 });
  await orderMove(a, "bur", "mun");
  await orderSupportMove(a, "ruh", "bur", "mun");
  await orderMove(a, "pic", "bel");
  await orderSupportMove(a, "hol", "pic", "bel");
  await a.getByTestId("submit-orders").click();
  await a.locator('[data-testid="orders-locked"]').waitFor({ timeout: 45000 });
  // B: kie→hol cuts Holland's support of the Belgium assault
  await b.locator('[data-unit="kie"]').waitFor({ timeout: 20000 });
  await orderMove(b, "kie", "hol");
  await b.getByTestId("submit-orders").click();

  await until("autumn 1901 resolved", async () => {
    const { data } = await supabase.from("phases").select().eq("id", phase2.id).single();
    return data.status === "resolved" ? data : null;
  });
  const o2 = (await supabase.from("orders").select().eq("phase_id", phase2.id)).data;
  const result = (prov) => o2.find((o) => o.unit_territory === prov)?.result;

  // ---- 2. supported attack succeeded against a holding defender
  if (result("bur") !== "success" || result("ruh") !== "success") {
    fail(`supported attack failed: bur=${result("bur")} ruh=${result("ruh")}`);
  }
  if ((await territory(roomId, "mun")).occupant_nation !== "France") fail("mun should now be French");
  log("OK 2: supported attack dislodged the defender of Munich");

  // ---- 3. cut support: pic→bel bounced because hol was attacked
  if (result("hol") !== "cut") fail(`hol support should be cut, got ${result("hol")}`);
  if (result("pic") !== "bounced") fail(`pic should bounce, got ${result("pic")}`);
  if ((await territory(roomId, "bel")).occupant_nation !== "Allemagne") fail("bel must stay German");
  log("OK 3: support cut by the attack on Hollande, assault on Belgique failed");

  // ---- 6. retreat sub-phase
  const retreatPhase = await until("retreat phase open", async () => {
    const p = await activePhase(roomId);
    return p && p.type === "retreat" ? p : null;
  });
  const dislodged = retreatPhase.summary?.dislodged ?? [];
  if (!dislodged.some((d) => d.prov === "mun" && d.nation === "Allemagne")) {
    fail(`retreat summary missing mun: ${JSON.stringify(dislodged)}`);
  }
  await b.locator('[data-testid="retreat-panel"]').waitFor({ timeout: 20000 });
  await b.locator('[data-retreat-unit="mun"]').click();
  const dest = dislodged.find((d) => d.prov === "mun").options[0].split("/")[0];
  await b.locator(`[data-highlight="${dest}"]`).first().waitFor({ timeout: 10000 });
  await b.locator(`[data-highlight="${dest}"]`).first().dispatchEvent("click");
  await b.getByTestId("submit-orders").click();
  await until("retreat applied", async () => {
    const t = await territory(roomId, dest);
    return t.occupant_nation === "Allemagne" ? t : null;
  });
  log(`OK 6: dislodged army retreated Munich → ${dest}, map updated`);
  await b.screenshot({ path: `${SHOTS}/h6-retreat.png`, fullPage: true });

  // ---- 7. winter adjustment then year rollover
  const winter = await until("winter adjustment open", async () => {
    const p = await activePhase(roomId);
    return p && p.season === "winter" && p.type === "adjustment" ? p : null;
  });
  if ((await territory(roomId, "mun")).owner_nation !== "France") {
    fail("Munich SC ownership should have flipped to France after fall");
  }
  await expireActivePhase(roomId);
  const spring1902 = await until("spring 1902 open", async () => {
    const p = await activePhase(roomId);
    return p && p.season === "spring" && p.year === 1902 ? p : null;
  });
  log("OK 7: full Spring→Retreat→Fall→Retreat→Winter cycle, year advanced to 1902");

  // ---- 4. timer expiry: A submits, B does not → auto-hold + resolution
  await supabase.from("orders").delete().eq("phase_id", spring1902.id); // bots hold
  await a.locator('[data-testid="order-panel"]').waitFor({ timeout: 20000 });
  await until("A page on spring 1902", async () =>
    (await a.locator('[data-testid="phase-season"]').textContent())?.includes("1902") ? true : null
  );
  await a.getByTestId("submit-orders").click();
  await a.locator('[data-testid="orders-locked"]').waitFor({ timeout: 45000 });
  await expireActivePhase(roomId);
  await until("spring 1902 resolved by expiry", async () => {
    const { data } = await supabase.from("phases").select().eq("id", spring1902.id).single();
    return data.status === "resolved" ? data : null;
  });
  const { data: bAuto } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", spring1902.id)
    .eq("nation", "Allemagne");
  if (bAuto.length === 0 || !bAuto.every((o) => o.order_type === "hold" && o.is_submitted)) {
    fail(`expected auto-hold orders for Germany, got ${JSON.stringify(bAuto.map((o) => o.order_type))}`);
  }
  log("OK 4: timer expiry auto-held the silent player and resolved the phase");

  // ---- 9. elimination: Germany manually reduced to 0 SCs
  await until("autumn 1902 open", async () => {
    const p = await activePhase(roomId);
    return p && p.season === "autumn" && p.year === 1902 && p.type === "movement" ? p : null;
  });
  await supabase
    .from("territories")
    .update({ owner_nation: "France" })
    .eq("room_id", roomId)
    .eq("owner_nation", "Allemagne");
  // German units leave the supply centers so occupation can't win them back
  const { data: gUnits } = await supabase
    .from("territories")
    .select()
    .eq("room_id", roomId)
    .eq("occupant_nation", "Allemagne");
  for (const t of gUnits) {
    await supabase
      .from("territories")
      .update({ occupant_nation: null, unit_type: null, unit_coast: null })
      .eq("id", t.id);
  }
  await place("sil", "Allemagne", "army");
  const autumn1902 = await activePhase(roomId);
  await supabase.from("orders").delete().eq("phase_id", autumn1902.id);
  await expireActivePhase(roomId);
  await until("Germany eliminated", async () => {
    const { data } = await supabase
      .from("room_players")
      .select()
      .eq("room_id", roomId)
      .eq("nation", "Allemagne")
      .single();
    return data.is_eliminated ? data : null;
  });
  if ((await territory(roomId, "sil")).occupant_nation) fail("eliminated units must be removed");
  await b.locator('[data-testid="spectator-banner"]').waitFor({ timeout: 25000 });
  log("OK 9: Germany at 0 SCs eliminated after fall, B is a spectator");

  // ---- 8. victory at 17 supply centers
  const { data: scs } = await supabase
    .from("territories")
    .select()
    .eq("room_id", roomId)
    .eq("is_supply_center", true);
  for (const t of scs.slice(0, 17)) {
    await supabase.from("territories").update({ owner_nation: "France" }).eq("id", t.id);
  }
  await expireActivePhase(roomId);
  await until("room finished with France victorious", async () => {
    const { data } = await supabase.from("rooms").select().eq("id", roomId).single();
    return data.status === "finished" && data.winner_nation === "France" ? data : null;
  });
  await a.locator('[data-testid="victory-screen"]').waitFor({ timeout: 25000 });
  await b.locator('[data-testid="victory-screen"]').waitFor({ timeout: 25000 });
  await a.locator('[data-winner="France"]').waitFor({ timeout: 5000 });
  log("OK 8: victory screen shown to every player, France wins");
  await a.screenshot({ path: `${SHOTS}/h8-victory.png`, fullPage: true });

  console.log(`\nALL GOAL-3 CHECKS PASSED — room ${roomId}`);
} catch (err) {
  console.error("\nVERIFICATION FAILED:", err.message);
  await a.screenshot({ path: `${SHOTS}/h-fail-a.png`, fullPage: true }).catch(() => {});
  await b.screenshot({ path: `${SHOTS}/h-fail-b.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
