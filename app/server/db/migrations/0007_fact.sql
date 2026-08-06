-- 0007 · facts, and time (E2-1)
--
-- The atomic checkable statements an entity is made of (3.1), append-only with validity
-- ranges so "canon as of episode 4" is answerable (D9).
--
-- WHAT THIS CLAIMS of 0001's reserved block: `fact`. WHAT STAYS RESERVED: `proposal`
-- (E2-2). 0001's comment is not edited to say so — an applied migration is never edited —
-- so this note is where a reader finds out, and `RESERVED_TABLE_NAME` in migrate.ts is
-- where a test does.
--
-- NOTHING HERE WRITES CANON on its own. `fact` is the table ratification writes INTO
-- (invariant 1), and domain/fact.ts is the low-level write beneath E2-2's ruling API the
-- way `registerEntity` and `relate` are.

-- ── The clock canon is read by ──────────────────────────────────────────────────
--
-- A fact's lineage has to name the RULING that made it true, and rulings belong to E2-2's
-- proposal flow, which does not exist yet. SQLite has no ADD CONSTRAINT: whatever
-- `fact.ratified_by` references must exist AT CREATE TIME or never. So the anchor is built
-- here, deliberately thin — the `canon_entity` precedent exactly. E1-2 built a thin entity
-- table early so `artifact_provenance` could carry a real foreign key from day one, and
-- 0006 grew it with ADD COLUMN rather than rebuilding it. This table is that move again.
--
-- THIS TABLE IS THE DISPOSITION LEDGER E2-2 GROWS. It adds `proposal_id`, the gate a
-- proposal was ruled at, Ryan's notes, and its own kinds — by ADD COLUMN and by writing
-- new kind values. **It must not create a sibling table.** Every canon ruling Ryan makes
-- lands here and every kind of it is kept forever (3.3); a second table would split the
-- one order canon is read by in half, and half an order is no order. `fact.ratified_by`
-- and `fact_closure.closed_by` only ever point at rows whose kind writes canon.
--
-- REJECTED: anchoring lineage to `event.seq`. Rulings do append events and `seq` is the
-- one ordering this repo trusts — but an event row requires a run AND an episode, both
-- NOT NULL with RESTRICT (0003), and a FOUNDING ratification (D25 — E2-4 ratifying the
-- Grey Harbor sheets) has neither. Anchoring there would force the deferred
-- episode-less-run migration now, as a side effect of a lineage decision. And it would
-- make `event` — the largest and fastest-growing table in the database, since it carries
-- every streamed chunk — load-bearing infrastructure for every canon query. The record
-- stays the record, never the state.
CREATE TABLE canon_ruling (
  -- The order canon is read by, and the only thing that may be trusted for it. Same lesson
  -- as the event log: `at` has millisecond resolution, two rulings land inside one
  -- millisecond, and clocks step backwards. AUTOINCREMENT settles it. `canonAsOf(date)`
  -- maps a date onto this number and then queries by the number — never the reverse.
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,

  -- No CHECK, deliberately. E2-1 writes the two kinds that touch a fact's validity
  -- ('ratification', 'revert'); 3.3's other dispositions (rejected, deferred) are E2-2's
  -- to add, and a CHECK here would make adding one a table rebuild — the one thing this
  -- table exists to avoid. The closed set lives in the TypeScript union in
  -- app/server/domain/fact.ts, the same call 0001 made for `artifact.kind`.
  kind  TEXT NOT NULL,

  at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))   -- for humans
);

-- The one query that reads `at`: resolving a date to the last ruling at or before it.
CREATE INDEX canon_ruling_by_time ON canon_ruling (at, seq);

-- A ruling is history the moment it is made — the rule `gate_ruling` states in 0004, held
-- here too. Unlike `gate_ruling` this one also refuses DELETE: there is no cascade above it
-- to preserve (every reference into it is RESTRICT), so nothing legitimate ever needs to
-- erase a disposition, and a canon read as of a deleted ruling would answer differently
-- than it did yesterday.
CREATE TRIGGER canon_ruling_is_history_update BEFORE UPDATE ON canon_ruling
  BEGIN SELECT RAISE(ABORT, 'a ruling is history — a new opinion is a new ruling, never an edit'); END;

