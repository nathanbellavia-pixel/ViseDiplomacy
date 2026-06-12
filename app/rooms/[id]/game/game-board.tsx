"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import {
  submitAdjustments,
  submitOrders,
  submitRetreats,
  type LocalOrder,
} from "@/app/game-actions";
import {
  buildSlots,
  convoyPathFor,
  convoyTargets,
  fleetConvoyOptions,
  moveTargets,
  supplyCenterCount,
  supportableUnits,
  supportDestinations,
  unitCount,
  unitsOnBoard,
} from "@/lib/game/logic";
import { HOME_SCS } from "@/lib/game/setup";
import { PROVINCES } from "@/lib/game/map-data";
import {
  NATION_COLORS,
  type Nation,
  type Order,
  type Phase,
  type PhaseSummary,
  type Room,
  type RoomPlayer,
  type Territory,
} from "@/lib/types";
import MapView from "./map-view";
import ChatPanel from "./chat-panel";
import InfoPanel from "./info-panel";
import { PHASE_TYPE_LABEL, SEASON_LABEL } from "./labels";

function dbOrderToLocal(o: Order): LocalOrder {
  if (o.order_type === "move") {
    const [prov, coast] = (o.target_territory ?? "").split("/");
    return { prov: o.unit_territory, type: "move", target: prov, targetCoast: coast ?? null };
  }
  if (o.order_type === "convoy") {
    return {
      prov: o.unit_territory,
      type: "convoy",
      aux: o.aux_territory ?? undefined,
      target: o.target_territory ?? undefined,
    };
  }
  if (o.order_type === "support") {
    const hold = o.aux_territory === o.target_territory;
    return {
      prov: o.unit_territory,
      type: hold ? "support-hold" : "support-move",
      aux: o.aux_territory ?? undefined,
      target: hold ? undefined : (o.target_territory ?? undefined),
    };
  }
  return { prov: o.unit_territory, type: "hold" };
}

function describeOrder(o: LocalOrder): string {
  const name = (p?: string) => (p ? (PROVINCES[p]?.name ?? p) : "?");
  switch (o.type) {
    case "hold":
      return `${name(o.prov)} tient`;
    case "move":
      return `${name(o.prov)} → ${name(o.target)}${o.targetCoast ? ` (côte ${o.targetCoast})` : ""}${o.viaConvoy ? " (par convoi)" : ""}`;
    case "support-hold":
      return `${name(o.prov)} soutient ${name(o.aux)} (défense)`;
    case "support-move":
      return `${name(o.prov)} soutient ${name(o.aux)} → ${name(o.target)}`;
    case "convoy":
      return `${name(o.prov)} convoie ${name(o.aux)} → ${name(o.target)}`;
  }
}

type Mode =
  | "idle"
  | "move"
  | "support-pick-unit"
  | "support-pick-dest"
  | "convoy-pick-army"
  | "convoy-pick-dest";

