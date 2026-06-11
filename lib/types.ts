export const NATIONS = [
  "Empire Ottoman",
  "Russie",
  "Autriche-Hongrie",
  "Allemagne",
  "Italie",
  "France",
  "Angleterre",
] as const;

export type Nation = (typeof NATIONS)[number];

export const NATION_COLORS: Record<Nation, string> = {
  "Empire Ottoman": "#ca8a04",
  Russie: "#7c3aed",
  "Autriche-Hongrie": "#dc2626",
  Allemagne: "#44403c",
  Italie: "#16a34a",
  France: "#2563eb",
  Angleterre: "#0e7490",
};

export type RoomStatus = "waiting" | "active" | "finished";

export interface Room {
  id: string;
  code: string;
  name: string;
  host_id: string;
  is_public: boolean;
  status: RoomStatus;
  total_phases: number;
  phase_duration_minutes: number;
  current_phase: number;
  max_players: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RoomPlayer {
  id: string;
  room_id: string;
  user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  nation: Nation | null;
  is_host: boolean;
  is_bot: boolean;
  is_alive: boolean;
  joined_at: string;
}

export interface RoomWithCount extends Room {
  room_players: { count: number }[];
}
