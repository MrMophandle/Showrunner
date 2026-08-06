-- 0008 · proposals, the only way canon changes (E2-2)
--
-- The five-part change Ryan rules on (1.2, 3.3): the change itself, the usage context that
-- made it necessary, the alternatives that were not taken, and — through the ledger below —
-- who raised it and what he decided. The fifth part, the implications, is NOT here: blast
-- radius is COMPUTED at read time from relations, provenance and facts (domain/proposal.ts),
-- the same call artifact freshness and arc drift already made. A stored blast radius is a
-- stored answer that goes wrong the moment anything it summarised moves.
--
-- WHAT THIS CLAIMS of 0001's reserved block: `proposal` — **the last name on it**. 0006 took
-- `relation`, `relation_type` and `canon_category`, 0007 took `fact`, and this takes what is
-- left. 0001's comment is not edited to say so — an applied migration is never edited — so
-- this note is where a reader finds out, and `RESERVED_TABLE_NAME` in migrate.ts, now empty,
-- is where a test does.
--
-- THIS IS THE ONE WRITE PATH INTO CANON. Nothing else may write `fact`, `relation`, or an
-- entity's sheet (invariant 1): not an agent, not a check remediation, not the runner, not
-- an import (E7), not a fixture load (E2-4), not a migration. They all raise proposals and
-- Ryan rules them through the same API (D25). `registerEntity` stays the identity insert
-- BENEATH this flow — it makes a `candidate`, which is a row nobody has ruled on and looks
-- like one — never a way around it.

-- THE DISPOSITION LEDGER GROWS; IT DOES NOT GAIN A SIBLING. 0007 built `canon_ruling` thin
-- and said, in its header, that E2-2 grows it by ADD COLUMN. That is the block at the foot
-- of this file. A second table — `proposal_ruling`, `disposition`, anything beside it —
-- would fork the one order canon is read by, and half an order is no order: `fact.ratified_by`
-- and `fact_closure.closed_by` already point at `seq`, and a validity range measured against
-- two clocks is measurable against neither. The ALTERs come last only because a column that
-- REFERENCES `proposal` wants the table under it first.

-- ── The three kinds a canon ruling puts on the wire ─────────────────────────────
--
-- The database's half of a code change, exactly as 0004 built it: a kind is a row here AND
-- a member of EVENT_KIND in app/server/events.ts AND a sentence something renders. Three,
-- for the same reason the gate has four — "ratified the Mara proposal" wrote canon and
-- "deferred the Mara proposal" wrote nothing, and a log that cannot tell them apart has
-- lost the only record of when canon moved.
--
-- Only rulings CONVENED AT A GATE reach the log: `event.run_id` is NOT NULL and the bench
-- (E2-6) and the founding flow (E2-4) have no run. That is the episode-less-run relaxation
-- E1-5 deferred, and E2-2 does not force it as a side effect of a disposition — the ledger
-- above is where every ruling is recorded, and canon reads it from there regardless.
INSERT INTO event_kind (kind) VALUES
  ('proposal-ratified'), ('proposal-rejected'), ('proposal-deferred');

