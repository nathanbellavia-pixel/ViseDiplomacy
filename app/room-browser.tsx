"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import type { RoomWithCount } from "@/lib/types";
import { joinByCode, joinRoom, type ActionState } from "./actions";
import { WorldMapBackdrop } from "./decor";

const PAGE_SIZE = 8;

export default function RoomBrowser({
  initialRooms,
}: {
  initialRooms: RoomWithCount[];
}) {
  const [rooms, setRooms] = useState<RoomWithCount[]>(initialRooms);
  const [page, setPage] = useState(0);
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

  const pageCount = Math.max(1, Math.ceil(rooms.length / PAGE_SIZE));
  const visible = rooms.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="relative space-y-10">
      <WorldMapBackdrop />

      <section className="flex flex-col items-center gap-4 pt-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Salon des parties</h1>
        <p className="text-[var(--text-2)]">
          Rejoignez une partie publique ou créez la vôtre.
        </p>
        <Link
          href="/rooms/new"
          className="mt-2 rounded-lg bg-amber-500 px-7 py-3 text-lg font-bold text-stone-950 shadow-lg shadow-amber-900/30 transition hover:bg-amber-400"
        >
          + Créer une partie
        </Link>
      </section>

      <section className="glass mx-auto max-w-xl p-5">
        <h2 className="mb-3 font-semibold text-[var(--text-1)]">
          Rejoindre avec un code
        </h2>
        <form action={codeAction} className="flex flex-wrap items-center gap-3">
          <input
            name="code"
            maxLength={6}
            placeholder="ABC123"
            autoComplete="off"
            className="w-36 rounded-lg border border-[var(--card-border)] bg-[#0f1117]/80 px-3 py-2 font-mono text-lg uppercase tracking-widest outline-none transition focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={codePending}
            className="rounded-lg border border-green-600/70 px-4 py-2 font-semibold text-green-400 transition hover:bg-green-600 hover:text-stone-950 disabled:opacity-50"
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
          <p className="glass border-dashed p-8 text-center text-[var(--text-2)]">
            Aucune partie ouverte pour le moment. Créez la première !
          </p>
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2">
              {visible.map((room) => {
                const playerCount = room.room_players?.[0]?.count ?? 0;
                return (
                  <li
                    key={room.id}
                    className="glass flex items-center justify-between gap-4 p-4 transition hover:border-white/20"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-semibold">
                        <span
                          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-green-500"
                          title="En ligne"
                        />
                        {room.name}
                      </p>
                      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-[var(--text-2)]">
                        <span title="Joueurs">
                          👥 {playerCount}/{room.max_players}
                        </span>
                        <span title="Phases">🪖 {room.total_phases} phases</span>
                        <span title="Durée d'une phase">
                          ⏱ {room.phase_duration_minutes} min
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => handleJoin(room.id)}
                      disabled={isJoining || playerCount >= room.max_players}
                      className="shrink-0 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-green-500 disabled:opacity-50"
                    >
                      Rejoindre
                    </button>
                  </li>
                );
              })}
            </ul>
            {pageCount > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="glass px-3 py-1.5 transition hover:border-white/20 disabled:opacity-40"
                >
                  ← Précédent
                </button>
                <span className="text-[var(--text-2)]">
                  {page + 1} / {pageCount}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="glass px-3 py-1.5 transition hover:border-white/20 disabled:opacity-40"
                >
                  Suivant →
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
