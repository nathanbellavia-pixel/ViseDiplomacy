"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import { sendMessage } from "@/app/game-actions";
import { NATION_COLORS, type PrivateMessage, type RoomPlayer } from "@/lib/types";

export default function ChatPanel({
  roomId,
  me,
  players,
}: {
  roomId: string;
  me: RoomPlayer;
  players: RoomPlayer[];
}) {
  const [open, setOpen] = useState(false);
  const [activeContact, setActiveContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<PrivateMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const threadRef = useRef<HTMLDivElement>(null);
  const [readUpTo, setReadUpTo] = useState<Record<string, number>>({});

  const contacts = players.filter((p) => !p.is_bot && p.id !== me.id);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const fetchMine = async () => {
      const { data } = await supabase
        .from("private_messages")
        .select()
        .eq("room_id", roomId)
        .or(`sender_player_id.eq.${me.id},recipient_player_id.eq.${me.id}`)
        .order("created_at");
      if (data) setMessages(data as PrivateMessage[]);
    };
    const channel = supabase
      .channel(`chat-${roomId}-${me.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "diplomacy",
          table: "private_messages",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const msg = payload.new as PrivateMessage;
          if (msg.sender_player_id === me.id || msg.recipient_player_id === me.id) {
            setMessages((prev) =>
              prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
            );
          }
        }
      )
      .subscribe();
    fetchMine();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, me.id]);

  const thread = useMemo(
    () =>
      activeContact
        ? messages.filter(
            (m) =>
              m.sender_player_id === activeContact ||
              m.recipient_player_id === activeContact
          )
        : [],
    [messages, activeContact]
  );

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
    if (activeContact) {
      setReadUpTo((prev) => ({ ...prev, [activeContact]: thread.length }));
    }
  }, [thread.length, activeContact]);

  const unreadFrom = (contactId: string) =>
    messages.filter((m) => m.sender_player_id === contactId).length -
    (readUpTo[contactId] ?? 0) >
      0 && activeContact !== contactId;

  const totalUnread = contacts.some((c) => unreadFrom(c.id));

  const handleSend = () => {
    if (!activeContact || !draft.trim()) return;
    const text = draft;
    setDraft("");
    setError(null);
    startTransition(async () => {
      const result = await sendMessage(roomId, activeContact, text);
      if (result.error) {
        setError(result.error);
        setDraft(text);
      }
    });
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="chat-toggle"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-amber-600 px-5 py-3 font-bold text-stone-950 shadow-lg transition hover:bg-amber-500"
      >
        💬 Messages
        {totalUnread && (
          <span className="h-2.5 w-2.5 rounded-full bg-red-600" data-testid="chat-unread" />
        )}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-40 flex h-[480px] w-[380px] flex-col overflow-hidden rounded-xl border border-[var(--card-border)] bg-[#12141c]/90 shadow-2xl backdrop-blur-md">
          <div className="border-b border-[var(--card-border)] px-4 py-2.5 font-semibold">
            Messages privés
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="w-32 shrink-0 overflow-y-auto border-r border-[var(--card-border)]">
              {contacts.length === 0 && (
                <p className="p-3 text-xs text-[var(--text-2)]">Aucun autre joueur humain.</p>
              )}
              {contacts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveContact(c.id)}
                  data-contact={c.display_name}
                  className={`block w-full px-3 py-2.5 text-left text-sm transition hover:bg-white/5 ${
                    activeContact === c.id ? "bg-white/10 font-semibold" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: c.nation ? NATION_COLORS[c.nation] : "#57534e",
                      }}
                    />
                    <span className="truncate">{c.display_name}</span>
                    {unreadFrom(c.id) && (
                      <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-600" />
                    )}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {activeContact ? (
                <>
                  <div ref={threadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                    {thread.map((m) => (
                      <div
                        key={m.id}
                        data-message
                        className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${
                          m.sender_player_id === me.id
                            ? "ml-auto bg-amber-900/60"
                            : "bg-white/10"
                        }`}
                      >
                        {m.content}
                      </div>
                    ))}
                    {thread.length === 0 && (
                      <p className="pt-6 text-center text-xs text-stone-500">
                        Début de la conversation. Négociez bien…
                      </p>
                    )}
                  </div>
                  {error && <p className="px-3 text-xs text-red-400">{error}</p>}
                  <div className="flex gap-2 border-t border-[var(--card-border)] p-2.5">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSend()}
                      placeholder="Votre message…"
                      data-testid="chat-input"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--card-border)] bg-[#0f1117]/80 px-3 py-1.5 text-sm outline-none transition focus:border-amber-500"
                    />
                    <button
                      onClick={handleSend}
                      disabled={isPending || !draft.trim()}
                      data-testid="chat-send"
                      className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-bold text-stone-950 disabled:opacity-50"
                    >
                      ➤
                    </button>
                  </div>
                </>
              ) : (
                <p className="p-4 text-sm text-stone-500">
                  Choisissez un joueur pour ouvrir une conversation privée.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
