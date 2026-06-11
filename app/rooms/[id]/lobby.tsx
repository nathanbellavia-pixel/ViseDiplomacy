"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import { claimNation, startGame } from "@/app/actions";
import {
  NATIONS,
  NATION_COLORS,
  type Nation,
  type Room,
  type RoomPlayer,
} from "@/lib/types";

export default function Lobby({
  initialRoom,
  initialPlayers,
  userId,
}: {
  initialRoom: Room;
  initialPlayers: RoomPlayer[];
  userId: string;
}) {
  const [room, setRoom] = useState<Room>(initialRoom);
  const [players, setPlayers] = useState<RoomPlayer[]>(initialPlayers);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const me = players.find((p) => p.user_id === userId);
  const isHost = room.host_id === userId;

  const refreshPlayers = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    const { data } = await supabase
      .from("room_players")
      .select()
      .eq("room_id", initialRoom.id)
      .order("joined_at");
    if (data) setPlayers(data as RoomPlayer[]);
  }, [initialRoom.id]);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const channel = supabase
      .channel(`room-${initialRoom.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "diplomacy",
          table: "room_players",
          filter: `room_id=eq.${initialRoom.id}`,
        },
        () => refreshPlayers()
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "diplomacy",
          table: "rooms",
          filter: `id=eq.${initialRoom.id}`,
        },
        (payload) => setRoom((prev) => ({ ...prev, ...(payload.new as Room) }))
      )
      .subscribe();
    // Catch anything that happened between server render and subscription.
    refreshPlayers();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [initialRoom.id, refreshPlayers]);

  const handleClaim = (nation: Nation) => {
    if (!me || room.status !== "waiting") return;
    setError(null);
    const target = me.nation === nation ? null : nation; // re-click releases
    startTransition(async () => {
      const result = await claimNation(room.id, target);
      if (result.error) setError(result.error);
      else refreshPlayers();
    });
  };

  const handleStart = () => {
    setError(null);
    startTransition(async () => {
      const result = await startGame(room.id);
      if (result.error) setError(result.error);
    });
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(room.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">{room.name}</h1>
          <p className="mt-1 text-stone-400">
            {room.is_public ? "Partie publique" : "Partie privée"} ·{" "}
            {room.total_phases} phases · {room.phase_duration_minutes} min/phase
          </p>
        </div>
        <button
          onClick={copyCode}
          title="Copier le code"
          className="rounded-xl border border-amber-600/50 bg-amber-950/30 px-5 py-3 text-left transition hover:border-amber-500"
        >
          <span className="block text-xs uppercase tracking-wide text-stone-400">
            Code d&apos;invitation {copied && "· copié !"}
          </span>
          <span className="font-mono text-2xl font-bold tracking-[0.3em] text-amber-400">
            {room.code}
          </span>
        </button>
      </section>

      {room.status === "active" && (
        <div className="rounded-xl border border-green-700 bg-green-950/40 p-4 text-center font-semibold text-green-400">
          ⚔️ La partie a été lancée ! Phase 1 — Printemps 1901.
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        <section>
          <h2 className="mb-3 text-lg font-semibold">
            Joueurs ({players.length}/{room.max_players})
            <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500 align-middle" />
          </h2>
          <ul className="space-y-2">
            {players.map((player) => (
              <li
                key={player.id}
                className="flex items-center gap-3 rounded-lg border border-stone-800 bg-stone-900/50 px-4 py-3"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-stone-600"
                  style={{
                    backgroundColor: player.nation
                      ? NATION_COLORS[player.nation]
                      : "transparent",
                  }}
                />
                <span className="min-w-0 truncate font-medium">
                  {player.display_name}
                  {player.user_id === userId && (
                    <span className="text-stone-500"> (vous)</span>
                  )}
                </span>
                {player.is_host && (
                  <span className="rounded bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-500">
                    Hôte
                  </span>
                )}
                {player.is_bot && (
                  <span className="rounded bg-stone-800 px-2 py-0.5 text-xs font-semibold text-stone-400">
                    Bot
                  </span>
                )}
                <span className="ml-auto shrink-0 text-sm text-stone-400">
                  {player.nation ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">Choisissez votre nation</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {NATIONS.map((nation) => {
              const claimedBy = players.find((p) => p.nation === nation);
              const isMine = claimedBy?.user_id === userId;
              const claimable =
                room.status === "waiting" && (!claimedBy || isMine);
              return (
                <button
                  key={nation}
                  onClick={() => handleClaim(nation)}
                  disabled={!claimable || isPending}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-4 py-3 text-left transition ${
                    isMine
                      ? "border-amber-500 bg-amber-950/40"
                      : claimedBy
                        ? "cursor-not-allowed border-stone-800 bg-stone-900/30 opacity-60"
                        : "border-stone-700 bg-stone-900/50 hover:border-stone-400"
                  }`}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: NATION_COLORS[nation] }}
                    />
                    {nation}
                  </span>
                  <span className="truncate text-sm text-stone-400">
                    {isMine
                      ? "Vous ✓"
                      : (claimedBy?.display_name ?? "Libre")}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-sm text-stone-500">
            Les nations libres au lancement seront contrôlées par des bots.
          </p>

          {isHost && room.status === "waiting" && (
            <button
              onClick={handleStart}
              disabled={isPending}
              className="mt-6 w-full rounded-lg bg-amber-600 py-3.5 text-lg font-bold text-stone-950 transition hover:bg-amber-500 disabled:opacity-50"
            >
              {isPending ? "Lancement…" : "⚔️ Lancer la partie"}
            </button>
          )}
          {!isHost && room.status === "waiting" && (
            <p className="mt-6 text-center text-sm text-stone-500">
              En attente du lancement par l&apos;hôte…
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
