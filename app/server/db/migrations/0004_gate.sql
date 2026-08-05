-- 0004 · the gate primitive (E1-4)
--
-- A gate is the third primitive (2.2): a run paused on a decision object, resuming only on
-- Ryan's ruling. Four tables here, plus one rebuild of `event` that this migration does
-- once so that no migration ever has to do it again.
--
-- WHAT THIS IS NOT: an approval workflow. There is no `approver`, no `policy`, no
-- `required_signoff`, no routing engine — Ryan rules every gate, the three verbs are
-- approve / reject / override, and nothing in this schema can be configured to change
-- that. Rejection routing (4.7, D21) is carried as DATA on a note, not executed here:
-- E1 records the depth a note targets, and E4/E6's freshness graph is what acts on it.


-- ── Part 1 · the event kinds become a table ─────────────────────────────────────
--
-- 0003 declared the seventeen kinds as a CHECK constraint. Four gate kinds have to join
-- them, and SQLite cannot ALTER a CHECK — the only way to widen one is to rebuild the
-- table. Doing that once is fine. Doing it every time an epic adds a kind is a standing
-- tax paid on the fastest-growing table in the database: `event` persists every streamed
-- chunk (2.3), so by E7 adding one string to a list would mean copying millions of rows.
--
-- So the CHECK becomes a foreign key to a lookup table, and this is the last rebuild.
-- After this, E2's proposal kinds, E3's finding kinds and E6's media kinds each cost one
-- INSERT, at any table size. Everything the CHECK bought survives: an unknown kind still
-- fails at the database rather than only in TypeScript, and `events.test.ts` still proves
-- the two lists agree — it reads `event_kind` instead of parsing SQL.
--
-- This is NOT a definition table for describing new kinds in data (the Archon rule). A
-- kind is a row here AND a member of EVENT_KIND in app/server/events.ts AND a sentence
-- something renders; the row is the database's half of a code change, not a config seam.
CREATE TABLE event_kind (
  kind TEXT PRIMARY KEY
);

INSERT INTO event_kind (kind) VALUES
  -- the seventeen carried over verbatim from 0003
  ('run-queued'), ('run-started'), ('run-paused'), ('run-resumed'),
  ('run-done'), ('run-failed'), ('run-reclaimed'),
  ('step-started'), ('step-done'), ('step-attempt-failed'), ('step-failed'), ('step-paused'),
  ('lock-waiting'), ('lock-acquired'), ('lock-released'),
  ('step-progress'), ('step-chunk'),
  -- and the gate's four. Four, not one: "the ep06 script gate is open" and "approved the
  -- ep06 script as an explicit override" are different sentences on the floor, for the
  -- same reason 'step-attempt-failed' and 'step-failed' were split rather than folded.
  -- An override is an approval OVER something (invariant 3), and a log that cannot tell
  -- it from a plain approval has lost the only record that it happened.
  ('gate-opened'), ('gate-approved'), ('gate-rejected'), ('gate-overridden');

