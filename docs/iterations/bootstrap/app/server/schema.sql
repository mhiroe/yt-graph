-- yt-graph provenance-first schema (Phase 1 PoC)
-- Every candidate channel carries its discovery evidence; edges and judgments
-- reference evidence, never bare assertions.

create table if not exists channel (
  id            text primary key,          -- YouTube channel id (UC...) or fixture id
  title         text not null,
  handle        text,
  description   text,
  url           text,
  status        text not null default 'candidate',  -- seed | candidate | accepted | rejected | later
  first_seen_at text not null default (datetime('now')),
  last_seen_at  text not null default (datetime('now'))
);

create table if not exists edge (
  id              integer primary key autoincrement,
  src_channel_id  text not null references channel(id),
  dst_channel_id  text not null references channel(id),
  kind            text not null,           -- expansion | related | consult | ...
  created_at      text not null default (datetime('now')),
  unique (src_channel_id, dst_channel_id, kind)
);

create table if not exists discovery_evidence (
  id              integer primary key autoincrement,
  channel_id      text not null references channel(id),
  seed_channel_id text references channel(id),
  source          text not null,           -- search | subscriptions | playlists | chappy | manual | fixture
  detail          text not null default '{}',  -- json payload from the source adapter
  created_at      text not null default (datetime('now'))
);

create table if not exists channel_snapshot (
  id          integer primary key autoincrement,
  channel_id  text not null references channel(id),
  fetched_at  text not null default (datetime('now')),
  payload     text not null default '{}'   -- json: metadata as observed
);

create table if not exists judgment (
  id          integer primary key autoincrement,
  channel_id  text not null references channel(id),
  judge       text not null,               -- jev | chappy | rule:<name>
  criteria    text not null default '{}',  -- json: criterion -> score
  score       real,
  verdict     text,                        -- pass | drop | review
  created_at  text not null default (datetime('now'))
);

create table if not exists human_decision (
  id          integer primary key autoincrement,
  channel_id  text not null references channel(id),
  decision    text not null,               -- accept | reject | later
  note        text,
  created_at  text not null default (datetime('now'))
);

create index if not exists idx_evidence_channel on discovery_evidence(channel_id);
create index if not exists idx_judgment_channel on judgment(channel_id);
create index if not exists idx_decision_channel on human_decision(channel_id);
create index if not exists idx_edge_dst on edge(dst_channel_id);
