-- 0010 · the finding, and the record that a check ran (E3-0)
--
-- 4.3's anatomy as tables: an ANCHOR that lands on the material, a CONCERN that can quote
-- the fact it argues with, SEVERITY AND CONFIDENCE as two columns, and the DISPOSITION Ryan
-- puts on it. Plus the thing 4.3 does not mention and D11 cannot live without — the record
-- that a check RAN, written whether or not it found anything.
--
-- Every other E3 issue writes into these tables: the continuity board (E3-1), the generic
-- checker (E3-2), the correction loop and the D12 wall (E3-3), the panels (E3-4), the
-- remediations (E3-5), cried-wolf (E3-6). None of them should have to alter what is here.
--
-- WHAT THIS DOES NOT DO, and it is the half that matters most:
--
--   * NO `is_blocking`, NO `blocked` COLUMN, ANYWHERE. D12 — deterministic findings block
--     the NEXT STAGE and never Ryan's gate — is a COMPUTATION over open deterministic
--     findings, and E3-3 builds it. This schema MARKS the tier and enforces nothing with it.
--     A stored "blocked" is the freshness mistake (1.3) one level out: staleness is computed
--     rather than remembered so a stored answer can never go wrong, and a wall is the same
--     shape. Findings are records, never state.
--
--   * NO `status` ON `finding`. A finding is OPEN until a disposition row closes it, which
--     is `fact.status` derived from `fact_closure` exactly (0007). Two names for one thing
--     eventually disagree, and this schema has spent two triggers on that lesson already.
--
--   * NO `finding_count` ON `check_pass`. `COUNT(*) FROM finding WHERE pass_id = ?` is the
--     answer and it cannot drift from the rows it counts.
--
--   * NO `check` LOOKUP TABLE. `event_kind` (0004) is one because an event kind is a closed
--     set that gets JOINED against. A CHECK IS NOT A CLOSED SET: E3-2's checker is
--     parameterized by canon category and a category is DATA (3.2, `check_instructions` on
--     `canon_category`), so declaring one is an edit. A lookup table here would make adding
--     a category engineering again, which is the promise 3.2 and 3.5 rest on.
--
--   * NO EVENT KINDS. 0004 left the door open ("E3's finding kinds each cost one INSERT")
--     and E3-0 walks past it: the structural tier is free, deterministic, and runs outside
--     a run, while `event.run_id` is NOT NULL (0003). E3-1 and E3-3 run checks as STEPS,
--     inside a run, and that is where the kinds belong — one INSERT each, as promised.
--
--   * NO TABLES RESERVED FOR E3-1. The continuity board's per-scene rows are its own design
--     and its own naming; nothing here takes a name it might want (`RESERVED_TABLE_NAME` in
--     migrate.ts is for a name an epic must NOT squat on, and this migration squats on none).


-- ── The check ran. That is a record, even when it found nothing ─────────────────
--
-- SILENCE WITHOUT A RECORD IS INVARIANT 4'S FAILURE MODE ONE LEVEL UP. Two readers depend
-- on this row existing at zero findings, and neither is built yet:
--
--   * D11's cried-wolf tracking (E3-6) computes a RATIO — how many of a check's findings
--     Ryan dismissed or overrode, against how often the check fired. Without the
--     denominator there is no ratio, only a pile of complaints.
--   * The fixture's CONTROLS. Rules 2 and 3 of *The hull and the void* are obeyed on purpose
--     everywhere in ep01's script (E1-7's constraint, `episode.md`), and their measured
--     silence is the point. "The check ran and said nothing" is a different sentence from
--     "the check never ran", and this row is the only thing that tells them apart.
--
-- So a check pass is written FIRST and unconditionally, and its findings hang off it. There
-- is no path in domain/finding.ts that writes a finding without one.
CREATE TABLE check_pass (
  id  TEXT PRIMARY KEY,

  -- Which check ran, kebab-case ('stale-exception', 'retired-reappearance'). Free text by
  -- the reasoning above: E3-2 derives its keys from the show's declared categories.
  check_key  TEXT NOT NULL,

  -- deterministic | text. NO CHECK, and the asymmetry with `severity` below is deliberate:
  -- 4.2 names THREE tiers and E6 brings the third (media vs. reference), so a CHECK here
  -- would cost a table rebuild on a table with real findings hanging off it — 0007's
  -- reasoning about `canon_ruling.kind`, unchanged. The closed set is `CHECK_TIER` in
  -- app/server/domain/finding.ts, widened by a code change with a test (the Archon rule).
  tier  TEXT NOT NULL,

  -- What was checked. The VERSION is stored rather than read off `artifact` because the
  -- pass ran against v2 and the artifact moves on — the call `gate_round.artifact_version`
  -- already made in 0004, and the reason a pass stays readable after E3-5 rewrites a span.
  artifact_id       TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_version  INTEGER NOT NULL CHECK (artifact_version >= 1),

  -- The scene-scoped re-check (D14, E3-5): a rewrite lands in scene 4 and only scene 4 is
  -- checked again. NULL is the whole artifact, which is every pass E3-0 writes.
  scene_id  TEXT REFERENCES scene(id) ON DELETE SET NULL,

  ran_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- A pass that cannot say which check it was is not a record of anything.
  CHECK (check_key <> ''),
  CHECK (tier <> '')
);

