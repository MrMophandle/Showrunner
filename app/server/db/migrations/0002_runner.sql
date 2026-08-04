-- 0002 · the runner (E1-3)
--
-- Run → Step → attempt, plus the named resource locks that arbitrate scarce hardware.
-- Four tables, no fifth. There is deliberately NO table describing a pipeline, a stage
-- graph, a condition, or a retry policy: stages are TypeScript functions (the Archon
-- rule), and what lives here is the LEDGER of what one run of one stage actually did.
-- If a future migration proposes a `workflow`, `stage_definition`, or `step_edge` table,
-- that is the failure mode this project exists to escape.
--
-- RESERVED FOR E1-4 / E1-5 — do not create these here, and do not take these names:
--   gate      a first-class decision object: artifact, findings, rounds, ruling (1.3)
--   finding   one reviewer's concern with anchor, severity, confidence (4.3)
--   event     the append-only log of every transition, driving SSE (2.2)
-- A step pauses its run (`step.status = 'paused'`, `run.status = 'paused'`) and E1-4
-- hangs the gate off that seam by referencing run(id) — no change to these tables.

-- One stage executing against one episode (2.2). `stage` names a TypeScript stage in
-- app/server/runner/stages.ts; it is a lookup key back into code after a restart, never
-- a definition. A run exists only because Ryan clicked something (invariant 5).
--
-- `seq` is the queue order and the reason it exists: `requested_at` has millisecond
-- resolution, two clicks can land inside one millisecond, and "the oldest queued run on
-- this episode" has to be a single row or per-episode serialization quietly stops
-- serializing. AUTOINCREMENT settles it. `id` stays the handle everything else references.
CREATE TABLE run (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  episode_id    TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','paused','done','failed')),
  pause_reason  TEXT,                             -- why it waits on Ryan, in his words
  failure       TEXT,                             -- the last attempt's error, for the floor
  requested_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at    TEXT,
  finished_at   TEXT
);

-- Per-episode serialization reads off this index: the queue for an episode is its runs in
-- request order, and at most one of them is 'running' or 'paused' at a time. A paused run
-- still holds its episode — Ryan's open gate is not a free slot.
CREATE INDEX run_by_episode ON run (episode_id, seq);

-- One unit of work inside a run. Rows are materialized from the stage's TypeScript step
-- list when the run is enqueued, and reconciled by NAME on resume — so the code is the
-- plan and these rows are the record of it. `output` is the step's JSON result, which is
-- what makes resume able to hand a completed step's output to a later one.
CREATE TABLE step (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  lock_name    TEXT CHECK (lock_name IN ('gpu','image-api')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','waiting-on-lock','running','paused','done','failed')),
  waiting_on   TEXT CHECK (waiting_on IN ('gpu','image-api')),  -- set while status = 'waiting-on-lock'
  output       TEXT,                              -- JSON; NULL until the step succeeds
  failure      TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, name)
);

-- Every attempt, kept. Bounded self-correction (2.3) means a step gets one attempt plus
-- at most two retries, and then it reaches Ryan WITH THE LOOP HISTORY — which only works
-- if the losing attempts are still here. 'abandoned' is the outcome written by crash
-- recovery for an attempt whose process died mid-flight: honest history, and it is not
-- the step's failure, so it does not spend the retry budget.
CREATE TABLE step_attempt (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id      TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','paused','abandoned')),
  failure      TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (step_id, attempt)
);

-- A named lock for a scarce resource (D7, amended by D20). A row present means held; no
-- row means free, and the PRIMARY KEY is the mutual exclusion.
--
--   gpu        local image generation AND TTS alike. They must never run concurrently:
--              on the old stack both hit Metal and concurrent runs corrupted audio
--              synthesis (the ep04 "helium gulp", 2026-07-25). Designed out here.
--   image-api  cloud image steps only. Hold no GPU, and are EXPECTED to run in parallel
--              with audio work.
--
-- held_by_run_id is not an audit nicety: contention has to surface as "waiting on GPU
-- (held by ep05)", so the holder's identity is the state, never a boolean.
CREATE TABLE resource_lock (
  name             TEXT PRIMARY KEY CHECK (name IN ('gpu','image-api')),
  held_by_run_id   TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  held_by_step_id  TEXT NOT NULL REFERENCES step(id) ON DELETE CASCADE,
  acquired_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
