-- 0009 · what episodes do to canon (E2-3)
--
-- The three flows that connect episode life to canon — the completion sweep, abandonment's
-- reverts, and the waypoint landing (1.2, 3.3, D8) — need exactly two things from the
-- schema. Everything else they do is a proposal, and 0008 already built that table.
--
-- WHAT THIS DOES NOT DO, and it is the larger half of the design:
--
--   * NO `revert` KIND ANYWHERE IN SQL. `proposal.kind` and `canon_ruling.kind` both carry
--     no CHECK, on purpose and stated in both headers ("the closed set is the TypeScript
--     union"), so E2-3's two new proposal kinds — `revert` and `landing` — are a widened
--     union in domain/proposal.ts with a test, not a table rebuild. That is the whole
--     reason 0007 and 0008 refused the CHECK, and this is the migration that collects on
--     it. Compare `event_kind` in 0004, which IS a lookup table and DOES take a row per
--     kind: an event kind is joined against, a proposal kind is only ever read back.
--
--   * NO SECOND LEDGER. A revert is disposed of on `canon_ruling` like everything else.
--
--   * NO `abandoned` LIFECYCLE. See below.

-- ── Abandonment is a column, not a stage ────────────────────────────────────────
--
-- An episode dies at ANY stage — a premise that never earned an outline, a script whose
-- B-story never landed, an assembled cut Ryan will not publish — so abandonment is
-- ORTHOGONAL to the lifecycle it was at when it died. Widening 0001's
-- CHECK (lifecycle IN (...)) to admit 'abandoned' would have said the opposite: that dying
-- is a place in the order after `published`, and that the stage an episode reached is
-- forgotten the moment it is abandoned. It would also have cost a table rebuild on an
-- applied table with four foreign keys into it, to record something a column records.
--
-- NULL is alive. A timestamp is the moment Ryan put it down; the REASON is not here,
-- because it is already kept where reasons are kept — on the deferral note of every
-- proposal that was riding, and in the usage context of every revert proposal the
-- abandonment raised. A second copy is a second thing that can be wrong.
--
-- Not reversible in this schema, and deliberately: un-abandoning would have to decide what
-- happens to the reverts already ruled, and reopening canon is a new proposal under a new
-- ruling (D9). A show that wants the episode back writes a new one.
ALTER TABLE episode ADD COLUMN abandoned_at TEXT;

-- The floor's "still alive" read, and the season map's. Partial, because the abandoned ones
-- are the rare half and the query that wants them is a page nobody opens twice a day.
CREATE INDEX episode_abandoned ON episode (abandoned_at) WHERE abandoned_at IS NOT NULL;

-- ── What a landing proposal is a landing OF ─────────────────────────────────────
--
-- D8: declaring an arc position raises the landing proposal ("arc X reached waypoint Y in
-- epZ"), and ratifying it — normally at the completion sweep — makes it a fact with
-- lineage, queryable as-of. The FACT is a `proposal_fact` row like any other; this table is
-- the part that says which arc and which waypoint, so the arc page (D24) can ask "what
-- landings are open on this arc" in one query instead of parsing a sentence.
--
-- A PART TABLE, exactly like `proposal_fact` and `proposal_relation`: one more piece of the
-- change, keyed on the proposal, cascading with an unruled one. Not columns on `proposal`,
-- for the reason 0008 gave for keeping the parts out of it — three kinds share one table
-- and a column only one kind ever fills is a column four out of five rows lie about.
--
-- PRIMARY KEY on `proposal_id` alone: a proposal lands one waypoint on one arc. Landing two
-- at once is two proposals, because Ryan rules them one at a time (one artifact, one
-- ruling).
--
-- NO `declared_ordinal`. `episode_arc_position` already stores the ordinal the episode
-- declared against, and `episodesNeedingRecheck` computes drift from it; a second copy here
-- would be a second clock. What the ordinal WAS at the moment of raising is in the fact's
-- own statement, which is where a sentence Ryan ruled on belongs.
--
-- RESTRICT on both edges, not CASCADE. `proposal` refuses DELETE once ruled (0008's
-- trigger), so a CASCADE from `arc` would abort mid-cascade on the first ruled landing and
-- take the arc delete with it — a circle 0008 already found once, at `proposal_relation`.
-- RESTRICT says the true thing outright: an arc a ruling has landed on is not something you
-- delete out from under the ruling.
CREATE TABLE proposal_landing (
  proposal_id  TEXT PRIMARY KEY REFERENCES proposal(id) ON DELETE CASCADE,
  arc_id       TEXT NOT NULL REFERENCES arc(id) ON DELETE RESTRICT,
  waypoint_id  TEXT NOT NULL REFERENCES arc_waypoint(id) ON DELETE RESTRICT
);

-- The arc page's question: which landings has anyone claimed on this arc, ruled or not.
CREATE INDEX proposal_landing_by_arc ON proposal_landing (arc_id);
