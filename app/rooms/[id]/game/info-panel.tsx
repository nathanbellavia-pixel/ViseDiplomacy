"use client";

import { useState, useTransition } from "react";
import { setDrawVote } from "@/app/game-actions";
import { supplyCenterCount } from "@/lib/game/logic";
import {
  NATION_COLORS,
  type Phase,
  type RoomPlayer,
  type Territory,
} from "@/lib/types";
import { PHASE_TYPE_LABEL, SEASON_LABEL } from "./labels";

type Tab = "classement" | "historique" | "egalite";

export default function InfoPanel({
  roomId,
  me,
  players,
  territories,
  submittedPlayerIds,
  lastResolved,
  isFinished,
  isSpectator,
  showResults,
  onToggleResults,
}: {
  roomId: string;
  me: RoomPlayer;
  players: RoomPlayer[];
  territories: Territory[];
  submittedPlayerIds: Set<string>;
  lastResolved: Phase | null;
  isFinished: boolean;
  isSpectator: boolean;
  showResults: boolean;
  onToggleResults: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("classement");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canVoteDraw = !isFinished && !isSpectator;
  const tabs: { id: Tab; label: string }[] = [
    { id: "classement", label: "Classement" },
    { id: "historique", label: "Historique" },
    ...(canVoteDraw ? [{ id: "egalite" as Tab, label: "Égalité" }] : []),
  ];

  const ranked = [...players]
    .filter((p) => p.nation)
    .sort(
      (a, b) =>
        supplyCenterCount(territories, b.nation!) -
        supplyCenterCount(territories, a.nation!)
    );

  const activePlayers = players.filter((p) => p.nation && !p.is_eliminated);
  // bots always consent — the decision rests with the human players
  const drawVoteCount = activePlayers.filter((p) => p.is_bot || p.draw_vote).length;
  const handleDrawVote = () => {
    setError(null);
    startTransition(async () => {
      const result = await setDrawVote(roomId, !me.draw_vote);
      if (result.error) setError(result.error);
    });
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="info-toggle"
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full border border-amber-600/50 bg-[#12141c]/90 px-5 py-3 font-bold text-amber-400 shadow-lg backdrop-blur-md transition hover:bg-amber-950/60"
      >
        📊 Infos
      </button>

      {open && (
        <div
          data-testid="info-panel"
          className="fixed inset-y-0 left-0 z-40 flex w-[380px] max-w-[92vw] flex-col border-r border-[var(--card-border)] bg-[#12141c]/95 shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-2.5">
            <span className="font-semibold">Informations de la partie</span>
            <button
              onClick={() => setOpen(false)}
              data-testid="info-close"
              aria-label="Fermer"
              className="rounded px-2 py-0.5 text-stone-400 transition hover:text-stone-100"
            >
              ✕
            </button>
          </div>

          <div className="flex border-b border-[var(--card-border)]">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                data-testid={`info-tab-${t.id}`}
                className={`flex-1 px-3 py-2.5 text-sm font-semibold transition ${
                  tab === t.id
                    ? "border-b-2 border-amber-500 text-amber-400"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "classement" && (
              <ul className="space-y-1.5" data-testid="leaderboard">
                {ranked.map((p) => {
                  const sc = supplyCenterCount(territories, p.nation!);
                  const submitted = submittedPlayerIds.has(p.id);
                  return (
                    <li
                      key={p.id}
                      data-player={p.display_name}
                      data-submitted={submitted}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                        p.id === me.id ? "bg-stone-800/70" : ""
                      }`}
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: NATION_COLORS[p.nation!] }}
                      />
                      <span className="min-w-0 truncate">
                        {p.display_name}
                        <span className="text-stone-500"> · {p.nation}</span>
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        <span
                          className="font-mono"
                          data-sc-count={sc}
                          title="Centres de ravitaillement"
                        >
                          ★{sc}
                        </span>
                        {p.is_eliminated ? (
                          <span title="Éliminé — spectateur">💀</span>
                        ) : p.is_bot ? (
                          <span title="Bot">🤖</span>
                        ) : submitted ? (
                          <span className="text-green-500" title="Ordres validés">✓</span>
                        ) : (
                          <span className="text-stone-500" title="En réflexion">⏳</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {tab === "historique" &&
              (lastResolved?.summary ? (
                <div data-testid="results-panel">
                  <p className="font-semibold text-stone-300">
                    Résultats — {SEASON_LABEL[lastResolved.season]} {lastResolved.year}{" "}
                    <span className="text-stone-500">
                      ({PHASE_TYPE_LABEL[lastResolved.type]})
                    </span>
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-stone-400">
                    {lastResolved.summary.events.map((e, i) => (
                      <li key={i} data-result-event>
                        {e}
                      </li>
                    ))}
                  </ul>
                  <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-stone-300">
                    <input
                      type="checkbox"
                      checked={showResults}
                      onChange={onToggleResults}
                      className="accent-amber-500"
                    />
                    Afficher les résultats sur la carte
                  </label>
                </div>
              ) : (
                <p className="text-sm text-stone-400">
                  Aucune phase résolue pour l&apos;instant — l&apos;historique
                  apparaîtra après la première résolution.
                </p>
              ))}

            {tab === "egalite" && canVoteDraw && (
              <div data-testid="draw-panel">
                <h2 className="mb-1 font-semibold text-stone-300">Égalité mutuelle</h2>
                <p className="text-xs text-stone-400">
                  La partie se termine en égalité partagée si toutes les puissances
                  encore en lice acceptent ({drawVoteCount}/{activePlayers.length}{" "}
                  acceptation{drawVoteCount > 1 ? "s" : ""}).
                </p>
                {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
                <button
                  onClick={handleDrawVote}
                  disabled={isPending}
                  data-testid="draw-vote"
                  data-my-vote={me.draw_vote ? "yes" : "no"}
                  className={`mt-2 w-full rounded-lg py-2 text-sm font-semibold transition disabled:opacity-50 ${
                    me.draw_vote
                      ? "bg-stone-700 text-stone-200 hover:bg-stone-600"
                      : "border border-amber-600/50 bg-amber-950/40 text-amber-400 hover:bg-amber-900/40"
                  }`}
                >
                  {me.draw_vote ? "Retirer mon acceptation" : "Proposer / accepter l'égalité"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