CREATE TRIGGER canon_ruling_is_history_delete BEFORE DELETE ON canon_ruling
  BEGIN SELECT RAISE(ABORT, 'a ruling is history — canon is read as of it forever'); END;

-- ── Facts ───────────────────────────────────────────────────────────────────────
--
-- APPEND-ONLY, AND THE ROWS ARE FULLY IMMUTABLE. The one state change a fact has — open
-- validity becoming closed — is a row in `fact_closure`, not an UPDATE here. The
-- alternative was a guarded one-way UPDATE (a trigger whose WHEN clause permits only
-- open→closed, once); it was rejected for a reason this schema keeps proving: tables here
-- grow by ADD COLUMN (0006 added five columns to `canon_entity` last week), and a WHEN
-- clause that enumerates the immutable columns silently stops covering the column added
-- after it. A blanket ABORT cannot rot that way, and "one closure, ever" becomes a PRIMARY
-- KEY rather than trigger logic. The cost is one LEFT JOIN on a primary key per read, paid
-- knowingly. The reasoning is repeated in app/server/domain/fact.ts, where the consequence
-- lives: ratifying a provisional fact writes a new row and closes the old one.
CREATE TABLE fact (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- Which of the category's fields this fact is about ('physiology', 'conduct') — the
  -- column the canon library's facts table renders, and the reason `category_field` is a
  -- table rather than a blob (0006). NULL means the sheet did not say; the Grey Harbor
  -- sheets carry bare statements, and '' would be a third spelling of the same nothing,
  -- which is why the CHECK below refuses it.
  --
  -- Deliberately NOT a foreign key into `category_field`. It could not be one — that list
  -- is keyed by (category_id, name) and a fact knows its entity, not its category — and it
  -- should not be one: a fact established mid-episode would then fail at the write until
  -- somebody edited the category, turning "adding a field is an edit" into "every fact
  -- write can fail on a data-entry mismatch". A field the category has not declared is a
  -- completeness question, and completeness is ruled at ratification (E2-2), the same line
  -- `required` relations are held to (D23, 0006).
  field           TEXT,

  statement       TEXT NOT NULL,

  -- Lineage (3.1). Both are nullable, and each NULL says something specific:
  --   established_in NULL   no episode established it — a founding ratification (D25) or a
  --                         pre-episode premise pitch (5.7).
  --   ratified_by    NULL   PROVISIONAL. Raised, riding its episode, visible to checks
  --                         (3.3) and invisible to `canonAsOf`: canon is what was ratified.
  established_in  TEXT     REFERENCES episode(id)       ON DELETE RESTRICT,
  ratified_by     INTEGER  REFERENCES canon_ruling(seq) ON DELETE RESTRICT,

  -- The inherited fact this one displaces (D22 addendum): "an individual exception is a
  -- fact on the character that names what it overrides". The named fact belongs to an
  -- entity this one inherits from — never to this one — and domain/fact.ts refuses the
  -- rest, because which facts an entity inherits depends on a relation two tables over.
  overrides       TEXT     REFERENCES fact(id) ON DELETE RESTRICT,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- A fact with nothing in it checks nothing, and a blank field is a second way to spell
  -- "not said". NULL is the only one.
  CHECK (statement <> ''),
  CHECK (field IS NULL OR field <> ''),
  CHECK (id <> overrides)
);

CREATE INDEX fact_by_entity ON fact (entity_id);
-- The as-of read: every fact ratified at or before a ruling.
CREATE INDEX fact_by_ruling ON fact (ratified_by);
-- Blast radius from the far end: which exceptions displace this species fact (E2-2).
CREATE INDEX fact_overriding ON fact (overrides) WHERE overrides IS NOT NULL;

-- The end of a validity range, and the lineage OF that end — a closure records what closed
-- it, because that is the whole point of keeping the range. `superseded_by` NULL is the
-- revert: closed with no successor (3.3).
--
-- PRIMARY KEY on `fact_id` is the "closed once, one way" rule, enforced structurally
-- rather than by a trigger's WHEN clause. A second closure is a constraint violation, not
-- a judgement call.
CREATE TABLE fact_closure (
  fact_id        TEXT PRIMARY KEY REFERENCES fact(id) ON DELETE RESTRICT,
  closed_by      INTEGER NOT NULL REFERENCES canon_ruling(seq) ON DELETE RESTRICT,
  superseded_by  TEXT REFERENCES fact(id) ON DELETE RESTRICT,
  note           TEXT NOT NULL DEFAULT '',
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (fact_id <> superseded_by)
);

