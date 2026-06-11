import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { RoomWithCount } from "@/lib/types";
import RoomBrowser from "./room-browser";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { userId } = await auth();
  if (!userId) {
    return (
      <div className="mx-auto mt-16 max-w-xl text-center">
        <h1 className="text-4xl font-bold">
          Vise <span className="text-amber-500">Diplomacy</span>
        </h1>
        <p className="mt-4 text-lg text-stone-400">
          Négociez, trahissez, conquérez l&apos;Europe de 1901. Connectez-vous
          pour rejoindre ou créer une partie.
        </p>
        <SignInButton mode="redirect">
          <button className="mt-8 rounded-lg bg-amber-600 px-8 py-3 text-lg font-bold text-stone-950 transition hover:bg-amber-500">
            Se connecter
          </button>
        </SignInButton>
      </div>
    );
  }

  const supabase = getSupabaseServer();
  const { data } = await supabase
    .from("rooms")
    .select("*, room_players(count)")
    .eq("is_public", true)
    .eq("status", "waiting")
    .order("created_at", { ascending: false })
    .limit(30);

  return <RoomBrowser initialRooms={(data ?? []) as RoomWithCount[]} />;
}
