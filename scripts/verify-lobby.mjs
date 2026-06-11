// End-to-end verification of the lobby flow with two Clerk accounts.
// Usage: node scripts/verify-lobby.mjs (server must be running on :3000)
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
const PASSWORD = "ViseDiplo!2026!Secret";
const ROOM_NAME = `Guerre ${Date.now().toString(36).toUpperCase()}`;
const SHOTS = ".verify";
mkdirSync(SHOTS, { recursive: true });

function log(msg) {
  console.log(`[verify] ${msg}`);
}

async function signIn(page, email, userId) {
  // Server-minted sign-in token => ticket strategy in the browser.
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
  });
  const { token } = await res.json();
  if (!token) throw new Error(`no sign-in token for ${email}`);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk?.loaded, { timeout: 60000 });
  await page.evaluate(async (ticket) => {
    const res = await window.Clerk.client.signIn.create({
      strategy: "ticket",
      ticket,
    });
    if (res.status !== "complete")
      throw new Error(`sign-in status: ${res.status}`);
    await window.Clerk.setActive({ session: res.createdSessionId });
  }, token);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Salon des parties", { timeout: 30000 });
  log(`${email} signed in`);
}

// Waits until the locator's text matches, without any page reload.
async function waitForText(page, selector, expected, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.locator(selector).first().innerText().catch(() => "");
    if (text.includes(expected)) {
      log(`OK (realtime): ${label}`);
      return;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`TIMEOUT waiting for "${expected}" — ${label}`);
}

// Clerk testing token: lets automated browsers through bot/client-trust
// protection on dev instances (same mechanism as @clerk/testing).
const secretKey =
  process.env.CLERK_SECRET_KEY ??
  readFileSync(".env.local", "utf8").match(/^CLERK_SECRET_KEY=(.+)$/m)[1].trim();
const tokenRes = await fetch("https://api.clerk.com/v1/testing_tokens", {
  method: "POST",
  headers: { Authorization: `Bearer ${secretKey}` },
});
const { token: testingToken } = await tokenRes.json();
if (!testingToken) throw new Error("could not create Clerk testing token");

async function addTestingToken(ctx) {
  await ctx.route(/clerk\.accounts\.dev\/v1\//, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("__clerk_testing_token", testingToken);
    await route.continue({ url: url.toString() });
  });
}

const browser = await chromium.launch();
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
await addTestingToken(ctxA);
await addTestingToken(ctxB);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
a.on("pageerror", (e) => console.log("[A pageerror]", e.message));
b.on("pageerror", (e) => console.log("[B pageerror]", e.message));

try {
  // 1. Two different Clerk accounts
  await signIn(a, "alice+clerk_test@example.com", "user_3Eyes9wXBMeZwJET7ToAp1QF8Jl");
  await signIn(b, "bob+clerk_test@example.com", "user_3EyesMjqe5yYGxM7mltw5Dw0FU9");

  // 2. A creates a public room and receives a join code
  await a.goto(`${BASE}/rooms/new`, { waitUntil: "domcontentloaded" });
  await a.fill("#name", ROOM_NAME);
  await a.click("button[type=submit]");
  await a.waitForURL(/\/rooms\/[0-9a-f-]{36}/, { timeout: 30000 });
  const roomUrl = a.url();
  const code = (await a.locator("span.font-mono").first().innerText()).trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error(`bad join code: ${code}`);
  log(`room created: ${roomUrl} — join code ${code}`);
  await a.screenshot({ path: `${SHOTS}/1-host-lobby.png`, fullPage: true });

  // 3. B sees the room on the homepage and joins
  await b.waitForSelector(`li:has-text("${ROOM_NAME}")`, { timeout: 20000 });
  log("room visible on B's homepage (realtime insert)");
  await b.screenshot({ path: `${SHOTS}/2-b-sees-room.png`, fullPage: true });
  await b
    .locator(`li:has-text("${ROOM_NAME}")`)
    .getByRole("button", { name: "Rejoindre" })
    .click();
  await b.waitForURL(/\/rooms\/[0-9a-f-]{36}/, { timeout: 30000 });
  if (!roomUrl.includes(new URL(b.url()).pathname))
    throw new Error("B landed in a different room");
  log("B joined the room");

  // Both see each other — A's page must update without reload
  await waitForText(a, "h2:has-text('Joueurs')", "(2/7)", "A sees B arrive");
  await waitForText(b, "h2:has-text('Joueurs')", "(2/7)", "B sees both players");
  await a.screenshot({ path: `${SHOTS}/3-two-players.png`, fullPage: true });

  // 4. Each claims a nation, visible live on the other side
  await a.getByRole("button", { name: /France/ }).click();
  await waitForText(b, "button:has-text('France')", "Alice", "B sees A claim France");
  await b.getByRole("button", { name: /Angleterre/ }).click();
  await waitForText(a, "button:has-text('Angleterre')", "Bob", "A sees B claim Angleterre");
  await a.screenshot({ path: `${SHOTS}/4-nations-claimed.png`, fullPage: true });

  // 5. A launches the game
  await a.getByRole("button", { name: /Lancer la partie/ }).click();
  await waitForText(a, "body", "La partie a été lancée", "A sees game started");
  await waitForText(b, "body", "La partie a été lancée", "B sees game started (realtime)");
  await a.screenshot({ path: `${SHOTS}/5-game-started.png`, fullPage: true });
  await b.screenshot({ path: `${SHOTS}/5-game-started-b.png`, fullPage: true });

  // Bots filled the remaining nations
  await waitForText(a, "h2:has-text('Joueurs')", "(7/7)", "bots assigned to free nations");

  console.log(`\nALL CHECKS PASSED — room ${roomUrl.split("/").pop()} (${code})`);
} catch (err) {
  console.error("\nVERIFICATION FAILED:", err.message);
  await a.screenshot({ path: `${SHOTS}/fail-a.png`, fullPage: true }).catch(() => {});
  await b.screenshot({ path: `${SHOTS}/fail-b.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
