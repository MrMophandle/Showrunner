-- 0001 · the spine (E1-2)
--
-- Show → Season → Episode → Scene, the artifacts they produce, and the arcs they
-- move along. Everything is scoped to a show; nothing here hardcodes one.
--
-- RESERVED FOR E2 — do not create these here, and do not take these names:
--   fact             an atomic checkable statement with lineage and validity range (D9)
--   proposal         the only way canon changes; five-part anatomy (1.2)
--   relation         a typed edge between entities
--   relation_type    a category's declaration of an allowed relation: name, target
--                    category, cardinality, inverse name (D23)
--   canon_category   a kind of canon defined as data: fields, applicable artifact
--                    kinds, check instructions (3.2)
-- E1-2 leaves them unclaimed so E2 creates them rather than altering these tables.

CREATE TABLE show (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,             -- stable handle: 'greyharbor', 'deadlight'
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE season (
  id          TEXT PRIMARY KEY,
  show_id     TEXT NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, number)
);

-- Lifecycle is the closed set from 1.1. In TypeScript it is a union type, never an
-- enum: the server runs its TS under Node's type stripping, which only erases.
CREATE TABLE episode (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  lifecycle   TEXT NOT NULL DEFAULT 'premise'
              CHECK (lifecycle IN ('premise','outline','script','assets','assembled','published')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (season_id, number)
);

-- Scenes are DERIVED from the written episode, never prescribed to the writer (D3).
-- There is deliberately no num_scenes column anywhere: the count is SELECT COUNT(*).
-- The continuity board's columns (location, present, environment, ship, elapsed) are
-- E3's, and they anchor here.
CREATE TABLE scene (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  heading     TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (episode_id, ordinal)
);

-- The identity anchor for canon entities, and nothing more. It exists in E1-2 only so
-- artifact provenance can be a real foreign key (invariant 2: checks load exactly the
-- entities in scope — an unenforced reference can silently load nothing). E2 grows it
-- with ADD COLUMN (standing, status, prose body, category_id) and adds the tables above;
-- none of that rewrites this table or artifact_provenance.
CREATE TABLE canon_entity (
  id            TEXT PRIMARY KEY,
  show_id       TEXT NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  category_key  TEXT NOT NULL,                  -- E2 adds category_id REFERENCES canon_category
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, category_key, name)
);

-- Anything produced. `slot` distinguishes the many artifacts of one kind in one episode
-- ('shot-05'); it is '' for the episode's single script, outline, board.
CREATE TABLE artifact (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  scene_id    TEXT REFERENCES scene(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  slot        TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  file_path   TEXT,                             -- relative to the artifact dir; NULL = not produced
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (episode_id, kind, slot)
);

-- Provenance: which canon entities this artifact touches (invariant 2). RESTRICT, because
-- an entity an episode is built on is not something you delete out from under it.
CREATE TABLE artifact_provenance (
  artifact_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE RESTRICT,
  PRIMARY KEY (artifact_id, entity_id)
);

-- What changed at each version. This is what lets the freshness query say *why* in Ryan's
-- own words — "your scene-3 edit made v4" — and lets a scene-scoped consumer ignore a
-- revision that never touched its scene. scene_id NULL means the whole artifact changed.
CREATE TABLE artifact_revision (
  artifact_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  scene_id     TEXT REFERENCES scene(id) ON DELETE SET NULL,
  summary      TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX artifact_revision_once
  ON artifact_revision (artifact_id, version, COALESCE(scene_id, ''));

-- The freshness edge: this artifact consumed that one, at that version, optionally only
-- the part of it belonging to one scene. There is NO is_stale column and never will be —
-- staleness is computed off these edges (1.3), so a stored answer can never go wrong.
CREATE TABLE artifact_input (
  artifact_id        TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  input_artifact_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  consumed_version   INTEGER NOT NULL,
  scene_id           TEXT REFERENCES scene(id) ON DELETE SET NULL,
  CHECK (artifact_id <> input_artifact_id)
);
CREATE UNIQUE INDEX artifact_input_once
  ON artifact_input (artifact_id, input_artifact_id, COALESCE(scene_id, ''));
CREATE INDEX artifact_input_by_source ON artifact_input (input_artifact_id);

-- An arc: scope (show or season), kind (character or story), and the prose statement
-- Ryan re-reads when he has forgotten what the arc was (D24).
CREATE TABLE arc (
  id          TEXT PRIMARY KEY,
  show_id     TEXT NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  season_id   TEXT REFERENCES season(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('show','season')),
  kind        TEXT NOT NULL CHECK (kind IN ('character','story')),
  name        TEXT NOT NULL,
  statement   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, name),
  CHECK ((scope = 'season') = (season_id IS NOT NULL))
);

CREATE TABLE arc_waypoint (
  id                TEXT PRIMARY KEY,
  arc_id            TEXT NOT NULL REFERENCES arc(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',   -- what this waypoint means
  landing_criteria  TEXT NOT NULL DEFAULT '',   -- what landing it looks like on screen (D24)
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (arc_id, ordinal)
);

-- "arc1 @ waypoint2". declared_ordinal is the waypoint's place in the order at the moment
-- the episode declared it. Insert a waypoint ahead of it and the ordinal drifts, which is
-- how "needs re-check" is COMPUTED rather than remembered — same shape as artifact
-- freshness. Re-declaring the position clears it.
CREATE TABLE episode_arc_position (
  episode_id        TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  arc_id            TEXT NOT NULL REFERENCES arc(id) ON DELETE CASCADE,
  waypoint_id       TEXT NOT NULL REFERENCES arc_waypoint(id) ON DELETE CASCADE,
  declared_ordinal  INTEGER NOT NULL,
  declared_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (episode_id, arc_id)
);

-- The arc page's History panel (D24): a waypoint rename keeps Ryan's note. Append-only.
-- When E1-5's event log lands these same call sites emit events too; this stays as the
-- arc's own history, because it is read as prose on one screen, not replayed.
CREATE TABLE arc_edit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  arc_id       TEXT NOT NULL REFERENCES arc(id) ON DELETE CASCADE,
  waypoint_id  TEXT REFERENCES arc_waypoint(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
