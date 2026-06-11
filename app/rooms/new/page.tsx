"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createRoom, type ActionState } from "@/app/actions";

export default function NewRoomPage() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createRoom,
    {}
  );
  const [totalPhases, setTotalPhases] = useState(30);
  const [phaseDuration, setPhaseDuration] = useState(5);

  return (
    <div className="mx-auto max-w-lg">
      <Link href="/" className="text-sm text-stone-400 hover:text-stone-200">
        ← Retour au salon
      </Link>
      <h1 className="mt-3 text-3xl font-bold">Créer une partie</h1>

      <form action={formAction} className="mt-8 space-y-7">
        <div>
          <label htmlFor="name" className="mb-2 block font-semibold">
            Nom de la partie
          </label>
          <input
            id="name"
            name="name"
            required
            maxLength={60}
            placeholder="La Grande Guerre"
            className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2.5 outline-none focus:border-amber-500"
          />
        </div>

        <fieldset>
          <legend className="mb-2 font-semibold">Visibilité</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-stone-700 bg-stone-950 px-4 py-3 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-950/30">
              <input
                type="radio"
                name="visibility"
                value="public"
                defaultChecked
                className="accent-amber-500"
              />
              <span>
                <span className="block font-medium">Publique</span>
                <span className="text-sm text-stone-400">
                  Visible dans le salon
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-stone-700 bg-stone-950 px-4 py-3 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-950/30">
              <input
                type="radio"
                name="visibility"
                value="private"
                className="accent-amber-500"
              />
              <span>
                <span className="block font-medium">Privée</span>
                <span className="text-sm text-stone-400">
                  Accessible par code
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div>
          <label htmlFor="total_phases" className="mb-2 block font-semibold">
            Nombre de phases :{" "}
            <span className="text-amber-500">{totalPhases}</span>
          </label>
          <input
            id="total_phases"
            name="total_phases"
            type="range"
            min={10}
            max={80}
            value={totalPhases}
            onChange={(e) => setTotalPhases(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
          <div className="flex justify-between text-xs text-stone-500">
            <span>10</span>
            <span>80</span>
          </div>
        </div>

        <div>
          <label htmlFor="phase_duration" className="mb-2 block font-semibold">
            Durée d&apos;une phase :{" "}
            <span className="text-amber-500">{phaseDuration} min</span>
          </label>
          <input
            id="phase_duration"
            name="phase_duration"
            type="range"
            min={1}
            max={10}
            value={phaseDuration}
            onChange={(e) => setPhaseDuration(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
          <div className="flex justify-between text-xs text-stone-500">
            <span>1 min</span>
            <span>10 min</span>
          </div>
        </div>

        {state.error && <p className="text-sm text-red-400">{state.error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-amber-600 py-3 font-bold text-stone-950 transition hover:bg-amber-500 disabled:opacity-50"
        >
          {pending ? "Création…" : "Créer la partie"}
        </button>
      </form>
    </div>
  );
}
