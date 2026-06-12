import type { Metadata } from "next";
import { ClerkProvider, SignedIn, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";
import { CornerSparkle } from "./decor";

export const metadata: Metadata = {
  title: "Vise Diplomacy",
  description:
    "Jeu de stratégie multijoueur en ligne inspiré du jeu de plateau Diplomacy.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="fr">
        <body className="min-h-screen antialiased">
          <header className="sticky top-0 z-30 border-b border-[var(--card-border)] bg-[#0f1117]/80 backdrop-blur-md">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
              <Link href="/" className="text-xl font-bold tracking-wide">
                ⚔️ <span className="text-[var(--text-1)]">Vise</span>{" "}
                <span className="text-amber-500">Diplomacy</span>
              </Link>
              <SignedIn>
                <UserButton />
              </SignedIn>
            </div>
          </header>
          {/* no z-index here: fixed overlays inside (chat, info panel, victory
              screen) must stack in the root context, above the sticky header */}
          <main className="relative mx-auto max-w-5xl px-4 py-8">{children}</main>
          <CornerSparkle />
        </body>
      </html>
    </ClerkProvider>
  );
}
