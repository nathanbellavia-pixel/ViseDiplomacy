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
  winner_nation: Nation | null;
  is_draw: boolean;
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
  is_eliminated: boolean;
  draw_vote: boolean;
  joined_at: string;
}

export interface Territory {
  id: string;
  room_id: string;
  code: string;
  name: string;
  type: "land" | "sea" | "coast";
  is_supply_center: boolean;
  owner_nation: Nation | null;
  occupant_nation: Nation | null;
  unit_type: "army" | "fleet" | null;
  unit_coast: string | null;
}

export interface Phase {
  id: string;
  room_id: string;
  phase_number: number;
  year: number;
  season: "spring" | "autumn" | "winter";
  type: "movement" | "retreat" | "adjustment";
  status: "pending" | "active" | "resolving" | "resolved";
  starts_at: string | null;
  ends_at: string | null;
  resolved_at: string | null;
  summary: PhaseSummary | null;
}

// Stored on a phase row once resolved (and, for dislodgements, on the retreat
// phase that follows) — drives the post-resolution feedback UI.
export interface SummaryOrder {
  prov: string;
  nation: Nation;
  unit: "army" | "fleet";
  type: OrderType;
  target: string | null;
  aux: string | null;
  result: string;
}

export interface DislodgedUnit {
  prov: string;
  nation: Nation;
  unit: "army" | "fleet";
  coast: string | null;
  attackerFrom: string;
  options: string[]; // "prov" or "prov/coast"
}

export interface PhaseSummary {
  events: string[];
  orders: SummaryOrder[];
  dislodged: DislodgedUnit[];
}

export type OrderType =
  | "hold"
  | "move"
  | "support"
  | "convoy"
  | "retreat"
  | "build"
  | "disband";

export interface Order {
  id: string;
  room_id: string;
  phase_id: string;
  player_id: string;
  nation: Nation;
  unit_type: "army" | "fleet";
  unit_territory: string;
  order_type: OrderType;
  target_territory: string | null;
  aux_territory: string | null;
  status: "pending" | "submitted" | "resolved";
  result: string | null;
  is_submitted: boolean;
  created_at: string;
  updated_at: string;
}

export interface PrivateMessage {
  id: string;
  room_id: string;
  sender_player_id: string;
  recipient_player_id: string;
  sender_user_id: string | null;
  recipient_user_id: string | null;
  content: string;
  created_at: string;
  read_at: string | null;
}

export interface RoomWithCount extends Room {
  room_players: { count: number }[];
}