CREATE INDEX fact_closure_by_ruling ON fact_closure (closed_by);

-- Immutable, enforced by the database rather than by anyone's discipline — the same shape
-- as the event log's guarantee (0003) and for the same reason: the module has no update
-- path, and these make that true of the SQLite file itself, including for a migration, an
-- import, or a hand-typed statement.
--
-- The DELETE trigger is not decoration. 0003 already recorded the rule it enforces: an
-- abandoned episode has its facts REVERTED BY RULING (3.3), never removed. Every reference
-- into `fact` is RESTRICT, so no cascade needs the door left open.
CREATE TRIGGER fact_is_immutable_update BEFORE UPDATE ON fact
  BEGIN SELECT RAISE(ABORT, 'a fact is immutable — a new statement is a new fact that closes this one (D9)'); END;

CREATE TRIGGER fact_is_immutable_delete BEFORE DELETE ON fact
  BEGIN SELECT RAISE(ABORT, 'a fact is never deleted — it is reverted by ruling, and the range stays readable (3.3)'); END;

CREATE TRIGGER fact_closure_is_final_update BEFORE UPDATE ON fact_closure
  BEGIN SELECT RAISE(ABORT, 'a closure is a ruling''s record — reopening canon is a new fact, not an edit'); END;

CREATE TRIGGER fact_closure_is_final_delete BEFORE DELETE ON fact_closure
  BEGIN SELECT RAISE(ABORT, 'a closure is a ruling''s record — reopening canon is a new fact, not a deletion'); END;

-- ── Inheritance is declared, not known (D22, D23) ───────────────────────────────
--
-- "The species' facts load into check scope with its members." The mechanism is general
-- and the word `species` is not: it is a key on a Grey Harbor sheet, and nothing in
-- domain/category.ts knows the word `character` either. So a category declares that facts
-- travel an edge, the same way it declares that edge's cardinality and inverse — data, not
-- code (3.2, D23). D22 compliance for the shipped categories is then a line on a sheet:
-- the character category's `species` declaration carries `inherits facts: yes`.
--
-- DIRECTION IS EXPLICIT AND ONE-WAY: facts travel the DECLARED edge, from the declaring
-- entity to its target. A character inherits from the species it points at. The inverse
-- never carries anything — a species inherits nothing from its members, and two members of
-- one species inherit nothing from each other.
--
-- REJECTED: the scope helper knowing the word `species`. Fact inheritance is a property of
-- an edge, and a mechanism a category cannot declare is a mechanism a new show cannot have
-- without engineering — which is the promise 3.2 and 3.5 rest on.
--
-- ADD COLUMN, never a rebuild: `relation_type` shipped in 0006 and is applied on real
-- volumes, and `relation` holds a foreign key into it.
ALTER TABLE relation_type ADD COLUMN inherits_facts INTEGER NOT NULL DEFAULT 0;

-- The CHECK an ADD COLUMN cannot carry, as triggers — 0006's precedent for the anatomy
-- columns it added to `canon_entity`. Worth the noise here because the domain reads this
-- column as `=== 1`: a stray 2 would not fail, it would quietly mean "does not inherit",
-- and an entity silently missing its species' facts is a check that reports clean on an
-- artifact it never really read (invariant 2).
CREATE TRIGGER relation_type_inherits_facts_insert BEFORE INSERT ON relation_type
  WHEN NEW.inherits_facts NOT IN (0, 1)
  BEGIN SELECT RAISE(ABORT, 'relation_type: inherits_facts is 0 or 1'); END;

CREATE TRIGGER relation_type_inherits_facts_update BEFORE UPDATE ON relation_type
  WHEN NEW.inherits_facts NOT IN (0, 1)
  BEGIN SELECT RAISE(ABORT, 'relation_type: inherits_facts is 0 or 1'); END;