-- The rebuild. Column for column identical to 0003 except `kind`, which trades its CHECK
-- for the reference above.
--
-- READ THIS BEFORE THE `DROP TABLE` BELOW LOOKS LIKE A LIE: `event` carries two triggers
-- that abort every UPDATE and every DELETE, and they are not decorative. DROP TABLE does
-- an implicit row removal that does NOT fire row triggers — that is why this rebuild is
-- legal, and it is the only reason it is. Nothing here can edit or remove an event: the
-- rows are copied verbatim, `seq` and `at` included, and the triggers are recreated below
-- against the new table. A migration that tried to change a row rather than move it would
-- still be stopped by them.
--
-- Foreign keys stay ON throughout (the migration runner wraps each file in a transaction,
-- and PRAGMA foreign_keys is a no-op inside one, so they could not be turned off even if
-- that were wanted). It is safe: nothing in the schema references `event`, so dropping it
-- violates nothing, and its own outbound references to run/step/episode are recreated
-- unchanged. `migrate.test.ts` proves the whole thing preserves rows, `seq`, and triggers.
CREATE TABLE event_rebuilt (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL REFERENCES event_kind(kind),
  run_id      TEXT NOT NULL REFERENCES run(id)     ON DELETE RESTRICT,
  step_id     TEXT          REFERENCES step(id)    ON DELETE RESTRICT,
  episode_id  TEXT NOT NULL REFERENCES episode(id) ON DELETE RESTRICT,
  summary     TEXT,
  detail      TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Explicit `seq`, so the audit trail keeps the numbers a browser has already seen as SSE
-- ids. AUTOINCREMENT then continues above the highest copied value rather than restarting
-- at 1, because sqlite_sequence records the maximum inserted and follows the rename.
INSERT INTO event_rebuilt (seq, kind, run_id, step_id, episode_id, summary, detail, at)
  SELECT seq, kind, run_id, step_id, episode_id, summary, detail, at FROM event ORDER BY seq;

DROP TABLE event;
ALTER TABLE event_rebuilt RENAME TO event;

CREATE INDEX event_by_run ON event (run_id, seq);

CREATE TRIGGER event_is_append_only_update BEFORE UPDATE ON event
  BEGIN SELECT RAISE(ABORT, 'the event log is append-only — this is the audit trail'); END;

CREATE TRIGGER event_is_append_only_delete BEFORE DELETE ON event
  BEGIN SELECT RAISE(ABORT, 'the event log is append-only — this is the audit trail'); END;


-- ── Part 2 · the gate ───────────────────────────────────────────────────────────
--
-- One gate per step, and the step is the PRODUCING step — the one that wrote the artifact
-- and then presented it. That is what makes "reject reopens the producing step with the
-- notes as input" a consequence of the existing runner rather than new machinery: a
-- rejection resumes the run, the runner re-enters the step that paused, and the step
-- finds its own gate waiting with Ryan's notes on it.
--
-- `artifact_id` is NOT NULL because a gate always renders its artifact, never a filename
-- (1.3, and the gate room's whole left column). A decision object with nothing to look at
-- is not a gate.
--
-- `seq` is the order gates opened in, and it exists for the reason `run.seq` and
-- `event.seq` do: `opened_at` has millisecond resolution, two gates opening inside one
-- millisecond is ordinary, and "the oldest thing waiting on Ryan" has to be a stable
-- answer or the floor's "needs you" list reshuffles itself between refreshes.
-- AUTOINCREMENT settles it; `id` stays the handle everything else references.
CREATE TABLE gate (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  run_id       TEXT NOT NULL REFERENCES run(id)      ON DELETE CASCADE,
  -- UNIQUE: rounds live under one gate. See the module header in runner/gate.ts for why
  -- this depends on `reconcileSteps` matching step rows by name.
  step_id      TEXT NOT NULL UNIQUE REFERENCES step(id) ON DELETE CASCADE,
  episode_id   TEXT NOT NULL REFERENCES episode(id)  ON DELETE CASCADE,
  artifact_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE RESTRICT,
  opened_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The floor's "needs you" list is every gate with an unruled round, which reads off this.
CREATE INDEX gate_by_run ON gate (run_id);

-- One presentation of the artifact for a ruling. Round 2 is the re-presentation after a
-- rejection: same gate, same artifact, a later version of it.
--
-- There is deliberately no `status` and no `stale` column. A round is OPEN when no ruling
-- row references it, and STALE when a later round exists — both are one query, and a
-- stored copy of either is a second answer waiting to disagree with the first (the same
-- reason artifact freshness is computed, 1.3).
CREATE TABLE gate_round (
  gate_id           TEXT NOT NULL REFERENCES gate(id) ON DELETE CASCADE,
  round             INTEGER NOT NULL CHECK (round >= 1),
  artifact_version  INTEGER NOT NULL CHECK (artifact_version >= 1),
  payload           TEXT,     -- JSON; what the gate room renders beside the artifact
  opened_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (gate_id, round)
);

-- Ryan's verdict, and the only thing that closes a round.
--
-- INSERT-ONLY, and the primary key is what makes it so: a second ruling on a round that
-- already has one is a constraint violation, not a policy someone remembered to write.
-- Round 2 never overwrites round 1 — it is a different row, and round 1 stays exactly as
-- it was ruled, which is what the gate room renders under "stale — from before your last
-- rejection".
--
-- Note the asymmetry with `gate_round`, which the app DOES update: an unruled round is a
-- presentation, and a step that re-runs after a crash and produces a newer version is
-- presenting that newer version — refreshing it keeps the screen honest. A RULED round is
-- history, and history does not move.
--
-- 'override' is 'approve' over something the checks argued (invariant 3). The something
-- arrives in E3; the verb is distinct here from the start, because retrofitting the
-- distinction would mean every override recorded before E3 is indistinguishable forever.
CREATE TABLE gate_ruling (
  gate_id   TEXT NOT NULL,
  round     INTEGER NOT NULL,
  verdict   TEXT NOT NULL CHECK (verdict IN ('approve', 'reject', 'override')),
  comment   TEXT,     -- Ryan's optional words on an approval or an override
  ruled_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (gate_id, round),
  FOREIGN KEY (gate_id, round) REFERENCES gate_round(gate_id, round) ON DELETE CASCADE
);

-- No UPDATE, ever. There is deliberately no matching DELETE trigger: nothing may EDIT a
-- ruling, but a gate must still be able to cascade away with its run if a future feature
-- ever deletes one — and the ruling's own record in `event` is what cannot be deleted,
-- guarded there by triggers that outrank every cascade in the schema.
CREATE TRIGGER gate_ruling_is_history BEFORE UPDATE ON gate_ruling
  BEGIN SELECT RAISE(ABORT, 'a ruling is history — a new opinion is a new round, never an edit'); END;

-- A rejection is not one string (4.7, sharpened by D21). It is a list of notes, each
-- optionally targeting a DEPTH: the artifact under review, a scene, a shot, a take, or the
-- premise. E1 records the routing and acts on none of it — the freshness graph that
-- regenerates only what must is E4/E6 — but the payload carries it from the first row
-- written, because adding it later is a schema change against real rejections.
--
-- `depth` NULL is the legal default: one unrouted note, "reject with notes" at its
-- simplest. `target` names WHICH scene/shot/take when the depth names one; it is plain
-- TEXT with no foreign key because `scene` exists today and shot and take do not until
-- E6, and a note about a shot is not worth blocking on a table that isn't written yet.
-- The CHECK keeps the pair honest in the meantime: nothing may target without a depth.
--
-- The five depths are a CHECK rather than a lookup table like `event_kind` above: they
-- are a closed set ruled in 4.7 and D21, not a list every epic appends to.
CREATE TABLE gate_note (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,   -- the order Ryan wrote them in
  gate_id  TEXT NOT NULL,
  round    INTEGER NOT NULL,
  note     TEXT NOT NULL,
  depth    TEXT CHECK (depth IN ('artifact', 'scene', 'shot', 'take', 'premise')),
  target   TEXT,
  CHECK (depth IS NOT NULL OR target IS NULL),
  FOREIGN KEY (gate_id, round) REFERENCES gate_ruling(gate_id, round) ON DELETE CASCADE
);

CREATE INDEX gate_note_by_round ON gate_note (gate_id, round, seq);