-- Cried-wolf's window (E3-6): this check, over the last N days. `ran_at` is in the index
-- because the question is always "lately" — a check tuned six months ago should not be
-- judged on what it did before.
CREATE INDEX check_pass_by_check ON check_pass (check_key, ran_at);
-- The gate room's other half: what has been run against this artifact at all.
CREATE INDEX check_pass_by_artifact ON check_pass (artifact_id);


-- ── The finding ─────────────────────────────────────────────────────────────────
CREATE TABLE finding (
  id       TEXT PRIMARY KEY,
  pass_id  TEXT NOT NULL REFERENCES check_pass(id) ON DELETE CASCADE,

  -- ── The anchor (4.3) ──
  --
  -- "Exact span/scene/shot/take — clicking lands on the material, highlighted."
  --
  -- BY QUOTE, NEVER BY OFFSET. A script is a markdown file on the volume and E3-5's
  -- rewrites revise it; a character offset rots on the first edit above it, and it rots
  -- SILENTLY, because it still points at something. The quoted span is what the UI searches
  -- for, so it survives an edit elsewhere in the file and fails visibly — "this span is
  -- gone" — when the material it names really has been rewritten.
  --
  -- '' IS A LEGAL QUOTE and means "nothing to highlight": a canon-graph finding (both of
  -- E3-0's) is about an entity in the artifact's provenance rather than a span of its text.
  -- The empty one, never a missing one — `slot`, `usage_context` and `note` elsewhere in
  -- this schema make the same distinction.
  --
  -- THE ARTIFACT IS HERE AND NOT ONLY ON THE PASS, because they answer two questions and
  -- the continuity board is where they diverge: E3-1's deterministic rules run against the
  -- BOARD and land in the SCRIPT's scene 4, which is what the gate room renders. A gate
  -- renders one artifact and asks for everything anchored in it; making that join through
  -- the pass would put "board findings live in the script" inside the UI, which is where it
  -- would go wrong. In the ordinary case the two are the same artifact at the same version.
  --
  -- SCENE LINKAGE IS LOAD-BEARING, not decoration: E3-5's scene-scoped re-check clears
  -- findings BY SCENE (D14), and E3-1's board rules are per-scene rules.
  artifact_id       TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_version  INTEGER NOT NULL CHECK (artifact_version >= 1),
  -- SET NULL, matching `artifact.scene_id` and `artifact_revision.scene_id` (0001): a
  -- shorter re-delineation deletes scenes, and a finding against an older version degrades
  -- to the whole artifact rather than vanishing with the scene it named.
  scene_id          TEXT REFERENCES scene(id) ON DELETE SET NULL,
  quote             TEXT NOT NULL DEFAULT '',

  -- ── The concern (4.3): what it says, and what it says it against ──
  --
  -- `concern` is prose, and it is a RECORD — what this check said at that version, not a
  -- live view of anything. What it must NOT do is carry a copy of the fact it argues with:
  -- `entity_id` and the rows in `finding_fact` are IDS, so the gate room's card renders
  -- today's lineage line ("house-style › narrator-voice · established S1E01 gate · ratified
  -- Jul 2") off the fact itself rather than off a transcription that ages.
  --
  -- `entity_id` is nullable and the NULL says something: a craft reviewer (E3-4, D13) reads
  -- the artifact as craft and has no canon to name at all.
  concern    TEXT NOT NULL,
  entity_id  TEXT REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- ── Severity and confidence: TWO COLUMNS, FOREVER (invariant 4) ──
  --
  -- "Never render a weak check as a green checkmark." The gate room prints them side by
  -- side — "severity high · confidence certain" — because they answer different questions:
  -- how bad this is if true, and how sure the check is that it is true. A combined
  -- `priority` is the collapse invariant 4 exists to forbid, and it is not reversible: once
  -- two numbers are one, nothing can tell a certain triviality from a guessed catastrophe.
  --
  -- NOT NULL WITH NO DEFAULT, both of them. There is no way to write one and let the other
  -- fall to a default that means nothing, and no way for a check to have an opinion about
  -- severity without stating what it is worth. The deterministic tier is `certain` because
  -- that is what the tier MEANS (4.2) — not a value it happens to carry.
  --
  -- A CHECK on these two and none on `tier` above, deliberately. These are rendered WORDS
  -- from sets 4.2 and 4.3 ruled closed, and a typo would not fail loudly — it would render
  -- as an unknown badge, which is the honest-confidence failure in the one place it is
  -- fatal. `tier` grows in E6; these do not.
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  confidence  TEXT NOT NULL CHECK (confidence IN ('certain', 'high', 'medium', 'low')),

  -- A finding with nothing to say is not a finding.
  CHECK (concern <> '')

  -- NO `created_at`. `check_pass.ran_at` is when this was found — one instant, recorded
  -- once. A second timestamp on the same moment is a second thing that can be wrong.
);

-- The gate room's read, and E3-5's scene-scoped clear: everything anchored in this artifact,
-- narrowable to one scene.
CREATE INDEX finding_by_anchor ON finding (artifact_id, scene_id);
-- The pass's own count, and E3-6's join from a window of passes to what they found.
CREATE INDEX finding_by_pass ON finding (pass_id);


-- The facts the card quotes, in the order it quotes them (4.3: "concern — entity + fact
-- with lineage, quoted"). A TABLE and not a column, because it is a LIST — E3-0's own
-- stale-exception check quotes three on one finding: the exception, the inherited fact it
-- was written against, and what stands in that fact's place today. `proposal_alternative`
-- (0008) is the precedent: the gate room renders them as a list, and a list is rows.
--
-- RESTRICT, like every other reference into `fact`: a fact is never deleted (0007 refuses it
-- with a trigger), so nothing legitimate ever needs this edge to give way.
CREATE TABLE finding_fact (
  finding_id  TEXT NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  fact_id     TEXT NOT NULL REFERENCES fact(id) ON DELETE RESTRICT,
  PRIMARY KEY (finding_id, ordinal)
);


-- ── What Ryan did about it ──────────────────────────────────────────────────────
--
-- `fact_closure`'s shape one level out: the finding row is immutable, and its one state
-- change — open becoming disposed of — is a row here. PRIMARY KEY on `finding_id` is
-- "disposed once, one way", structural rather than a rule somebody remembered to write; a
-- second dismissal is a constraint violation.
--
-- `dismissed` is the only kind E3-0 writes, and the column carries NO CHECK for 0007's
-- reason: E3-5 adds `cleared` (a rewrite landed and the scene-scoped re-check no longer
-- fires it), and that must stay a widened union in domain/finding.ts with a test rather than
-- a table rebuild. `FINDING_DISPOSITION` there is the closed set.
--
-- THE NOTE IS THE POINT, not a comment field. 4.4: "dismissed-finding and rejected-proposal
-- notes feed future runs' context" — E3-5 builds the reader and E4's writer calls it, and
-- E3-6 counts these rows against the check that raised them. `dismissFinding` refuses an
-- empty note for that reason; the column keeps the '' default because `cleared` has nothing
-- to say and '' is the empty note, never a missing one.
CREATE TABLE finding_disposition (
  finding_id   TEXT PRIMARY KEY REFERENCES finding(id) ON DELETE CASCADE,
  disposition  TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- ── A finding is a record, and records do not move ──────────────────────────────
--
-- The rule `gate_ruling` states in 0004 and `fact` holds in 0007, held here for a reason of
-- its own: E3-6 computes cried-wolf ratios off these rows, and a check that could edit its
-- own findings could edit its own report card. What a check said at a version is history
-- the moment it said it; a later opinion is a later PASS, with its own findings.
--
-- UPDATE only, on all three. There is deliberately no DELETE trigger — the same asymmetry
-- `gate_ruling` carries in 0004: an artifact deleted with its episode must take its passes
-- and their findings with it, and a DELETE trigger here would abort that cascade instead.
-- Nothing in the app deletes any of these; the cascade is the door that stays open.
CREATE TRIGGER check_pass_is_history BEFORE UPDATE ON check_pass
  BEGIN SELECT RAISE(ABORT, 'a check pass is a record of a run — running again is a new pass, never an edit'); END;

CREATE TRIGGER finding_is_history BEFORE UPDATE ON finding
  BEGIN SELECT RAISE(ABORT, 'a finding is what a check said at a version — a later opinion is a later pass'); END;

CREATE TRIGGER finding_disposition_is_history BEFORE UPDATE ON finding_disposition
  BEGIN SELECT RAISE(ABORT, 'a disposition is kept forever (4.4) — it rides future runs and it does not move'); END;
