-- 0005 · the cost ledger (E1-6)
--
-- 2.4: every LLM call and generation records tokens/dollars against step, run, episode,
-- and show, and every show carries a budget the spend is measured against.
--
-- THE LEDGER IS NOT LLM-ONLY. D20 puts image generation on three backends whose calls
-- cost dollars and produce NO TOKENS, and E6 adds TTS on the same footing. So a row
-- records dollars ALWAYS and tokens OPTIONALLY, with the medium, backend, and model
-- named. E6 writes image and audio rows into this same table, and rolls them up with the
-- same queries, without a migration — that is why `kind` already accepts all three.
--
-- WHAT THIS TABLE IS NOT: a billing system, a quota enforcer, or a rate limiter. Nothing
-- reads it to decide whether a call may proceed. It is the record of what was spent, and
-- the budget below is a number Ryan set to measure that record against — the screen says
-- "$37.60 left of this week's $50.00" and Ryan decides what to do about it (invariant 5:
-- nothing runs without a click, and nothing stops without one either).

CREATE TABLE cost_entry (
  -- Insertion order. `at` has millisecond resolution and a fan-out of image calls lands
  -- several inside one millisecond; AUTOINCREMENT is the only order that is true.
  seq                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What kind of work cost this. All three are legal from today so E6 needs no migration:
  --   llm    an LLMAdapter call (D6) — tokens and dollars
  --   image  an ImageAdapter call (D20) — dollars, no tokens
  --   audio  a TTS take (E6) — dollars, no tokens
  -- A small closed set that D20 already ruled, so a CHECK is right here. (`event.kind` had
  -- to become a lookup table in 0004 because that table grows once per streamed chunk and
  -- SQLite cannot ALTER a CHECK; this one grows once per model call. If a fourth medium
  -- ever appears, copy 0004's pattern rather than rewriting this table in place.)
  kind                   TEXT NOT NULL CHECK (kind IN ('llm','image','audio')),

  -- The ruled backend ids, kebab-case: 'anthropic-api' and 'claude-cli' (D6);
  -- 'nano-banana-pro', 'z-image-turbo', 'qwen-image-edit' (D20); E6's TTS backend is not
  -- ruled yet, which is exactly why there is no CHECK here — a CHECK would make naming it
  -- a migration. The TypeScript union in app/server/llm/adapter.ts constrains the two
  -- that exist now.
  backend                TEXT NOT NULL,
  model                  TEXT NOT NULL,               -- 'claude-opus-5', 'gemini-3-pro-image'

  -- 'failed' is a call that cost money and produced nothing usable — a stream that died
  -- after the prompt was billed, an image the backend charged for and then errored on.
  -- The retry budget (invariant 5) means one step can produce three of these, and a
  -- ledger that only recorded successes would quietly under-report every retry storm.
  outcome                TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','failed')),

  -- MONEY IS AN INTEGER. Whole micro-dollars ($0.000001), never a float: REAL sums drift
  -- by fractions of a cent per thousand rows, and the one number in this app that must
  -- reconcile against a real invoice is this one. Divide by 1e6 when rendering, nowhere else.
  micro_dollars          INTEGER NOT NULL CHECK (micro_dollars >= 0),

  -- HOW that number was arrived at, because "0" and "we could not say" must never look
  -- alike in a rollup:
  --   rate-card  computed from the tokens beside it and the dated price table in cost.ts
  --   reported   the backend stated the dollars itself (the `claude` CLI does)
  --   unpriced   nobody could say. micro_dollars is 0 and that 0 is a GAP, not a fact —
  --              rollups count these separately so a total can say it is a floor.
  priced                 TEXT NOT NULL CHECK (priced IN ('rate-card','reported','unpriced')),

  -- The four token counts, all NULL for a call that produces none (image, TTS).
  --
  -- READ THIS BEFORE TOUCHING THE ARITHMETIC. The API's `usage.input_tokens` is NOT the
  -- size of the prompt — it is the UNCACHED REMAINDER of it, which is why the column is
  -- named for what it holds rather than for the field it came from. The prompt was
  --     uncached_input_tokens + cache_write_tokens + cache_read_tokens
  -- and those three bill at DIFFERENT rates (write ~1.25x base, read ~0.1x base). A
  -- ledger that multiplies one field by one rate under-reports every cached call and
  -- drifts from the invoice silently, because nothing in the response complains.
  uncached_input_tokens  INTEGER,                     -- API: usage.input_tokens
  cache_write_tokens     INTEGER,                     -- API: usage.cache_creation_input_tokens
  cache_read_tokens      INTEGER,                     -- API: usage.cache_read_input_tokens
  output_tokens          INTEGER,                     -- API: usage.output_tokens (thinking included)

  -- The four levels 2.4 asks for. show_id is the only one that is NOT NULL: the budget is
  -- per show, so a call nobody can attribute to a show cannot be measured against
  -- anything. The other three are denormalized off the run rather than joined for, and
  -- they cannot drift because recordCost derives them itself from the run — there is one
  -- write path and it is the only place these are set.
  --
  -- ON DELETE RESTRICT throughout, for the same reason the event log uses it: this is a
  -- financial record. Deleting an episode with spend against it fails at this table
  -- rather than shredding the history, which forces whoever wants that feature to decide
  -- what happens to the money instead of discovering it is gone.
  show_id                TEXT NOT NULL REFERENCES show(id)    ON DELETE RESTRICT,
  episode_id             TEXT          REFERENCES episode(id) ON DELETE RESTRICT,
  run_id                 TEXT          REFERENCES run(id)     ON DELETE RESTRICT,
  step_id                TEXT          REFERENCES step(id)    ON DELETE RESTRICT,
  attempt                INTEGER,                     -- which try spent this, 1-based

  at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The budget query: this show's spend since Monday. It is the hot one — the floor renders
-- it on every load — and it is the only query that scans by time.
CREATE INDEX cost_entry_by_show ON cost_entry (show_id, at);

-- The three narrower rollups. Each is a plain SUM over one indexed column.
CREATE INDEX cost_entry_by_episode ON cost_entry (episode_id);
CREATE INDEX cost_entry_by_run ON cost_entry (run_id);
CREATE INDEX cost_entry_by_step ON cost_entry (step_id);

-- Append-only, enforced by the database rather than by anyone's discipline — the same
-- stance 0003 takes for the event log, and for a stronger reason: a spend record you can
-- edit is not a record of spend. app/server/cost.ts has no update path and no delete
-- path; these make that true of the SQLite file itself, including for a later migration,
-- an import, or a hand-typed statement. A correction is a new row, not an edit.
CREATE TRIGGER cost_entry_is_append_only_update BEFORE UPDATE ON cost_entry
  BEGIN SELECT RAISE(ABORT, 'the cost ledger is append-only — correct it with another row'); END;

CREATE TRIGGER cost_entry_is_append_only_delete BEFORE DELETE ON cost_entry
  BEGIN SELECT RAISE(ABORT, 'the cost ledger is append-only — this is what the money did'); END;

-- What Ryan said this show may spend in a week. One row per show, editable — unlike the
-- ledger above, this is a setting rather than a record, and changing it is not rewriting
-- history. A show with no row here has no budget: the screen says what was spent and
-- offers no bar to fill, which is honest rather than a silent zero.
CREATE TABLE show_budget (
  show_id               TEXT PRIMARY KEY REFERENCES show(id) ON DELETE CASCADE,
  weekly_micro_dollars  INTEGER NOT NULL CHECK (weekly_micro_dollars >= 0),
  set_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
