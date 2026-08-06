-- 0006 · the canon graph (E2-0)
--
-- Categories as data (3.2), the relation types they declare (D23), the edges themselves,
-- the references that hang off an entity, and the anatomy 0001 left off `canon_entity`.
--
-- WHAT THIS CLAIMS of 0001's reserved block: `canon_category`, `relation_type`,
-- `relation`. WHAT STAYS RESERVED: `fact` (E2-1) and `proposal` (E2-2). 0001's comment is
-- not edited to say so — an applied migration is never edited — so this note is where a
-- reader finds out, and `RESERVED_TABLE_NAME` in migrate.ts is where a test does.
--
-- NOTHING HERE WRITES CANON. These are the tables ratification writes INTO (invariant 1).
-- The proposal that authorises a write is E2-2's; what E2-0 owns is the shape of the thing
-- written and the refusals that make an edge meaningful — an undeclared relation type, a
-- target of the wrong category, a second edge where the category declared one.

-- ── Categories as data (3.2) ────────────────────────────────────────────────────
--
-- "Adding a category is an edit, not engineering." That promise is only kept if a category
-- is rows: a category encoded as a TypeScript object would make every new show a code
-- change, and 3.5's empty-show story hands a schema document to a Claude session and
-- expects sheets back, not a pull request.
--
-- Scoped to a show, because a show owns its canon store. Two shows may both have
-- `character` and disagree completely about what one declares.
CREATE TABLE canon_category (
  id                  TEXT PRIMARY KEY,
  show_id             TEXT NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  key                 TEXT NOT NULL,                  -- 'character', 'world-rules'
  name                TEXT NOT NULL,                  -- 'Character' — the sheet's title
  blurb               TEXT NOT NULL DEFAULT '',       -- one or two lines of what this is
  -- What a check is told to do with this category's entities (3.2). Prose, because the
  -- reader is an LLM: 4.2 fires one reviewer pass per category and this is its brief.
  check_instructions  TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, key)
);

