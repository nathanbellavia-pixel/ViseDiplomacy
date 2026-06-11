// End-to-end verification of Goal 2: map, orders, adjustments, chat.
// Usage: node scripts/verify-game.mjs (server must be running on :3001)
//
// SUPERSEDED by verify-goal3.mjs: since Goal 3, a phase resolves as soon as
// every human submits, so the "both players stay locked" and manual-winter
// steps below no longer match the engine. Kept for reference.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
const ROOM_NAME = `Front ${Date.now().toString(36).toUpperCase()}`;
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

async function waitCount(page, selector, expected, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let n = -1;
  while (Date.now() < deadline) {
    n = await page.locator(selector).count();
    if (n === expected) {
      log(`OK: ${label} (${n})`);
      return;
    }
    await page.waitForTimeout(300);
  }
  fail(`TIMEOUT ${label}: expected ${expected}, got ${n}`);
}

async function waitVisible(page, selector, label, timeout = 20000) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
  log(`OK: ${label}`);
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

  // ---- lobby: create, join, claim nations, launch
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

  // ---- 1. both land on the game page with correct starting positions
  await a.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });
  await b.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });
  log("OK: both redirected to the game page");

  const { data: terr } = await supabase.from("territories").select().eq("room_id", roomId);
  if (terr.length !== 75) fail(`territories: ${terr.length} != 75`);
  if (terr.filter((t) => t.is_supply_center).length !== 34) fail("supply centers != 34");
  if (terr.filter((t) => t.unit_type).length !== 22) fail("starting units != 22");
  const par = terr.find((t) => t.code === "par");
  if (par.unit_type !== "army" || par.occupant_nation !== "France") fail("Paris should hold a French army");
  const stp = terr.find((t) => t.code === "stp");
  if (stp.unit_type !== "fleet" || stp.unit_coast !== "sc") fail("StP should hold F stp/sc");
  log("OK: DB starting positions (75 territories, 34 SCs, 22 units)");

  await waitCount(a, "[data-unit]", 22, "map shows all 22 starting units");
  await waitCount(a, "[data-sc]", 34, "map shows 34 supply-center stars");
  await a.screenshot({ path: `${SHOTS}/g1-start.png`, fullPage: true });

  // ---- 2. click French army in Paris -> bur/gas/pic highlight
  await a.locator('[data-unit="par"]').dispatchEvent("click");
  for (const code of ["bur", "gas", "pic"]) {
    await waitVisible(a, `[data-highlight="${code}"]`, `highlight ${code}`);
  }
  await a.screenshot({ path: `${SHOTS}/g2-highlights.png`, fullPage: true });

  // ---- 3. move order Paris -> Burgundy renders an arrow
  await a.locator('[data-highlight="bur"]').first().dispatchEvent("click");
  await waitVisible(a, '[data-order-arrow="par"][data-order-type="move"]', "move arrow Paris→Bourgogne");
  await a.screenshot({ path: `${SHOTS}/g3-move-arrow.png`, fullPage: true });

  // ---- 4. another unit gets a Support Hold (Berlin supports Munich, on B)
  await b.locator('[data-unit="ber"]').dispatchEvent("click");
  await b.getByTestId("order-support").click();
  await b.locator('[data-unit="mun"]').dispatchEvent("click"); // pick supported unit
  await b.locator('[data-unit="mun"]').dispatchEvent("click"); // its own province = support hold
  await waitVisible(b, '[data-order-indicator="ber"][data-order-type="support-hold"]', "support-hold indicator");
  await b.screenshot({ path: `${SHOTS}/g4-support-hold.png`, fullPage: true });

  // ---- 5. submit orders -> rows with is_submitted = true
  await a.getByTestId("submit-orders").click();
  await waitVisible(a, '[data-testid="orders-locked"]', "A orders locked");
  await b.getByTestId("submit-orders").click();
  await waitVisible(b, '[data-testid="orders-locked"]', "B orders locked");

  const { data: phase1 } = await supabase
    .from("phases")
    .select()
    .eq("room_id", roomId)
    .order("phase_number", { ascending: false })
    .limit(1)
    .single();
  const { data: subOrders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", phase1.id)
    .eq("is_submitted", true);
  if (subOrders.length !== 6) fail(`submitted orders: ${subOrders.length} != 6`);
  const parOrder = subOrders.find((o) => o.unit_territory === "par");
  if (parOrder?.order_type !== "move" || parOrder?.target_territory !== "bur")
    fail("Paris order should be move->bur");
  const berOrder = subOrders.find((o) => o.unit_territory === "ber");
  if (berOrder?.order_type !== "support" || berOrder?.aux_territory !== "mun")
    fail("Berlin order should be support mun");
  log("OK: 6 submitted order rows in Supabase (moves + auto-holds)");

  // realtime HUD: B sees Alice's submitted check without reload
  await waitVisible(b, '[data-player="Alice"][data-submitted="true"]', "B sees Alice submitted (realtime)");

  // ---- 6. private chat in realtime
  await b.getByTestId("chat-toggle").click();
  await b.locator('[data-contact="Alice"]').click();
  await a.getByTestId("chat-toggle").click();
  await a.locator('[data-contact="Bob"]').click();
  await a.getByTestId("chat-input").fill("Rendez-vous à Munich, trahison à prévoir.");
  await a.getByTestId("chat-send").click();
  await b
    .locator('[data-message]', { hasText: "Rendez-vous à Munich" })
    .waitFor({ timeout: 20000 });
  log("OK: B received the private message in realtime");
  await b.getByTestId("chat-input").fill("Compris. L'Autriche n'en saura rien.");
  await b.getByTestId("chat-send").click();
  await a
    .locator('[data-message]', { hasText: "L'Autriche n'en saura rien" })
    .waitFor({ timeout: 20000 });
  log("OK: A received the reply in realtime");
  await a.screenshot({ path: `${SHOTS}/g6-chat.png`, fullPage: true });

  // ---- 7. force a Winter adjustment phase -> build UI
  await supabase.from("phases").update({ status: "resolved" }).eq("id", phase1.id);
  await supabase.from("territories").update({ owner_nation: "France" }).eq("room_id", roomId).eq("code", "spa");
  await supabase
    .from("territories")
    .update({ occupant_nation: null, unit_type: null, unit_coast: null })
    .eq("room_id", roomId)
    .eq("code", "par");
  const { error: phErr } = await supabase.from("phases").insert({
    room_id: roomId,
    phase_number: 2,
    year: 1901,
    season: "winter",
    type: "adjustment",
    status: "active",
    starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 10 * 60000).toISOString(),
  });
  if (phErr) fail(`winter phase insert: ${phErr.message}`);

  await waitVisible(a, '[data-testid="adjustment-panel"]', "A sees Winter adjustment UI (realtime)");
  await a.locator('[data-testid="phase-season"]', { hasText: "Hiver" }).waitFor({ timeout: 15000 });
  await waitVisible(a, '[data-build-slot="par"]', "build slot available in Paris");
  await a.locator('[data-build-slot="par"]').click();
  await a.locator('[data-build-army="par"]').click();
  await waitVisible(a, '[data-build-chip="par"]', "pending build chip");
  await waitVisible(a, '[data-build-mark="par"]', "build mark on the map");
  await a.screenshot({ path: `${SHOTS}/g7-adjustment.png`, fullPage: true });
  await a.getByTestId("submit-orders").click();
  await a.locator('text=Ajustements validés').waitFor({ timeout: 15000 });

  const { data: phase2 } = await supabase
    .from("phases")
    .select()
    .eq("room_id", roomId)
    .eq("phase_number", 2)
    .single();
  const { data: buildOrders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", phase2.id)
    .eq("is_submitted", true);
  if (buildOrders.length !== 1 || buildOrders[0].order_type !== "build" || buildOrders[0].unit_territory !== "par")
    fail(`expected one build order at par, got ${JSON.stringify(buildOrders)}`);
  log("OK: build order saved with is_submitted = true");

  // B (Germany, 3 SCs / 3 units) needs no adjustments
  await b.locator("text=Aucun ajustement nécessaire").waitFor({ timeout: 15000 });
  log("OK: B sees the zero-delta winter state");

  console.log(`\nALL GOAL-2 CHECKS PASSED — room ${roomId}`);
} catch (err) {
  console.error("\nVERIFICATION FAILED:", err.message);
  await a.screenshot({ path: `${SHOTS}/g-fail-a.png`, fullPage: true }).catch(() => {});
  await b.screenshot({ path: `${SHOTS}/g-fail-b.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
