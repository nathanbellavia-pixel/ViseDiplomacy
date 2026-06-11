-- Goal 2: game phase columns + realtime on game tables

alter table diplomacy.room_players add column is_eliminated boolean not null default false;
alter table diplomacy.orders add column is_submitted boolean not null default false;
alter table diplomacy.territories add column unit_coast text check (unit_coast in ('nc','sc','ec'));

-- chat spec wants user-id columns alongside the player FKs
alter table diplomacy.private_messages add column sender_user_id text;
alter table diplomacy.private_messages add column recipient_user_id text;

-- realtime for game state, orders status and chat
alter table diplomacy.orders replica identity full;
alter table diplomacy.territories replica identity full;
alter table diplomacy.phases replica identity full;
alter publication supabase_realtime add table diplomacy.orders, diplomacy.territories, diplomacy.phases, diplomacy.private_messages;