-- The fields a category's sheets carry, in the order the sheet declares them. A child table
-- rather than a text blob for one reason: E2-1's `fact` names the field it is about, and a
-- field list nobody can join to is a field list nothing can be checked against.
CREATE TABLE category_field (
  category_id  TEXT NOT NULL REFERENCES canon_category(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  name         TEXT NOT NULL,                         -- 'standing', 'status', 'aliases'
  description  TEXT NOT NULL DEFAULT '',              -- what the sheet says it means
  PRIMARY KEY (category_id, name)
);

-- Which artifact kinds this category's checks apply to (3.2) — the query E3 fires at every
-- artifact boundary: given a script, which categories have something to say about it. A
-- comma-joined column would make that query a LIKE scan, which is why this is a table.
--
-- No CHECK on `kind`, matching `artifact.kind` in 0001: the closed set lives in the
-- TypeScript union in app/server/domain/artifact.ts, and a CHECK here would make adding an
-- artifact kind a migration.
CREATE TABLE category_artifact_kind (
  category_id  TEXT NOT NULL REFERENCES canon_category(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  PRIMARY KEY (category_id, kind)
);
CREATE INDEX category_artifact_kind_by_kind ON category_artifact_kind (kind);

-- ── Relation types: a category declares what edges its entities may have (D23) ──
--
-- "A checker cannot traverse an edge whose meaning nobody wrote down." So the declaration
-- carries the target category, the cardinality, whether it is required, and the INVERSE
-- NAME — the name the edge answers to from the far end, which is what makes blast radius
-- computable from both ends rather than only from the side that declared it.
--
-- An inverse is not a second declaration: the species category does not declare `members`.
-- It is navigable from a species because the character category named it here.
CREATE TABLE relation_type (
  id                  TEXT PRIMARY KEY,
  category_id         TEXT NOT NULL REFERENCES canon_category(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,                  -- 'species', 'stationed-at'
  target_category_id  TEXT NOT NULL REFERENCES canon_category(id) ON DELETE RESTRICT,

  -- `exactly-one` and `at-most-one` are enforced IDENTICALLY when an edge is written —
  -- both refuse the second one. What separates them is the other end of the count, and
  -- that is not an insert-time question: an entity is built up one write at a time and is
  -- ragged in between. `required` is DECLARED here and ENFORCED at ratification (E2-2),
  -- where canon must be complete and a candidate may still be half-written.
  cardinality         TEXT NOT NULL CHECK (cardinality IN ('exactly-one','at-most-one','any')),
  required            INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),

  inverse_name        TEXT NOT NULL,                  -- 'members', 'crew', 'carried-by'
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (category_id, name),
  -- One meaning per name at the far end. Without this, two categories could both make
  -- `members` navigable from Species and a traversal by that name would silently return a
  -- mixed bag — the free-verb failure D23 exists to prevent, arriving through the back door.
  UNIQUE (target_category_id, inverse_name)
);

-- ── The edges ───────────────────────────────────────────────────────────────────
--
-- `to_entity_id` IS NULLABLE, AND NULL MEANS `unknown` (D22). This is the ruling that
-- shapes the table, so it is written here as well as in domain/relation.ts:
--
--   no row          nobody has said. A sheet somebody did not finish.
--   row, NULL to    DECLARED unknown. Somebody looked, and the honest answer is that the
--                   world has not decided — the Passenger's species.
--   row, real to    the edge.
--
-- The two states must be distinguishable, and here they are, by a query anyone can write:
-- `WHERE to_entity_id IS NULL` is the canon library's gaps list. The alternative — a
-- sentinel `unknown` entity in the Species category — was rejected: it would be a canon row
-- no proposal ever ratified (invariant 1), it would appear in the species list as a thing
-- in the world, and every character pointing at it would be claiming to share a species
-- with every other. NULL cannot be reached by accident: the column is RESTRICT, so a
-- target never becomes NULL by deletion, and the domain's `relate` takes the word
-- `unknown` explicitly rather than an omitted argument.
--
-- Cardinality is NOT enforced here. It cannot be: the limit lives in `relation_type`, and
-- SQLite indexes cannot consult another table. domain/relation.ts counts inside the
-- transaction that writes, and that is the only write path.
CREATE TABLE relation (
  id                TEXT PRIMARY KEY,
  relation_type_id  TEXT NOT NULL REFERENCES relation_type(id) ON DELETE RESTRICT,
  -- The declaring end. Its edges die with it; the far end does not, which is why the two
  -- columns disagree about deletion.
  from_entity_id    TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  -- RESTRICT for the same reason artifact_provenance uses it: something canon points at is
  -- not something you delete out from under it.
  to_entity_id      TEXT          REFERENCES canon_entity(id) ON DELETE RESTRICT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (from_entity_id <> to_entity_id)
);

-- COALESCE, because SQLite counts two NULLs as distinct and a character would otherwise be
-- allowed to declare its species unknown twice.
CREATE UNIQUE INDEX relation_once
  ON relation (relation_type_id, from_entity_id, COALESCE(to_entity_id, ''));
CREATE INDEX relation_from ON relation (from_entity_id);
CREATE INDEX relation_to ON relation (to_entity_id);

-- ── References: part of an entity's anatomy (3.1) ───────────────────────────────
--
-- Locked reference images, voice clips, style boards. `locked` is what a generation must
-- match; `aspirational` is what somebody hopes it will look like one day — the distinction
-- exists so a check can hold an image to the first and never to the second.
--
-- The MODEL is E2's and the FILES are E6's: `file_path` points into the library's artifact
-- dir the way `artifact.file_path` does, and nothing here reads or writes bytes.
CREATE TABLE entity_reference (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('image','voice','style-board')),
  file_path   TEXT NOT NULL,                          -- relative to the library artifact dir
  stance      TEXT NOT NULL CHECK (stance IN ('locked','aspirational')),
  label       TEXT NOT NULL DEFAULT '',               -- what it is, in Ryan's words
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity_id, kind, file_path)
);
CREATE INDEX entity_reference_by_entity ON entity_reference (entity_id);

