// Verification of the sidebar restructure: the left sidebar holds only the
// phase status card and the order panel; leaderboard, history and draw
// proposal live in the toggleable info panel. Checked at desktop and mobile
// viewport widths.
// Usage: node scripts/verify-layout.mjs (server must be running on :3001)
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
const ROOM_NAME = `Layout ${Date.now().toString(36).toUpperCase()}`;
const SHOTS = ".verify";
mkdirSync(SHOTS, { recursive: true });

const env = readFileSync(".env.local", "utf8");
const grab = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))[1].trim();
const secretKey = grab("CLERK_SECRET_KEY");

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

// the info panel content checks, identical at both widths
async function checkInfoPanel(page, label) {
  await page.getByTestId("info-toggle").click();
  await page.getByTestId("info-panel").waitFor({ timeout: 10000 });
  // Classement: 7 nations ranked, with supply-center counts
  await page.getByTestId("info-tab-classement").click();
  const rows = await page.locator('[data-testid="leaderboard"] > li').count();
  if (rows !== 7) fail(`${label}: leaderboard rows ${rows} != 7`);
  log(`OK ${label}: leaderboard reachable (7 nations)`);
  // Historique: no resolved phase yet -> placeholder text
  await page.getByTestId("info-tab-historique").click();
  await page.locator("text=Aucune phase résolue").waitFor({ timeout: 5000 });
  log(`OK ${label}: history tab reachable`);
  // Égalité: draw vote button present
  await page.getByTestId("info-tab-egalite").click();
  await page.getByTestId("draw-vote").waitFor({ timeout: 5000 });
  log(`OK ${label}: draw proposal reachable`);
}

async function checkMapUsable(page, label) {
  // the map is visible and interactive: clicking the Paris army highlights moves
  const unitCount = await page.locator("[data-unit]").count();
  if (unitCount !== 22) fail(`${label}: ${unitCount} units on map, expected 22`);
  await page.locator('[data-unit="par"]').dispatchEvent("click");
  await page.locator('[data-highlight="bur"]').first().waitFor({ timeout: 10000 });
  // cancel the selection so the next check starts clean
  await page.locator('[data-unit="par"]').dispatchEvent("click");
  log(`OK ${label}: map visible and interactive (22 units, highlights respond)`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

try {
  await signIn(page, "alice+clerk_test@example.com", "user_3Eyes9wXBMeZwJET7ToAp1QF8Jl");

  // ---- create a solo room (bots fill the other nations) and launch
  await page.goto(`${BASE}/rooms/new`, { waitUntil: "domcontentloaded" });
  await page.fill("#name", ROOM_NAME);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const roomId = page.url().split("/").pop();
  log(`room ${roomId}`);
  await page.getByRole("button", { name: /France/ }).click();
  await page
    .locator('button:has-text("France")')
    .filter({ hasText: "Vous" })
    .waitFor({ timeout: 15000 });
  // the launch inserts 75 territories + bot orders — give it time, and
  // re-click once in case the first click was lost to a lobby re-render
  await page.getByRole("button", { name: /Lancer la partie/ }).click();
  try {
    await page.waitForURL(/\/rooms\/.*\/game$/, { timeout: 45000 });
  } catch {
    log("launch did not navigate, re-clicking");
    await page.getByRole("button", { name: /Lancer la partie/ }).click();
    await page.waitForURL(/\/rooms\/.*\/game$/, { timeout: 60000 });
  }
  await page.locator('[data-testid="order-panel"]').waitFor({ timeout: 20000 });

  // ================================================== desktop (1440x900)
  // ---- 1. the sidebar holds exactly two panels: phase status + orders
  const sidebarPanels = await page.locator("aside > div").count();
  if (sidebarPanels !== 2) fail(`sidebar holds ${sidebarPanels} panels, expected 2`);
  await page.locator('aside [data-testid="phase-timer"]').waitFor({ timeout: 5000 });
  await page.locator('aside [data-testid="phase-season"]').waitFor({ timeout: 5000 });
  await page.locator('aside [data-testid="order-panel"]').waitFor({ timeout: 5000 });
  for (const gone of ["results-panel", "draw-panel", "leaderboard"]) {
    if (await page.locator(`aside [data-testid="${gone}"]`).count())
      fail(`"${gone}" must not live in the sidebar anymore`);
  }
  log("OK desktop: sidebar = phase status + order panel only");

  await checkMapUsable(page, "desktop");
  await checkInfoPanel(page, "desktop");
  await page.screenshot({ path: `${SHOTS}/layout-desktop-info.png`, fullPage: false });

  // ---- info panel and chat coexist without sharing a trigger or corner
  const infoBox = await page.getByTestId("info-toggle").boundingBox();
  const chatBox = await page.getByTestId("chat-toggle").boundingBox();
  if (!infoBox || !chatBox) fail("both floating triggers must be visible");
  if (infoBox.x + infoBox.width >= chatBox.x)
    fail("info and chat triggers overlap horizontally");
  log("OK desktop: info trigger (bottom-left) and chat trigger (bottom-right) distinct");

  // panel closes
  await page.getByTestId("info-close").click();
  if (await page.getByTestId("info-panel").count()) fail("info panel should close");
  await page.screenshot({ path: `${SHOTS}/layout-desktop.png`, fullPage: false });

  // ---- the map gained width: the SVG now extends past the old 1024px shell
  const mapBox = await page.locator("svg[viewBox]").first().boundingBox();
  if (!mapBox) fail("map svg not found");
  log(`map box: x=${Math.round(mapBox.x)} w=${Math.round(mapBox.width)}`);
  if (mapBox.x + mapBox.width <= 1024)
    fail(`map right edge ${Math.round(mapBox.x + mapBox.width)} still within the old 1024px shell`);
  log("OK desktop: map area widened beyond the old max-w-5xl shell");

  // ================================================== mobile (390x844)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);

  await checkMapUsable(page, "mobile");
  await checkInfoPanel(page, "mobile");
  // the drawer must not cover the whole screen (map stays reachable behind it)
  const panelBox = await page.getByTestId("info-panel").boundingBox();
  if (panelBox.width > 390 * 0.95) fail(`mobile drawer too wide: ${panelBox.width}px`);
  await page.screenshot({ path: `${SHOTS}/layout-mobile-info.png`, fullPage: false });
  await page.getByTestId("info-close").click();
  // no horizontal overflow at mobile width
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  if (overflow > 1) fail(`horizontal overflow of ${overflow}px at 390px width`);
  log("OK mobile: drawer bounded, no horizontal overflow");
  await page.screenshot({ path: `${SHOTS}/layout-mobile.png`, fullPage: true });

  console.log(`\nALL LAYOUT CHECKS PASSED — room ${roomId}`);
} catch (err) {
  console.error("\nVERIFICATION FAILED:", err.message);
  await page.screenshot({ path: `${SHOTS}/layout-fail.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
