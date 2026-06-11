import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// /api/cron (Vercel Cron, CRON_SECRET) and /api/resolve-phase (client
// deadline trigger, x-resolve-token) authenticate inside their handlers,
// not with a Clerk session
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cron(.*)",
  "/api/resolve-phase",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
