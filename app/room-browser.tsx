"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import type { RoomWithCount } from "@/lib/types";
import { joinByCode, joinRoom, type ActionState } from "./actions";

export default function RoomBrowser({
  initialRooms,
}: {
  initialRooms: RoomWithCount[];
}) {
  const [rooms, setRooms] = useState<RoomWithCount[]>(initialRooms);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isJoining, startJoining] = useTransition();
  const [codeState, codeAction, codePending] = useActionState<ActionState, FormData>(
    joinByCode,
    {}
  );

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    const { data } = await supabase
      .from("rooms")
      .select("*, room_players(count)")
      .eq("is_public", true)
      .eq("status", "waiting")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setRooms(data as RoomWithCount[]);
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const channel = supabase
      .channel("public-rooms")
      .on(
        "postgres_changes",
        { event: "*", schema: "diplomacy", table: "rooms" },
        () => refresh()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "diplomacy", table: "room_players" },
        () => refresh()
      )
      .subscribe();
    refresh();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  const handleJoin = (roomId: string) => {
    setJoinError(null);
    startJoining(async () => {
      const result = await joinRoom(roomId);
      if (result?.error) setJoinError(result.error);
    });
  };

  return (
    <div className="space-y-10">
      <section className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Salon des parties</h1>
          <p className="mt-1 text-stone-400">
            Rejoignez une partie publique ou créez la vôtre.
          </p>
        </div>
        <Link
          href="/rooms/new"
          className="rounded-lg bg-amber-600 px-5 py-2.5 font-semibold text-stone-950 transition hover:bg-amber-500"
        >
          + Créer une partie
        </Link>
      </section>

      <section className="rounded-xl border border-stone-800 bg-stone-900/50 p-5">
        <h2 className="mb-3 font-semibold text-stone-300">
          Rejoindre avec un code
        </h2>
        <form action={codeAction} className="flex flex-wrap items-center gap-3">
          <input
            name="code"
            maxLength={6}
            placeholder="ABC123"
            autoComplete="off"
            className="w-36 rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 font-mono text-lg uppercase tracking-widest outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={codePending}
            className="rounded-lg border border-amber-600 px-4 py-2 font-semibold text-amber-500 transition hover:bg-amber-600 hover:text-stone-950 disabled:opacity-50"
          >
            {codePending ? "Recherche…" : "Rejoindre"}
          </button>
          {codeState.error && (
            <p className="text-sm text-red-400">{codeState.error}</p>
          )}
        </form>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">
          Parties publiques ouvertes
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500 align-middle" />
        </h2>
        {joinError && <p className="mb-3 text-sm text-red-400">{joinError}</p>}
        {rooms.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-800 p-8 text-center text-stone-500">
            Aucune partie ouverte pour le moment. Créez la première !
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rooms.map((room) => {
              const playerCount = room.room_players?.[0]?.count ?? 0;
              return (
                <li
                  key={room.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-stone-800 bg-stone-900/50 p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{room.name}</p>
                    <p className="mt-0.5 text-sm text-stone-400">
                      {playerCount}/{room.max_players} joueurs ·{" "}
                      {room.total_phases} phases ·{" "}
                      {room.phase_duration_minutes} min/phase
                    </p>
                  </div>
                  <button
                    onClick={() => handleJoin(room.id)}
                    disabled={isJoining || playerCount >= room.max_players}
                    className="shrink-0 rounded-lg bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-500 disabled:opacity-50"
                  >
                    Rejoindre
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
