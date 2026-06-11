import type { Metadata } from "next";
import { ClerkProvider, SignedIn, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";

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
          <header className="border-b border-stone-800 bg-stone-950/80">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
              <Link href="/" className="text-xl font-bold tracking-wide">
                ⚔️ Vise <span className="text-amber-500">Diplomacy</span>
              </Link>
              <SignedIn>
                <UserButton />
              </SignedIn>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