export default function GameBoard({
  initialRoom,
  initialPhase,
  initialPlayers,
  initialTerritories,
  initialMyOrders,
  me: initialMe,
}: {
  initialRoom: Room;
  initialPhase: Phase;
  initialPlayers: RoomPlayer[];
  initialTerritories: Territory[];
  initialMyOrders: Order[];
  me: RoomPlayer;
}) {
  const roomId = initialRoom.id;
  const [room, setRoom] = useState(initialRoom);
  const [phase, setPhase] = useState(initialPhase);
  const [players, setPlayers] = useState(initialPlayers);
  const [territories, setTerritories] = useState(initialTerritories);
  const [submittedPlayerIds, setSubmittedPlayerIds] = useState<Set<string>>(
    new Set(initialMyOrders.length > 0 ? [initialMe.id] : [])
  );
  const [orders, setOrders] = useState<Map<string, LocalOrder>>(
    new Map(initialMyOrders.map((o) => [o.unit_territory, dbOrderToLocal(o)]))
  );
  const [locked, setLocked] = useState(initialMyOrders.length > 0);
  const [mode, setMode] = useState<Mode>("idle");
  const [selected, setSelected] = useState<string | null>(null);
  const [supportAux, setSupportAux] = useState<string | null>(null);
  const [coastChoice, setCoastChoice] = useState<{ target: string; coasts: string[] } | null>(null);
  // army move by sea, awaiting confirmation of the proposed fleet chain
  const [convoyProposal, setConvoyProposal] = useState<{
    army: string;
    target: string;
    path: string[];
  } | null>(null);
  // fleet-initiated convoy: the army picked, awaiting destination
  const [convoyAux, setConvoyAux] = useState<string | null>(null);
  const [builds, setBuilds] = useState<{ prov: string; unit: "army" | "fleet"; coast?: string | null }[]>([]);
  const [disbands, setDisbands] = useState<Set<string>>(new Set());
  const [buildPicker, setBuildPicker] = useState<string | null>(null);
  // retreat phase: chosen destination per dislodged unit (null = disband)
  const [retreats, setRetreats] = useState<Map<string, string | null>>(new Map());
  const [retreatPicking, setRetreatPicking] = useState<string | null>(null);
  const [lastResolved, setLastResolved] = useState<Phase | null>(null);
  const [showResults, setShowResults] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();
  const expireFired = useRef<string | null>(null);
  const phaseIdRef = useRef(initialPhase.id);
  const phaseStartRef = useRef(
    initialPhase.starts_at ? new Date(initialPhase.starts_at).getTime() : 0
  );

  const me = players.find((p) => p.id === initialMe.id) ?? initialMe;
  const myNation = me.nation;
  const isSpectator = me.is_eliminated || !myNation;

  const allUnits = useMemo(() => unitsOnBoard(territories), [territories]);
  const myUnits = useMemo(
    () => allUnits.filter((u) => u.nation === myNation),
    [allUnits, myNation]
  );
  const unitAt = useMemo(() => new Map(allUnits.map((u) => [u.prov, u])), [allUnits]);
  const selectedUnit = selected ? (unitAt.get(selected) ?? null) : null;

  // ------------------------------------------------------------ realtime
  const refetchTerritories = useCallback(async () => {
    const { data } = await getSupabaseBrowser()
      .from("territories")
      .select()
      .eq("room_id", roomId);
    if (data) setTerritories(data as Territory[]);
  }, [roomId]);

  const refetchPhaseAndOrders = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    const { data: p } = await supabase
      .from("phases")
      .select()
      .eq("room_id", roomId)
      .eq("status", "active")
      .order("phase_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (p) {
      const newPhase = p as Phase;
      const startsAt = newPhase.starts_at ? new Date(newPhase.starts_at).getTime() : 0;
      if (phaseIdRef.current !== newPhase.id) {
        // concurrent refetches can return the PREVIOUS phase while a
        // resolution is in flight — never move backwards
        if (startsAt < phaseStartRef.current) return;
        phaseIdRef.current = newPhase.id;
        phaseStartRef.current = startsAt;
        setOrders(new Map());
        setLocked(false);
        setBuilds([]);
        setDisbands(new Set());
        setRetreats(new Map());
        setRetreatPicking(null);
        setSelected(null);
        setMode("idle");
        setConvoyProposal(null);
        setConvoyAux(null);
      }
      setPhase(newPhase);
    }
    const { data: resolved } = await supabase
      .from("phases")
      .select()
      .eq("room_id", roomId)
      .eq("status", "resolved")
      .order("resolved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (resolved) {
      setLastResolved((prev) =>
        prev?.resolved_at &&
        (resolved as Phase).resolved_at &&
        new Date((resolved as Phase).resolved_at!) < new Date(prev.resolved_at)
          ? prev
          : (resolved as Phase)
      );
    }
    const phaseId = (p as Phase | null)?.id;
    if (!phaseId) return;
    const [{ data: submitted }, { data: mine }] = await Promise.all([
      supabase
        .from("orders")
        .select("player_id")
        .eq("phase_id", phaseId)
        .eq("is_submitted", true),
      supabase
        .from("orders")
        .select()
        .eq("phase_id", phaseId)
        .eq("player_id", me.id)
        .eq("is_submitted", true),
    ]);
    // the phase may have advanced while these queries ran — drop stale data
    if (phaseIdRef.current !== phaseId) return;
    setSubmittedPlayerIds(new Set((submitted ?? []).map((o) => o.player_id as string)));
    if (mine && mine.length > 0) {
      setOrders(new Map((mine as Order[]).map((o) => [o.unit_territory, dbOrderToLocal(o)])));
      setLocked(true);
    }
  }, [roomId, me.id]);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const channel = supabase
      .channel(`game-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "diplomacy", table: "territories", filter: `room_id=eq.${roomId}` },
        () => refetchTerritories()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "diplomacy", table: "phases", filter: `room_id=eq.${roomId}` },
        () => refetchPhaseAndOrders()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "diplomacy", table: "orders", filter: `room_id=eq.${roomId}` },
        () => refetchPhaseAndOrders()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "diplomacy", table: "rooms", filter: `id=eq.${roomId}` },
        (payload) => setRoom((prev) => ({ ...prev, ...(payload.new as Room) }))
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "diplomacy", table: "room_players", filter: `room_id=eq.${roomId}` },
        async () => {
          const { data } = await supabase
            .from("room_players")
            .select()
            .eq("room_id", roomId)
            .order("joined_at");
          if (data) setPlayers(data as RoomPlayer[]);
        }
      )
      .subscribe();
    refetchPhaseAndOrders();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, refetchTerritories, refetchPhaseAndOrders]);

  // ------------------------------------------------------------ countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remainingMs = phase.ends_at ? new Date(phase.ends_at).getTime() - now : null;
  useEffect(() => {
    if (
      remainingMs !== null &&
      remainingMs <= 0 &&
      room.status === "active" &&
      expireFired.current !== phase.id
    ) {
      // fire exactly once per phase; the endpoint is idempotent so other
      // clients hitting it at the same moment are harmless
      expireFired.current = phase.id;
      fetch("/api/resolve-phase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-resolve-token": process.env.NEXT_PUBLIC_RESOLVE_TOKEN ?? "",
        },
        body: JSON.stringify({ roomId }),
      })
        .then(() => refetchPhaseAndOrders())
        .catch(() => {
          // allow a retry on the next tick if the call never went out
          expireFired.current = null;
        });
    }
  }, [remainingMs, phase.id, room.status, roomId, refetchPhaseAndOrders]);

  // ------------------------------------------------------- selection logic
  const isAdjustment = phase.type === "adjustment";
  const isRetreat = phase.type === "retreat";
  const isFinished = room.status === "finished";
  const myDislodged = useMemo(
    () =>
      isRetreat
        ? (phase.summary?.dislodged ?? []).filter((d) => d.nation === myNation)
        : [],
    [isRetreat, phase.summary, myNation]
  );
  const mySc = myNation ? supplyCenterCount(territories, myNation) : 0;
  const myUnitCount = myNation ? unitCount(territories, myNation) : 0;
  const delta = mySc - myUnitCount;
  const slots = useMemo(
    () => (isAdjustment && myNation ? buildSlots(territories, myNation, HOME_SCS[myNation]) : []),
    [isAdjustment, territories, myNation]
  );

  const highlights = useMemo(() => {
    if (locked || isSpectator || isAdjustment || isFinished) return new Set<string>();
    if (isRetreat) {
      const d = retreatPicking
        ? myDislodged.find((x) => x.prov === retreatPicking)
        : undefined;
      return new Set((d?.options ?? []).map((loc) => loc.split("/")[0]));
    }
    if (mode === "move" && selectedUnit) {
      const set = new Set(moveTargets(selectedUnit).map((t) => t.prov));
      // armies can also be convoyed: propose sea-only destinations too
      for (const p of convoyTargets(selectedUnit, allUnits)) set.add(p);
      return set;
    }
    if (mode === "support-pick-dest" && selectedUnit && supportAux) {
      const aux = unitAt.get(supportAux);
      if (!aux) return new Set<string>();
      const d = supportDestinations(selectedUnit, aux);
      const set = new Set(d.moveDestinations);
      if (d.canSupportHold) set.add(supportAux);
      return set;
    }
    if (mode === "convoy-pick-dest" && selectedUnit && convoyAux) {
      const set = new Set(fleetConvoyOptions(selectedUnit, allUnits).coastals);
      set.delete(convoyAux);
      return set;
    }
    return new Set<string>();
  }, [
    mode,
    selectedUnit,
    supportAux,
    convoyAux,
    allUnits,
    unitAt,
    locked,
    isSpectator,
    isAdjustment,
    isFinished,
    isRetreat,
    retreatPicking,
    myDislodged,
  ]);

  const supportHighlights = useMemo(() => {
    if (mode === "support-pick-unit" && selectedUnit) {
      return new Set(supportableUnits(selectedUnit, allUnits).map((u) => u.prov));
    }
    if (mode === "convoy-pick-army" && selectedUnit) {
      return new Set(fleetConvoyOptions(selectedUnit, allUnits).armies);
    }
    return new Set<string>();
  }, [mode, selectedUnit, allUnits]);

  const setOrder = (o: LocalOrder) => {
    setOrders((prev) => new Map(prev).set(o.prov, o));
    setSelected(null);
    setMode("idle");
    setSupportAux(null);
    setCoastChoice(null);
    setConvoyProposal(null);
    setConvoyAux(null);
  };

  const commitMove = (target: string, coast: string | null) =>
    selected && setOrder({ prov: selected, type: "move", target, targetCoast: coast });

  const handleMoveTarget = (prov: string) => {
    if (!selectedUnit) return;
    const variants = moveTargets(selectedUnit).filter((t) => t.prov === prov);
    if (variants.length > 1) {
      setCoastChoice({ target: prov, coasts: variants.map((v) => v.coast!) });
    } else if (variants.length === 1) {
      commitMove(prov, variants[0].coast ?? null);
    } else {
      // reachable only by sea: propose a convoy chain to confirm or adjust
      const path = convoyPathFor(selectedUnit, prov, allUnits, myNation);
      if (path) setConvoyProposal({ army: selectedUnit.prov, target: prov, path });
    }
  };

  // confirm the proposed chain: order the army's move plus a convoy order
  // for every one of our fleets along the route
  const confirmConvoy = () => {
    if (!convoyProposal) return;
    const { army, target, path } = convoyProposal;
    setOrders((prev) => {
      const next = new Map(prev);
      next.set(army, { prov: army, type: "move", target, viaConvoy: true });
      for (const sea of path) {
        const fleet = unitAt.get(sea);
        if (fleet && fleet.nation === myNation) {
          next.set(sea, { prov: sea, type: "convoy", aux: army, target });
        }
      }
      return next;
    });
    setConvoyProposal(null);
    setSelected(null);
    setMode("idle");
  };

  const handleProvinceClick = (prov: string) => {
    if (locked || isSpectator || isFinished) return;
    if (isRetreat) {
      if (!retreatPicking) return;
      const d = myDislodged.find((x) => x.prov === retreatPicking);
      const loc = d?.options.find((o) => o.split("/")[0] === prov);
      if (loc) {
        setRetreats((prev) => new Map(prev).set(retreatPicking, loc));
        setRetreatPicking(null);
      }
      return;
    }
    if (isAdjustment) {
      if (delta > 0 && slots.some((s) => s.prov === prov) && !builds.some((b) => b.prov === prov)) {
        setBuildPicker(prov);
      }
      return;
    }
    if (mode === "move" && highlights.has(prov)) return handleMoveTarget(prov);
    if (mode === "support-pick-dest" && highlights.has(prov) && selected && supportAux) {
      setOrder(
        prov === supportAux
          ? { prov: selected, type: "support-hold", aux: supportAux }
          : { prov: selected, type: "support-move", aux: supportAux, target: prov }
      );
      return;
    }
    if (mode === "convoy-pick-dest" && highlights.has(prov) && selected && convoyAux) {
      setOrder({ prov: selected, type: "convoy", aux: convoyAux, target: prov });
    }
  };

  const handleUnitClick = (prov: string) => {
    if (locked || isSpectator || isFinished) return;
    if (isRetreat) return;
    if (isAdjustment) {
      if (delta < 0 && myUnits.some((u) => u.prov === prov)) {
        setDisbands((prev) => {
          const next = new Set(prev);
          if (next.has(prov)) next.delete(prov);
          else if (next.size < -delta) next.add(prov);
          return next;
        });
      }
      return;
    }
    if (mode === "support-pick-unit" && supportHighlights.has(prov)) {
      setSupportAux(prov);
      setMode("support-pick-dest");
      return;
    }
    if (mode === "convoy-pick-army" && supportHighlights.has(prov)) {
      setConvoyAux(prov);
      setMode("convoy-pick-dest");
      return;
    }
    if (
      (mode === "move" || mode === "support-pick-dest" || mode === "convoy-pick-dest") &&
      highlights.has(prov)
    ) {
      return handleProvinceClick(prov);
    }
    if (myUnits.some((u) => u.prov === prov)) {
      if (selected === prov) {
        setSelected(null);
        setMode("idle");
      } else {
        setSelected(prov);
        setMode("move");
      }
      setSupportAux(null);
      setCoastChoice(null);
      setConvoyProposal(null);
      setConvoyAux(null);
    }
  };

  const handleSubmit = () => {
    setError(null);
    const phaseAtSubmit = phaseIdRef.current;
    startTransition(async () => {
      const result = isRetreat
        ? await submitRetreats(
            roomId,
            myDislodged.map((d) => ({ prov: d.prov, to: retreats.get(d.prov) ?? null }))
          )
        : isAdjustment
          ? await submitAdjustments(roomId, builds, [...disbands])
          : await submitOrders(roomId, [...orders.values()]);
      if (result.error) setError(result.error);
      else {
        // the submit may have triggered the resolution: if the phase already
        // advanced while the action ran, don't lock the NEW phase
        if (phaseIdRef.current === phaseAtSubmit) setLocked(true);
        refetchPhaseAndOrders();
      }
    });
  };

  // ------------------------------------------------------------------ HUD
  const ranked = [...players]
    .filter((p) => p.nation)
    .sort(
      (a, b) =>
        supplyCenterCount(territories, b.nation!) - supplyCenterCount(territories, a.nation!)
    );
  const mmss =
    remainingMs === null
      ? "—"
      : remainingMs <= 0
        ? "00:00"
        : `${String(Math.floor(remainingMs / 60000)).padStart(2, "0")}:${String(
            Math.floor((remainingMs % 60000) / 1000)
          ).padStart(2, "0")}`;
  const phaseTotalMs =
    phase.ends_at && phase.starts_at
      ? new Date(phase.ends_at).getTime() - new Date(phase.starts_at).getTime()
      : null;
  const timeFraction =
    remainingMs !== null && phaseTotalMs ? remainingMs / phaseTotalMs : 1;
  const timerColor =
    timeFraction < 0.2
      ? "text-red-400"
      : timeFraction < 0.5
        ? "text-green-400"
        : "text-amber-400";

  const mapOrders = isAdjustment || isRetreat ? [] : [...orders.values()];
  const resultOrders =
    showResults && lastResolved?.summary ? lastResolved.summary.orders : [];

  return (
    // break out of the page's max-w-5xl so the map can use the full viewport,
    // while keeping ~20px of breathing room at each edge
    <div className="grid gap-5 lg:mx-[calc(50%-50vw+1.25rem)] lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* ----------------------------------------------- end of game */}
      {isFinished && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#0f1117]/85 p-6 backdrop-blur-sm"
          data-testid="victory-screen"
        >
          <div className="glass w-full max-w-md rounded-2xl border-amber-600/60 p-8 text-center">
            {room.winner_nation ? (
              <>
                <p className="text-5xl">🏆</p>
                <h2 className="mt-3 text-2xl font-bold text-amber-400" data-winner={room.winner_nation}>
                  {room.winner_nation} remporte la partie !
                </h2>
                <p className="mt-1 text-sm text-stone-400">
                  {players.find((p) => p.nation === room.winner_nation)?.display_name ?? "—"}
                  {" · "}
                  {supplyCenterCount(territories, room.winner_nation)} centres de ravitaillement
                </p>
              </>
            ) : room.is_draw ? (
              <>
                <p className="text-5xl">🤝</p>
                <h2 className="mt-3 text-2xl font-bold text-amber-400" data-testid="draw-result">
                  Égalité mutuelle
                </h2>
                <p className="mt-1 text-sm text-stone-400">
                  Les puissances restantes se partagent la victoire.
                </p>
              </>
            ) : (
              <h2 className="text-2xl font-bold text-amber-400">Fin de la partie</h2>
            )}
            <ol className="mt-5 space-y-1.5 text-left">
              {ranked.map((p, i) => (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                    i === 0
                      ? "border-amber-600/50 bg-amber-950/40"
                      : "border-[var(--card-border)] bg-white/[0.04]"
                  }`}
                >
                  <span className="w-5 font-mono text-stone-500">{i + 1}.</span>
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: NATION_COLORS[p.nation!] }}
                  />
                  <span className="min-w-0 truncate">
                    {p.display_name}
                    <span className="text-stone-500"> · {p.nation}</span>
                  </span>
                  <span className="ml-auto font-mono">
                    ★{supplyCenterCount(territories, p.nation!)}
                  </span>
                </li>
              ))}
            </ol>
            <a
              href="/"
              className="mt-6 inline-block rounded-lg bg-amber-600 px-5 py-2 font-bold text-stone-950 transition hover:bg-amber-500"
            >
              Retour au salon
            </a>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- sidebar */}
      <aside className="space-y-4">
        <div className="glass p-4">
          <h1 className="truncate text-lg font-bold">{room.name}</h1>
          <p className="mt-1 text-2xl font-bold text-amber-500" data-testid="phase-season">
            {SEASON_LABEL[phase.season]} {phase.year}
          </p>
          <p className="mt-1.5 text-sm text-[var(--text-2)]">
            Phase {phase.phase_number}/{room.total_phases}{" "}
            <span
              className="ml-1 inline-block rounded-lg border border-amber-600/40 bg-amber-950/40 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-400"
              data-testid="phase-type-badge"
            >
              {PHASE_TYPE_LABEL[phase.type]}
            </span>
          </p>
          {/* server and client render different clock values — expected */}
          <p
            className={`mt-2 font-mono text-3xl font-bold transition-colors ${timerColor}`}
            data-testid="phase-timer"
            suppressHydrationWarning
          >
            ⏱ {mmss}
          </p>
        </div>

        {/* ---------------------------------------------- order panel */}
        {isFinished ? null : isSpectator ? (
          <div
            className="glass p-4 text-sm text-[var(--text-2)]"
            data-testid="spectator-banner"
          >
            👁 Vous êtes spectateur{me.is_eliminated ? " (éliminé)" : ""}. Vous voyez tout,
            mais ne pouvez plus donner d&apos;ordres.
          </div>
        ) : isRetreat ? (
          <div className="glass p-4" data-testid="retreat-panel">
            <h2 className="mb-2 font-semibold">Retraites</h2>
            {myDislodged.length === 0 ? (
              <p className="text-sm text-stone-400">
                Aucune de vos unités n&apos;est délogée — en attente des retraites adverses.
              </p>
            ) : locked ? (
              <p className="text-sm font-semibold text-green-500" data-testid="orders-locked">
                Retraites validées ✓
              </p>
            ) : (
              <>
                <p className="text-sm text-stone-300">
                  Choisissez une destination pour chaque unité délogée, ou dissolvez-la.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {myDislodged.map((d) => {
                    const choice = retreats.get(d.prov);
                    return (
                      <li key={d.prov} className="rounded-lg bg-stone-800/70 p-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() =>
                              setRetreatPicking(retreatPicking === d.prov ? null : d.prov)
                            }
                            data-retreat-unit={d.prov}
                            className={`font-semibold ${
                              retreatPicking === d.prov ? "text-amber-400" : ""
                            }`}
                          >
                            {d.unit === "army" ? "Armée" : "Flotte"} — {PROVINCES[d.prov].name}
                          </button>
                          <button
                            onClick={() => {
                              setRetreats((prev) => new Map(prev).set(d.prov, null));
                              if (retreatPicking === d.prov) setRetreatPicking(null);
                            }}
                            data-retreat-disband={d.prov}
                            className="rounded bg-stone-700 px-2 py-0.5 text-xs hover:bg-red-700"
                          >
                            Dissoudre
                          </button>
                        </div>
                        <p className="mt-1 text-xs text-stone-400" data-retreat-choice={d.prov}>
                          {choice === undefined
                            ? d.options.length === 0
                              ? "Aucune retraite possible — dissolution"
                              : retreatPicking === d.prov
                                ? "Cliquez une destination en surbrillance"
                                : "À décider"
                            : choice === null
                              ? "Dissolution"
                              : `→ ${PROVINCES[choice.split("/")[0]].name}`}
                        </p>
                      </li>
                    );
                  })}
                </ul>
                {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
                <button
                  onClick={handleSubmit}
                  disabled={
                    isPending ||
                    myDislodged.some((d) => d.options.length > 0 && !retreats.has(d.prov))
                  }
                  data-testid="submit-orders"
                  className="mt-3 w-full rounded-lg bg-amber-600 py-2.5 font-bold text-stone-950 transition hover:bg-amber-500 disabled:opacity-50"
                >
                  Valider les retraites
                </button>
              </>
            )}
          </div>
        ) : isAdjustment ? (
          <div className="glass p-4" data-testid="adjustment-panel">
            <h2 className="mb-2 font-semibold">Ajustements d&apos;hiver</h2>
            {locked ? (
              <p className="text-sm font-semibold text-green-500">Ajustements validés ✓</p>
            ) : delta > 0 ? (
              <>
                <p className="text-sm text-stone-300">
                  {mySc} centres pour {myUnitCount} unités : construisez jusqu&apos;à{" "}
                  <b className="text-amber-500">{delta}</b> unité(s) sur vos centres d&apos;origine libres.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {slots
                    .filter((s) => !builds.some((b) => b.prov === s.prov))
                    .map((s) => (
                      <li key={s.prov}>
                        <button
                          onClick={() => setBuildPicker(s.prov)}
                          disabled={builds.length >= delta}
                          data-build-slot={s.prov}
                          className="w-full rounded-lg border border-stone-700 px-3 py-1.5 text-left text-sm hover:border-amber-500 disabled:opacity-40"
                        >
                          + Construire à {s.name}
                        </button>
                        {buildPicker === s.prov && (
                          <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg bg-stone-800 p-2">
                            <button
                              onClick={() => {
                                setBuilds((b) => [...b, { prov: s.prov, unit: "army" }]);
                                setBuildPicker(null);
                              }}
                              data-build-army={s.prov}
                              className="rounded bg-stone-700 px-2.5 py-1 text-xs font-semibold hover:bg-amber-600 hover:text-stone-950"
                            >
                              ⬤ Armée
                            </button>
                            {s.allowFleet &&
                              (s.coasts ? (
                                s.coasts.map((c) => (
                                  <button
                                    key={c}
                                    onClick={() => {
                                      setBuilds((b) => [...b, { prov: s.prov, unit: "fleet", coast: c }]);
                                      setBuildPicker(null);
                                    }}
                                    className="rounded bg-stone-700 px-2.5 py-1 text-xs font-semibold hover:bg-amber-600 hover:text-stone-950"
                                  >
                                    ⛵ Flotte ({c})
                                  </button>
                                ))
                              ) : (
                                <button
                                  onClick={() => {
                                    setBuilds((b) => [...b, { prov: s.prov, unit: "fleet" }]);
                                    setBuildPicker(null);
                                  }}
                                  data-build-fleet={s.prov}
                                  className="rounded bg-stone-700 px-2.5 py-1 text-xs font-semibold hover:bg-amber-600 hover:text-stone-950"
                                >
                                  ⛵ Flotte
                                </button>
                              ))}
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
                {builds.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {builds.map((b) => (
                      <li
                        key={b.prov}
                        data-build-chip={b.prov}
                        className="flex items-center justify-between rounded bg-green-950/50 px-2.5 py-1 text-sm text-green-300"
                      >
                        {b.unit === "army" ? "Armée" : "Flotte"} à {PROVINCES[b.prov].name}
                        {b.coast ? ` (${b.coast})` : ""}
                        <button
                          onClick={() => setBuilds((arr) => arr.filter((x) => x.prov !== b.prov))}
                          className="text-stone-400 hover:text-red-400"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : delta < 0 ? (
              <p className="text-sm text-stone-300">
                {mySc} centres pour {myUnitCount} unités : cliquez{" "}
                <b className="text-red-400">{-delta}</b> de vos unités sur la carte à dissoudre
                ({disbands.size}/{-delta} choisie(s)).
              </p>
            ) : (
              <p className="text-sm text-stone-400">Aucun ajustement nécessaire cet hiver.</p>
            )}
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            {!locked && (delta !== 0) && (
              <button
                onClick={handleSubmit}
                disabled={isPending || (delta < 0 && disbands.size !== -delta)}
                data-testid="submit-orders"
                className="mt-3 w-full rounded-lg bg-amber-600 py-2.5 font-bold text-stone-950 transition hover:bg-amber-500 disabled:opacity-50"
              >
                Valider les ajustements
              </button>
            )}
          </div>
        ) : (
          <div className="glass p-4" data-testid="order-panel">
            <h2 className="mb-2 font-semibold">Vos ordres</h2>
            {locked ? (
              <p className="mb-2 text-sm font-semibold text-green-500" data-testid="orders-locked">
                Ordres validés ✓ — en attente des autres puissances.
              </p>
            ) : selectedUnit ? (
              <div className="mb-3 rounded-lg bg-stone-800/80 p-2.5 text-sm">
                <p className="font-semibold">
                  {selectedUnit.unit === "army" ? "Armée" : "Flotte"} —{" "}
                  {PROVINCES[selectedUnit.prov].name}
                </p>
                {mode === "move" && (
                  <p className="mt-1 text-stone-400">
                    Cliquez une destination en surbrillance pour attaquer, ou :
                  </p>
                )}
                {mode === "support-pick-unit" && (
                  <p className="mt-1 text-cyan-400">Cliquez l&apos;unité à soutenir.</p>
                )}
                {mode === "support-pick-dest" && supportAux && (
                  <p className="mt-1 text-cyan-400">
                    Soutien de {PROVINCES[supportAux].name} : cliquez la destination (ou
                    l&apos;unité soutenue pour une défense).
                  </p>
                )}
                {mode === "convoy-pick-army" && (
                  <p className="mt-1 text-violet-400">Cliquez l&apos;armée à convoyer.</p>
                )}
                {mode === "convoy-pick-dest" && convoyAux && (
                  <p className="mt-1 text-violet-400">
                    Convoi de {PROVINCES[convoyAux].name} : cliquez la côte de destination.
                  </p>
                )}
                {convoyProposal && (
                  <div
                    className="mt-2 rounded-lg border border-violet-700/60 bg-violet-950/40 p-2"
                    data-testid="convoy-proposal"
                  >
                    <p className="text-xs font-semibold text-violet-300">
                      Convoi proposé :{" "}
                      {[convoyProposal.army, ...convoyProposal.path, convoyProposal.target]
                        .map((p) => PROVINCES[p]?.name ?? p)
                        .join(" → ")}
                    </p>
                    <p className="mt-1 text-[11px] text-stone-400">
                      Vos flottes du trajet recevront l&apos;ordre de convoyer. Les flottes
                      étrangères devront convoyer de leur côté.
                    </p>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        onClick={confirmConvoy}
                        data-testid="confirm-convoy"
                        className="rounded bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-violet-500"
                      >
                        Confirmer le convoi
                      </button>
                      <button
                        onClick={() => setConvoyProposal(null)}
                        className="rounded px-2.5 py-1 text-xs text-stone-400 hover:text-stone-200"
                      >
                        Ajuster
                      </button>
                    </div>
                  </div>
                )}
                {coastChoice && (
                  <div className="mt-2 flex gap-2">
                    {coastChoice.coasts.map((c) => (
                      <button
                        key={c}
                        onClick={() => commitMove(coastChoice.target, c)}
                        className="rounded bg-stone-700 px-2.5 py-1 text-xs font-semibold hover:bg-amber-600 hover:text-stone-950"
                      >
                        {PROVINCES[coastChoice.target].name} côte {c}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => selected && setOrder({ prov: selected, type: "hold" })}
                    data-testid="order-hold"
                    className="rounded bg-stone-700 px-3 py-1 text-xs font-semibold hover:bg-amber-600 hover:text-stone-950"
                  >
                    Tenir
                  </button>
                  {mode === "move" && (
                    <button
                      onClick={() => setMode("support-pick-unit")}
                      data-testid="order-support"
                      className="rounded bg-stone-700 px-3 py-1 text-xs font-semibold hover:bg-cyan-600 hover:text-stone-950"
                    >
                      Soutenir
                    </button>
                  )}
                  {mode === "move" &&
                    selectedUnit.unit === "fleet" &&
                    PROVINCES[selectedUnit.prov]?.type === "water" && (
                      <button
                        onClick={() => setMode("convoy-pick-army")}
                        data-testid="order-convoy"
                        className="rounded bg-stone-700 px-3 py-1 text-xs font-semibold hover:bg-violet-600 hover:text-white"
                      >
                        Convoyer
                      </button>
                    )}
                  <button
                    onClick={() => {
                      setSelected(null);
                      setMode("idle");
                      setSupportAux(null);
                      setCoastChoice(null);
                      setConvoyProposal(null);
                      setConvoyAux(null);
                    }}
                    className="rounded px-3 py-1 text-xs text-stone-400 hover:text-stone-200"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <p className="mb-2 text-sm text-stone-400">
                Cliquez sur une de vos unités pour lui donner un ordre. Sans ordre, une
                unité tient sa position.
              </p>
            )}

            <ul className="space-y-1">
              {[...orders.values()].map((o) => (
                <li
                  key={o.prov}
                  data-order-chip={o.prov}
                  className="flex items-center justify-between gap-2 rounded bg-stone-800/60 px-2.5 py-1 text-sm"
                >
                  <span className="truncate">{describeOrder(o)}</span>
                  {!locked && (
                    <button
                      onClick={() =>
                        setOrders((prev) => {
                          const next = new Map(prev);
                          next.delete(o.prov);
                          return next;
                        })
                      }
                      className="shrink-0 text-stone-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            {!locked && (
              <button
                onClick={handleSubmit}
                disabled={isPending || myUnits.length === 0}
                data-testid="submit-orders"
                className={`mt-3 w-full rounded-lg py-2.5 text-lg font-bold transition disabled:opacity-50 ${
                  orders.size === 0
                    ? "bg-white/15 text-[var(--text-2)] hover:bg-white/25"
                    : orders.size >= myUnits.length
                      ? "bg-green-600 text-stone-950 shadow-lg shadow-green-900/30 hover:bg-green-500"
                      : "bg-amber-500 text-stone-950 shadow-lg shadow-amber-900/30 hover:bg-amber-400"
                }`}
              >
                Valider les ordres ({orders.size}/{myUnits.length})
              </button>
            )}
          </div>
        )}
      </aside>

      {/* ----------------------------------------------------------- map */}
      <div>
        <MapView
          territories={territories}
          orders={mapOrders}
          highlights={highlights}
          selected={selected}
          supportHighlights={supportHighlights}
          disbandMarks={disbands}
          buildMarks={builds}
          resultOrders={resultOrders}
          onProvinceClick={handleProvinceClick}
          onUnitClick={handleUnitClick}
        />
      </div>

      {/* leaderboard, history and draw proposal live in the slide-over panel */}
      <InfoPanel
        roomId={roomId}
        me={me}
        players={players}
        territories={territories}
        submittedPlayerIds={submittedPlayerIds}
        lastResolved={lastResolved}
        isFinished={isFinished}
        isSpectator={isSpectator}
        showResults={showResults}
        onToggleResults={() => setShowResults((v) => !v)}
      />

      <ChatPanel roomId={roomId} me={me} players={players} />
    </div>
  );
}