-- ── The proposal ────────────────────────────────────────────────────────────────
--
-- NO `status` COLUMN, and none may be added. A proposal's standing is its disposition:
-- unruled, or the kind of the ruling that disposed of it. Storing it would be a second name
-- for a fact the ledger already carries, and two names for one thing eventually disagree.
--
-- NO `show_id` either. Canon is scoped to a show and the subject entity carries the scope;
-- a second copy is a second thing that can be wrong. The bench's queue joins `canon_entity`,
-- exactly as `canonAsOf` does for a show-wide read.
CREATE TABLE proposal (
  id          TEXT PRIMARY KEY,

  -- The subject: the entity the change is about. Every kind has one — the entity a fact is
  -- about, the entity an edge is declared FROM, the candidate being promoted — which is what
  -- makes blast radius answerable and the canon library's "1 pending proposal touches this"
  -- one query rather than three.
  entity_id   TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- fact-delta | relation-delta | promotion. No CHECK: 0007's reasoning, unchanged — the
  -- closed set is the TypeScript union in domain/proposal.ts, and adding a kind is a code
  -- change with a test rather than a table rebuild (the Archon rule).
  kind        TEXT NOT NULL,

  -- NULLABLE, AND FOUNDING IS THE REASON (D25). A proposal with an episode RIDES it:
  -- provisional, visible to checks through the scope helper (3.3). A proposal without one
  -- rides nothing — the Grey Harbor sheets being founded (E2-4), a premise pitched before
  -- an episode exists (5.7), an import raising a sheet from the Dead Light archive (E7).
  -- Neither needs a run and neither needs a gate to be ruled.
  episode_id  TEXT REFERENCES episode(id) ON DELETE RESTRICT,

  -- Who raised it (1.2's fifth part, first half). The disposition is the other half and
  -- lives on the ledger above.
  raised_by   TEXT NOT NULL,

  -- The passage that made the change necessary — the two lines either side the gate room
  -- renders under "Usage context". '' when nothing quoted it.
  usage_context TEXT NOT NULL DEFAULT '',

  -- The promotion's identity part: the sheet's standing, aliases and prose body. NULL means
  -- "the change does not touch it", which is exactly what `amendEntity` does with a field
  -- left out — so a promotion that only flips a candidate active cannot blank its prose.
  -- On the other two kinds these stay NULL, refused in the module rather than by a CHECK
  -- that a fourth kind would have to rebuild the table to widen.
  standing    TEXT,
  aliases     TEXT,
  body        TEXT,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX proposal_by_entity ON proposal (entity_id);
-- The gate room's "proposals riding this episode", and the check scope question behind it.
CREATE INDEX proposal_riding ON proposal (episode_id) WHERE episode_id IS NOT NULL;

-- ── The change, in parts ────────────────────────────────────────────────────────
--
-- One set of part tables for all three kinds, because a promotion IS a fact delta and a
-- relation delta and a sheet, raised together: "the entity's full initial sheet — identity,
-- standing, prose, facts, relations, references". Ratification then walks the same three
-- tables whatever the kind, and the kind decides only whether the candidate flips active.

-- A fact the proposal would write. `supersedes` is the "before" of the gate room's
-- before → after; NULL adds rather than replaces.
CREATE TABLE proposal_fact (
  proposal_id  TEXT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  field        TEXT,
  statement    TEXT NOT NULL,

  -- The ratified fact this would close. RESTRICT: a fact a proposal is arguing about is not
  -- something anything else may take away underneath it.
  supersedes   TEXT REFERENCES fact(id) ON DELETE RESTRICT,

  -- The inherited fact this one displaces — an individual exception (D22 addendum). It can
  -- only be written once the edge it is inherited across exists, which is why ratification
  -- writes relations before facts and why a part carrying one rides nothing.
  overrides    TEXT REFERENCES fact(id) ON DELETE RESTRICT,

  -- The PROVISIONAL row written when the proposal rides an episode — what makes the claim
  -- visible to checks (3.3) and what a ruling closes: superseded by the canon fact on a
  -- ratification, closed with no successor on a rejection or a deferral. NULL when the
  -- proposal rides nothing, and there was never a claim to put down.
  fact_id      TEXT REFERENCES fact(id) ON DELETE RESTRICT,

  PRIMARY KEY (proposal_id, ordinal),
  CHECK (statement <> ''),
  CHECK (field IS NULL OR field <> '')
);

-- An edge the proposal would write or withdraw. Replacing one — resolving a declared
-- `unknown` into a real species — is a `remove` and an `add`, in that ordinal order.
CREATE TABLE proposal_relation (
  proposal_id    TEXT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,

  op             TEXT NOT NULL CHECK (op IN ('add', 'remove')),

  -- The edge in words, on both ops: the declared type (D23) and the far end of it. On an
  -- `add` this is what the ratification writes; on a `remove` it is what it withdrew, and
  -- the module fills it in from the named edge so the record survives the withdrawal.
  --
  -- NULL at the far end IS THE DECLARED `unknown` (D22) — the same ruling
  -- `relation.to_entity_id` makes, so the proposal and the edge it becomes spell the one
  -- legal non-entity target the same way, and no sentinel exists to be remembered.
  type_name      TEXT NOT NULL DEFAULT '',
  to_entity_id   TEXT REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- For a `remove`: which edge.
  --
  -- ON DELETE SET NULL, and it is the one place in this schema where that is the right
  -- answer. RESTRICT is what `supersedes` uses, because a fact is never deleted — but
  -- withdrawing an edge IS a deletion (`relation` has no closure row), and it is the very
  -- act this column exists to authorise. Under RESTRICT the ratification of a
  -- relation-delta aborts on the foreign key of the proposal that ordered it, which is a
  -- circle a test found rather than a reader. So the reference goes when the edge does,
  -- and the two columns above are what keep the record readable: "withdrew `species` →
  -- Halvani" still renders in the gate room after the edge is gone.
  relation_id    TEXT REFERENCES relation(id) ON DELETE SET NULL,

  PRIMARY KEY (proposal_id, ordinal)
);

-- A face to match, a voice to match, a board to shoot toward — the sheet's references,
-- written onto the entity at ratification (3.1).
CREATE TABLE proposal_reference (
  proposal_id  TEXT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  stance       TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (proposal_id, ordinal)
);

-- The fourth part (1.2): what else could have been done, so the ruling is a choice rather
-- than a yes/no. A table rather than a blob for the reason `category_field` is one — the
-- gate room renders them as a list, and a list is rows.
CREATE TABLE proposal_alternative (
  proposal_id  TEXT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  alternative  TEXT NOT NULL,
  PRIMARY KEY (proposal_id, ordinal),
  CHECK (alternative <> '')
);

-- ── A ruled proposal is history ─────────────────────────────────────────────────
--
-- The same rule `gate_ruling` states in 0004 and `canon_ruling` holds in 0007, one level
-- out: once Ryan has disposed of a proposal, what he ruled ON may not move underneath the
-- record of it. An UNRULED proposal is still a draft — it may be withdrawn, and the parts
-- cascade with it — so the triggers ask the ledger rather than refusing everything.
CREATE TRIGGER proposal_ruled_is_history_update BEFORE UPDATE ON proposal
  WHEN EXISTS (SELECT 1 FROM canon_ruling WHERE proposal_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'this proposal has been ruled — a later opinion is a new proposal, never an edit'); END;

CREATE TRIGGER proposal_ruled_is_history_delete BEFORE DELETE ON proposal
  WHEN EXISTS (SELECT 1 FROM canon_ruling WHERE proposal_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'this proposal has been ruled — the disposition is kept forever (3.3)'); END;

-- ── The ledger, grown (0007's ADD COLUMN, as promised there) ────────────────────
--
-- SQLite ADD COLUMN takes a REFERENCES clause as long as the default is NULL, which is what
-- these want anyway: E2-1's ratifications and E2-3's reverts dispose of no proposal and are
-- convened at no gate.
ALTER TABLE canon_ruling ADD COLUMN proposal_id TEXT REFERENCES proposal(id) ON DELETE RESTRICT;

-- Which gate the ruling was convened at, when one was (3.3). NULL is not a gap: the canon
-- bench (E2-6) and the founding flow (E2-4) rule from the queue, and a gate CONVENES a
-- ruling without ever being a precondition for one.
ALTER TABLE canon_ruling ADD COLUMN gate_id TEXT REFERENCES gate(id) ON DELETE RESTRICT;

-- Ryan's words, kept forever — a rejection's note especially, because E4's writer context
-- reads it back ("why Trent stays mortal"). '' is the empty note, never a missing one.
ALTER TABLE canon_ruling ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- A proposal is ruled ONCE, and that is a constraint rather than a judgement call — the
-- `fact_closure` primary key precedent. Ratifying twice would write canon twice; a later
-- opinion is a NEW proposal citing the old one's note, which is how a deferred change comes
-- back (E2-3). Partial, so the ledger's own rulings — every ratification E2-1 records and
-- every revert E2-3 will — are untouched and unlimited.
CREATE UNIQUE INDEX canon_ruling_one_per_proposal
  ON canon_ruling (proposal_id) WHERE proposal_id IS NOT NULL;

-- AMENDING 0007's header, which said `fact.ratified_by` and `fact_closure.closed_by` point
-- only at rulings that write canon. Half of that stands and half of it grows: `ratified_by`
-- is still ratification-only, enforced in `establishFact`. A CLOSURE now legitimately points
-- at a `rejection` or a `deferral` — putting down a provisional fact that was only ever
-- riding an episode is exactly what those two do, and the closure's ruling is where the
-- reason lives. The new kinds are TypeScript-union-only, as 0007 designed: `canon_ruling.kind`
-- carries no CHECK precisely so adding one stays an edit rather than a table rebuild.
