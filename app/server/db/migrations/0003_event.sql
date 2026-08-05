-- 0003 · the event log (E1-5)
--
-- The fourth primitive (2.2): the append-only log of every transition, which drives the
-- live UI over SSE and is the audit trail.
--
-- WHAT THIS TABLE IS NOT: the state. `run`, `step`, and `resource_lock` are the source of
-- truth, and they stay that way. Nothing rebuilds a run by replaying these rows, and the
-- runner never reads its own state back out of here — if it did, crash-resume would
-- answer to two masters and the honest one (the ledger) would eventually lose. This is
-- the RECORD of transitions that happened elsewhere. If a future change proposes deriving
-- run status from this table, that is event sourcing, nobody asked for it, and the answer
-- is no.
--
-- One table. There is deliberately no `topic`, no `subscription`, no `event_type`
-- definition table, and no way to describe a new kind of event in data — the kinds are a
-- fixed list below and a matching TypeScript union in app/server/events.ts, and adding one
-- is a code change with a test (the Archon rule).

CREATE TABLE event (
  -- The order, and the only thing that may be trusted for it. `at` has millisecond
  -- resolution and two events land inside one millisecond routinely — a stream ordered by
  -- timestamp is a stream that reorders itself intermittently. AUTOINCREMENT settles it,
  -- and this is also the SSE `id:` a reconnecting browser resumes from.
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,

  kind        TEXT NOT NULL CHECK (kind IN (
                -- run transitions
                'run-queued', 'run-started', 'run-paused', 'run-resumed',
                'run-done', 'run-failed', 'run-reclaimed',
                -- step transitions. 'step-attempt-failed' is one attempt dying with retry
                -- budget left; 'step-failed' is the budget spent and the step reaching
                -- Ryan. Different sentences on the floor, so different kinds.
                'step-started', 'step-done', 'step-attempt-failed', 'step-failed', 'step-paused',
                -- lock transitions (D7, D20). 'lock-waiting' carries WHO holds it.
                'lock-waiting', 'lock-acquired', 'lock-released',
                -- the two stream kinds, emitted from inside a step rather than by the
                -- runner. Kept distinct from the transitions above so a replay can ask for
                -- the transitions alone (what the floor renders) without filtering prose.
                'step-progress', 'step-chunk'
              )),

  -- Every event so far belongs to a run, and a run belongs to an episode. episode_id is
  -- denormalized off the run on purpose: the episode room filters its own stream without
  -- a join, on the hot path, for every chunk.
  --
  -- ON DELETE RESTRICT, and read the next paragraph before changing it.
  run_id      TEXT NOT NULL REFERENCES run(id)     ON DELETE RESTRICT,
  step_id     TEXT          REFERENCES step(id)    ON DELETE RESTRICT,  -- NULL before a step exists
  episode_id  TEXT NOT NULL REFERENCES episode(id) ON DELETE RESTRICT,

  -- THE CASCADE ABOVE THIS TABLE IS NOW UNREACHABLE. `run.episode_id` is declared
  -- ON DELETE CASCADE (0002) and `episode.season_id` before it (0001), but these RESTRICTs
  -- outrank them: deleting an episode that has history aborts at `event`, so the cascade
  -- on `run` never fires and never will while any run has been recorded. Do not read those
  -- CASCADEs as "deleting an episode cleans up its runs" — it does not, it fails, and the
  -- error names `event` rather than the episode, which is confusing exactly once.
  --
  -- That is the intent, not an accident. An abandoned episode has its facts reverted by
  -- ruling (3.3), never removed; facts are append-only with validity ranges (D9); tests
  -- throw away whole database files. If deleting an episode ever becomes a real feature,
  -- RESTRICT forces whoever builds it to decide what happens to the history instead of
  -- silently shredding it.

  summary     TEXT,   -- machine-written sentence: "waiting on GPU (held by ep05)". NOT a
                      -- note — `note` is Ryan's authored, work-routing text (4.7, D21).
  detail      TEXT,   -- JSON; the structure E5 renders from
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- for humans
);

-- Everything about run X in order, and the SSE resume scan. Ordering is the hot path;
-- there is no index on `kind` because nothing asks "every lock-waiting ever".
CREATE INDEX event_by_run ON event (run_id, seq);

-- Append-only, enforced by the database rather than by anyone's discipline. The module in
-- app/server/events.ts has no update path and no delete path; these make that true of the
-- SQLite file itself, including for a migration, an import, or a hand-typed statement.
CREATE TRIGGER event_is_append_only_update BEFORE UPDATE ON event
  BEGIN SELECT RAISE(ABORT, 'the event log is append-only — this is the audit trail'); END;

CREATE TRIGGER event_is_append_only_delete BEFORE DELETE ON event
  BEGIN SELECT RAISE(ABORT, 'the event log is append-only — this is the audit trail'); END;
