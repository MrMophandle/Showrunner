-- 0014 · a routed note names its target, and the version it stood at (E4-5)
--
-- D21 has been carried as DATA on a note since 0004 and acted on by nobody: "E1 records the
-- routing and acts on none of it — the freshness graph that regenerates only what must is
-- E4/E6". E4-5 is where the writing line acts on it, and two things about `gate_note` had to
-- give first. Both are on one table, both are the smallest change that makes the routing
-- answerable, and neither is a status.
--
-- ── One · the closed set had no word for the OUTLINE ────────────────────────────
--
-- 4.7 named the depths from the screening room, where the artifacts are the premise, the
-- scene, the image and the take; 0004 wrote that list down as a CHECK and said why it is a
-- CHECK rather than a lookup table like `event_kind` — "they are a closed set ruled in 4.7 and
-- D21, not a list every epic appends to". That reasoning stands, and this is not an epic
-- appending to it: it is the writing line arriving with an artifact 4.7 did not have.
--
-- E4-2 (#62) made the OUTLINE a real artifact between the premise and the script. A rejection
-- at the script gate has exactly three honest depths — this draft, the outline, the premise —
-- and until this migration the middle one could not be said. A note routed at `premise` depth
-- when Ryan meant the outline is a note pointing at the wrong artifact, kept forever, on a
-- record whose whole job is to say where he sent the work back to. So `outline` joins the set,
-- and the set is closed again: `artifact` (the draft under review), `scene`, `outline`,
-- `premise`, `shot`, `take`. Nothing else, and the next one is a ruling, not an ALTER.
--
-- SQLite cannot widen a CHECK, so the table is rebuilt — the same move 0004 made on `event`
-- and for the same reason, at a size where it costs nothing: `gate_note` holds one row per
-- note Ryan has ever written and nothing references it.
--
-- ── Two · `target_version`, so "addressed" stays a computation ──────────────────
--
-- A routed note reopens its TARGET's offer: a stage whose artifact has a note standing against
-- it that nobody has answered becomes offerable again, with the note in the sentence
-- (`domain/routing.ts`). "Answered" has to be derived, because a flag on a note is a second
-- answer waiting to disagree with the first — the same ruling artifact freshness (1.3), finding
-- status (0010) and gate-round staleness (0004) are all built on.
--
-- The derivation is one comparison: **a routed note is addressed when a NEWER VERSION of its
-- target exists than the one standing when the note landed.** That needs the version standing
-- when the note landed, and nothing in the schema records it — `gate_round.artifact_version` is
-- the version of the artifact the GATE was over, which for a routed note is a different
-- artifact. Timestamps cannot stand in: `at` is for humans (CLAUDE.md), the ledger is ordered by
-- monotonic sequences precisely because two writes inside one millisecond are ordinary, and a
-- rejection followed immediately by an edit is exactly that case.
--
-- So the note carries it. NULL means the note names no artifact — an unrouted note, or one
-- routed to a scene, or one Ryan routed to a kind this episode does not have yet, which is
-- legal: nothing may block a ruling (`runner/gate.ts`), so a route that lands nowhere is
-- recorded rather than refused.
--
-- `target` keeps its column and widens its meaning by one word: it named WHICH scene/shot/take
-- when the depth named one, and now names WHICH ARTIFACT when the depth names a written kind.
-- Still plain TEXT with no foreign key, for 0004's reason — shot and take have no tables until
-- E6 — and the pair rule is unchanged: nothing may target without a depth.
--
-- ── What this deliberately does not do ──────────────────────────────────────────
--
-- No `addressed`, no `answered_at`, no `status`. No second table for routed notes either: a
-- routed note is a `gate_note` with an address on it, read by the same reader that already
-- composes rejections onto the writer's desk (`domain/write-context.ts`), which is what keeps
-- "one record, many readers" true of Ryan's words as well as of the checks'.
--
-- And no trigger. `gate_note` has never had one — a note is written once by `createRulings`
-- inside the ruling's own transaction, and 0004's immutability lives on `gate_ruling`, which is
-- the row that says the note happened. Nothing here re-opens 0013's tripwire, because there is
-- no WHEN clause to keep in step with a column list.

CREATE TABLE gate_note_rebuilt (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,   -- the order Ryan wrote them in
  gate_id         TEXT NOT NULL,
  round           INTEGER NOT NULL,
  note            TEXT NOT NULL,
  depth           TEXT CHECK (depth IN ('artifact', 'scene', 'outline', 'premise', 'shot', 'take')),
  target          TEXT,
  -- The version the target stood at when the note landed. NULL when the note names no
  -- artifact. See the header: this is what makes "addressed" a comparison and never a flag.
  target_version  INTEGER CHECK (target_version IS NULL OR target_version >= 1),
  CHECK (depth IS NOT NULL OR target IS NULL),
  CHECK (target IS NOT NULL OR target_version IS NULL),
  FOREIGN KEY (gate_id, round) REFERENCES gate_ruling(gate_id, round) ON DELETE CASCADE
);

-- Explicit `seq`, so a note keeps the order it was written in and AUTOINCREMENT continues
-- above the highest copied value rather than restarting at 1 (0004's rebuild, same move).
INSERT INTO gate_note_rebuilt (seq, gate_id, round, note, depth, target)
  SELECT seq, gate_id, round, note, depth, target FROM gate_note ORDER BY seq;

DROP TABLE gate_note;
ALTER TABLE gate_note_rebuilt RENAME TO gate_note;

CREATE INDEX gate_note_by_round ON gate_note (gate_id, round, seq);

-- What the routed half is read by: every note addressed to one artifact, whichever gate it was
-- written at. The offer asks this per artifact on every page load (`domain/routing.ts`).
CREATE INDEX gate_note_by_target ON gate_note (target);
