// Screenshots of the redesigned pages: salon, create, lobby, game.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
mkdirSync(".verify", { recursive: true });
const env = readFileSync(".env.local", "utf8");
const grab = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))[1].trim();
const secretKey = grab("CLERK_SECRET_KEY");

async function signIn(page, userId) {
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
  });
  const { token } = await res.json();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk?.loaded, { timeout: 60000 });
  await page.evaluate(async (ticket) => {
    const r = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    await window.Clerk.setActive({ session: r.createdSessionId });
  }, token);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Salon des parties", { timeout: 30000 });
}

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const a = await ctxA.newPage();
const b = await ctxB.newPage();

try {
  await signIn(a, "user_3Eyes9wXBMeZwJET7ToAp1QF8Jl");
  await signIn(b, "user_3EyesMjqe5yYGxM7mltw5Dw0FU9");
  await a.waitForTimeout(1200);
  await a.screenshot({ path: ".verify/d1-salon.png" });

  await a.goto(`${BASE}/rooms/new`, { waitUntil: "domcontentloaded" });
  await a.waitForSelector("#name", { timeout: 20000 });
  await a.screenshot({ path: ".verify/d2-create.png" });

  await a.fill("#name", `Design ${Date.now().toString(36).toUpperCase()}`);
  await a.click("button[type=submit]");
  await a.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const roomUrl = a.url();
  await b.goto(roomUrl, { waitUntil: "domcontentloaded" });
  await a.locator('li:has-text("Bob")').waitFor({ timeout: 20000 });
  const claim = async (page, nation) => {
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: new RegExp(nation) }).click();
      try {
        await page
          .locator(`button:has-text("${nation}")`)
          .filter({ hasText: "Vous" })
          .waitFor({ timeout: 5000 });
        return;
      } catch {}
    }
    throw new Error(`could not claim ${nation}`);
  };
  await claim(a, "France");
  await claim(b, "Allemagne");
  await a.waitForTimeout(500);
  await a.screenshot({ path: ".verify/d3-lobby.png" });

  await a.getByRole("button", { name: /Lancer la partie/ }).click();
  await a.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });
  await a.locator('[data-unit="par"]').waitFor({ timeout: 20000 });
  await a.waitForTimeout(1000);
  await a.screenshot({ path: ".verify/d4-game.png" });

  // partially filled orders -> amber submit button
  await a.locator('[data-unit="par"]').dispatchEvent("click");
  await a.locator('[data-highlight="bur"]').first().dispatchEvent("click");
  await a.waitForTimeout(400);
  await a.screenshot({ path: ".verify/d5-game-order.png" });

  console.log("screenshots written to .verify/d*.png");
} catch (err) {
  console.error("SHOT FAILED:", err.message);
  await a.screenshot({ path: ".verify/d-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