-- ── Growing canon_entity (3.1) ──────────────────────────────────────────────────
--
-- ADD COLUMN, never a rebuild. `artifact_provenance` holds a foreign key into this table,
-- placed there in E1-2 because SQLite has no ADD CONSTRAINT — rebuilding the table is
-- exactly what would break the edge it was created early to protect. These four columns
-- are the ones 0001's comment said E2 would add.
--
-- `category_id` is nullable because SQLite requires a NULL default on an added REFERENCES
-- column, and that turns out to be the honest shape anyway: `category_key` has been the
-- identity handle since 0001 (it is in the UNIQUE key and cannot be dropped without the
-- rebuild this migration exists to avoid), and rows written before their show declared its
-- categories genuinely have no category to point at. The trigger below is what keeps the
-- two from ever disagreeing.
ALTER TABLE canon_entity ADD COLUMN category_id TEXT REFERENCES canon_category(id) ON DELETE RESTRICT;

-- Declared intent, not a count — appearance history is computed from provenance (3.1).
-- NULL means not declared, which is a different thing from `one-shot`: an identity
-- registered so provenance could point at it has made no claim about how it will be used,
-- and defaulting it to a value would put words in the sheet's mouth.
ALTER TABLE canon_entity ADD COLUMN standing TEXT;

-- `candidate` is the truthful default for every row that exists today and every row
-- `registerEntity` writes tomorrow: nothing has ratified them. E2-2's promotion proposal is
-- what turns a candidate active, and the canon library renders the difference (E2-6).
ALTER TABLE canon_entity ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate';

-- What else the scripts call them. A column rather than a table because aliases are read
-- with the sheet and never joined from — the same call the issue makes.
ALTER TABLE canon_entity ADD COLUMN aliases TEXT NOT NULL DEFAULT '';

-- The prose sheet that makes drafts good (3.1). Sectioned per the category's fields.
ALTER TABLE canon_entity ADD COLUMN body TEXT NOT NULL DEFAULT '';

-- The CHECKs 0001 could have written inline and ADD COLUMN cannot. A trigger is the only
-- way to constrain an added column in SQLite, and these three are worth the noise: a
-- standing or status outside its vocabulary is a value no screen knows how to render.
CREATE TRIGGER canon_entity_anatomy_insert BEFORE INSERT ON canon_entity
  WHEN (NEW.standing IS NOT NULL AND NEW.standing NOT IN ('core','recurring','one-shot','retired'))
    OR NEW.status NOT IN ('active','historical','candidate')
  BEGIN SELECT RAISE(ABORT, 'canon_entity: standing is core/recurring/one-shot/retired, status is active/historical/candidate'); END;

CREATE TRIGGER canon_entity_anatomy_update BEFORE UPDATE ON canon_entity
  WHEN (NEW.standing IS NOT NULL AND NEW.standing NOT IN ('core','recurring','one-shot','retired'))
    OR NEW.status NOT IN ('active','historical','candidate')
  BEGIN SELECT RAISE(ABORT, 'canon_entity: standing is core/recurring/one-shot/retired, status is active/historical/candidate'); END;

-- Two names for one thing must never disagree. `category_key` is what 0001's UNIQUE key is
-- built on and what every existing caller passes; `category_id` is the real edge. A row may
-- have only the key (no category declared yet), but if it has both they name the same
-- category OF THE SAME SHOW.
CREATE TRIGGER canon_entity_category_agrees_insert BEFORE INSERT ON canon_entity
  WHEN NEW.category_id IS NOT NULL
   AND NEW.category_id NOT IN (
     SELECT id FROM canon_category WHERE show_id = NEW.show_id AND key = NEW.category_key)
  BEGIN SELECT RAISE(ABORT, 'canon_entity: category_id must be this show''s category with that category_key'); END;

CREATE TRIGGER canon_entity_category_agrees_update BEFORE UPDATE ON canon_entity
  WHEN NEW.category_id IS NOT NULL
   AND NEW.category_id NOT IN (
     SELECT id FROM canon_category WHERE show_id = NEW.show_id AND key = NEW.category_key)
  BEGIN SELECT RAISE(ABORT, 'canon_entity: category_id must be this show''s category with that category_key'); END;
