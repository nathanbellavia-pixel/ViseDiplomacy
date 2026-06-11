-- Vise Diplomacy — full game schema, applied 2026-06-11.
-- Lives in a dedicated "diplomacy" Postgres schema so it can coexist with
-- other apps sharing the same Supabase project. To move to another project,
-- run this file as-is in the SQL editor, then update .env.local.

create schema if not exists diplomacy;

grant usage on schema diplomacy to anon, authenticated, service_role;
alter default privileges in schema diplomacy grant all on tables to anon, authenticated, service_role;
alter default privileges in schema diplomacy grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema diplomacy grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------- rooms
create table diplomacy.rooms (
  id uuid primary key default gen_random_uuid(),
  code char(6) not null unique,
  name text not null check (char_length(name) between 1 and 60),
  host_id text not null, -- Clerk user id
  is_public boolean not null default true,
  status text not null default 'waiting' check (status in ('waiting','active','finished')),
  total_phases integer not null check (total_phases between 10 and 80),
  phase_duration_minutes integer not null check (phase_duration_minutes between 1 and 10),
  current_phase integer not null default 0,
  max_players integer not null default 7,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- ---------------------------------------------------------- room_players
create table diplomacy.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references diplomacy.rooms(id) on delete cascade,
  user_id text, -- Clerk user id; null for bots
  display_name text not null,
  avatar_url text,
  nation text check (nation in ('Empire Ottoman','Russie','Autriche-Hongrie','Allemagne','Italie','France','Angleterre')),
  is_host boolean not null default false,
  is_bot boolean not null default false,
  is_alive boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id),
  unique (room_id, nation)
);
create index room_players_room_id_idx on diplomacy.room_players(room_id);
create index room_players_user_id_idx on diplomacy.room_players(user_id);

-- ---------------------------------------------------------------- phases
create table diplomacy.phases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references diplomacy.rooms(id) on delete cascade,
  phase_number integer not null check (phase_number >= 1),
  year integer not null default 1901,
  season text not null default 'spring' check (season in ('spring','autumn','winter')),
  type text not null default 'movement' check (type in ('movement','retreat','adjustment')),
  status text not null default 'pending' check (status in ('pending','active','resolved')),
  starts_at timestamptz,
  ends_at timestamptz,
  resolved_at timestamptz,
  unique (room_id, phase_number)
);
create index phases_room_id_idx on diplomacy.phases(room_id);

-- ------------------------------------------------------------ territories
-- Per-room board state. Seeded from the classic map when a game starts.
create table diplomacy.territories (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references diplomacy.rooms(id) on delete cascade,
  code text not null, -- e.g. 'PAR', 'LON', 'MAO'
  name text not null,
  type text not null check (type in ('land','sea','coast')),
  is_supply_center boolean not null default false,
  owner_nation text check (owner_nation in ('Empire Ottoman','Russie','Autriche-Hongrie','Allemagne','Italie','France','Angleterre')),
  occupant_nation text check (occupant_nation in ('Empire Ottoman','Russie','Autriche-Hongrie','Allemagne','Italie','France','Angleterre')),
  unit_type text check (unit_type in ('army','fleet')),
  unique (room_id, code)
);
create index territories_room_id_idx on diplomacy.territories(room_id);

-- ---------------------------------------------------------------- orders
create table diplomacy.orders (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references diplomacy.rooms(id) on delete cascade,
  phase_id uuid not null references diplomacy.phases(id) on delete cascade,
  player_id uuid not null references diplomacy.room_players(id) on delete cascade,
  nation text not null check (nation in ('Empire Ottoman','Russie','Autriche-Hongrie','Allemagne','Italie','France','Angleterre')),
  unit_type text not null check (unit_type in ('army','fleet')),
  unit_territory text not null, -- territory code the unit sits on
  order_type text not null check (order_type in ('hold','move','support','convoy','retreat','build','disband')),
  target_territory text,
  aux_territory text, -- supported/convoyed unit origin
  status text not null default 'pending' check (status in ('pending','submitted','resolved')),
  result text check (result in ('success','bounced','cut','dislodged','invalid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phase_id, unit_territory)
);
create index orders_room_id_idx on diplomacy.orders(room_id);
create index orders_phase_id_idx on diplomacy.orders(phase_id);
create index orders_player_id_idx on diplomacy.orders(player_id);

-- ------------------------------------------------------- private_messages
create table diplomacy.private_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references diplomacy.rooms(id) on delete cascade,
  sender_player_id uuid not null references diplomacy.room_players(id) on delete cascade,
  recipient_player_id uuid not null references diplomacy.room_players(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index private_messages_room_id_idx on diplomacy.private_messages(room_id);
create index private_messages_recipient_idx on diplomacy.private_messages(recipient_player_id, read_at);

-- -------------------------------------------------------------- triggers
create or replace function diplomacy.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger rooms_set_updated_at before update on diplomacy.rooms
  for each row execute function diplomacy.set_updated_at();
create trigger orders_set_updated_at before update on diplomacy.orders
  for each row execute function diplomacy.set_updated_at();

-- ------------------------------------------------------------------- RLS
-- Identity is enforced in the Next.js server layer (Clerk); Supabase only
-- sees the anon role, so lobby tables get permissive policies. Tighten when
-- Clerk third-party auth is wired into Supabase.
alter table diplomacy.rooms enable row level security;
alter table diplomacy.room_players enable row level security;
alter table diplomacy.phases enable row level security;
alter table diplomacy.territories enable row level security;
alter table diplomacy.orders enable row level security;
alter table diplomacy.private_messages enable row level security;

create policy rooms_all on diplomacy.rooms for all to anon, authenticated using (true) with check (true);
create policy room_players_all on diplomacy.room_players for all to anon, authenticated using (true) with check (true);
create policy phases_all on diplomacy.phases for all to anon, authenticated using (true) with check (true);
create policy territories_all on diplomacy.territories for all to anon, authenticated using (true) with check (true);
create policy orders_all on diplomacy.orders for all to anon, authenticated using (true) with check (true);
create policy private_messages_all on diplomacy.private_messages for all to anon, authenticated using (true) with check (true);

-- --------------------------------------------------------------- realtime
alter table diplomacy.rooms replica identity full;
alter table diplomacy.room_players replica identity full;
alter publication supabase_realtime add table diplomacy.rooms, diplomacy.room_players;

-- ------------------------------------------------- expose schema via REST
-- Makes PostgREST serve the diplomacy schema (equivalent to adding it to
-- "Exposed schemas" in the dashboard API settings).
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, diplomacy';
notify pgrst, 'reload config';
