-- Mutual draws: every non-eliminated player must accept for the game to end
-- in a shared draw (rooms.is_draw=true, winner_nation stays null).
alter table diplomacy.rooms
  add column if not exists is_draw boolean not null default false;

alter table diplomacy.room_players
  add column if not exists draw_vote boolean not null default false;
