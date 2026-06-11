-- Goal 3: adjudication, phase cycle, victory

-- a phase is claimed (active -> resolving) before adjudication so resolution
-- can never run twice; 'resolving' rows older than a minute may be retried
alter table diplomacy.phases drop constraint phases_status_check;
alter table diplomacy.phases add constraint phases_status_check
  check (status in ('pending','active','resolving','resolved'));

-- post-resolution feedback + retreat bookkeeping (dislodged units live here
-- between movement resolution and retreat resolution)
alter table diplomacy.phases add column summary jsonb;

-- retreat/adjustment phases reuse the movement phase_number
alter table diplomacy.phases drop constraint phases_room_id_phase_number_key;
alter table diplomacy.phases add constraint phases_room_phase_unique
  unique (room_id, phase_number, season, type);

alter table diplomacy.rooms add column winner_nation text
  check (winner_nation in ('Empire Ottoman','Russie','Autriche-Hongrie','Allemagne','Italie','France','Angleterre'));

-- retreat orders that fail (two retreats to the same province) disband
alter table diplomacy.orders drop constraint orders_result_check;
alter table diplomacy.orders add constraint orders_result_check
  check (result in ('success','bounced','cut','dislodged','invalid','disbanded'));
