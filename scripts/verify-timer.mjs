// Verifies the client-side deadline trigger: a 1-minute phase with no
// submitted orders must resolve on its own when the open client's countdown
// reaches zero — no cron involved.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
const env = readFileSync(".env.local", "utf8");
const grab = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))[1].trim();
const supabase = createClient(grab("NEXT_PUBLIC_SUPABASE_URL"), grab("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
  db: { schema: "diplomacy" },
});
const log = (m) => console.log(`[verify] ${m}`);
const fail = (m) => {
  throw new Error(m);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const a = await ctx.newPage();
a.on("pageerror", (e) => console.log("[A pageerror]", e.message));

try {
  // sign in Alice
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${grab("CLERK_SECRET_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: "user_3Eyes9wXBMeZwJET7ToAp1QF8Jl",
      expires_in_seconds: 600,
    }),
  });
  const { token } = await res.json();
  await a.goto(BASE, { waitUntil: "domcontentloaded" });
  await a.waitForFunction(() => window.Clerk?.loaded, { timeout: 60000 });
  await a.evaluate(async (ticket) => {
    const r = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    await window.Clerk.setActive({ session: r.createdSessionId });
  }, token);
  await a.goto(`${BASE}/rooms/new`, { waitUntil: "domcontentloaded" });
  await a.waitForSelector("#name", { timeout: 30000 });
  log("signed in");

  // 1-minute phases
  await a.fill("#name", `Minute ${Date.now().toString(36).toUpperCase()}`);
  await a.locator("#phase_duration").fill("1");
  await a.click("button[type=submit]");
  await a.waitForURL(/\/rooms\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const roomId = a.url().split("/").pop();
  await a.getByRole("button", { name: /Lancer la partie/ }).click();
  await a.waitForURL(/\/rooms\/.*\/game$/, { timeout: 30000 });
  log(`game started, room ${roomId} — waiting out the 1-minute countdown…`);

  const { data: phase1 } = await supabase
    .from("phases")
    .select()
    .eq("room_id", roomId)
    .eq("phase_number", 1)
    .single();
  const duration = new Date(phase1.ends_at) - new Date(phase1.starts_at);
  if (duration !== 60_000) fail(`phase duration should be 60s, got ${duration / 1000}s`);

  // submit nothing; the open client must fire the resolution at 00:00
  const deadline = Date.now() + 110_000;
  let resolved = null;
  while (Date.now() < deadline) {
    const { data } = await supabase.from("phases").select().eq("id", phase1.id).single();
    if (data.status === "resolved") {
      resolved = data;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!resolved) fail("phase did not resolve after the countdown expired");
  log("OK: phase resolved automatically after the client countdown hit zero");

  const { data: orders } = await supabase
    .from("orders")
    .select()
    .eq("phase_id", phase1.id)
    .eq("is_submitted", true);
  const aliceHolds = orders.filter(
    (o) => o.order_type === "hold" && o.status === "resolved"
  );
  if (orders.length !== 22) fail(`expected 22 resolved orders, got ${orders.length}`);
  if (aliceHolds.length < 3) fail("the silent player's units should auto-hold");
  log(`OK: ${orders.length} orders resolved, silent player's units auto-held`);

  const { data: phase2 } = await supabase
    .from("phases")
    .select()
    .eq("room_id", roomId)
    .eq("status", "active")
    .single();
  if (!phase2 || phase2.season !== "autumn") fail("next phase (autumn) should be open");
  log("OK: next phase opened automatically");

  // UI followed along in realtime
  await a.locator('[data-testid="phase-season"]', { hasText: "Automne" }).waitFor({ timeout: 20000 });
  log("OK: open client moved to the new phase without reloading");

  console.log("\nCLIENT-TIMER TRIGGER VERIFIED");
} catch (err) {
  console.error("\nVERIFICATION FAILED:", err.message);
  await a.screenshot({ path: ".verify/t-fail.png", fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
