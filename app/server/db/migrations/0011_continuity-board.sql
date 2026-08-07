-- 0011 · the continuity board (E3-1)
--
-- 3.2b, as tables: "every script derives a continuity board: per scene — location,
-- characters present, environment state (suited/inside/exposed), ship position, elapsed
-- time. LLM extracts; the worst bugs are then caught deterministically."
--
-- That sentence has a seam in the middle of it, and this migration exists to keep the seam
-- open. EXTRACTION IS A PAID STEP. THE RULES ARE FREE. What is stored here is the boundary
-- between them: the model reads the script once and writes these rows, and every
-- deterministic rule afterwards is a join over them that costs nothing and can be re-run as
-- many times as anyone likes. Fold the two together — a rule that re-reads the script — and
-- every re-check bills Ryan for an answer he has already paid for.
--
-- These rows are also the episode room's SCENE GRID (mockups/episode-room.html): "Scene ·
-- Location · Present · Environment · Ship · Elapsed". One shape, two readers. The grid is
-- not a rendering of the board, it IS the board, which is why the columns are named for what
-- Ryan sees rather than for what a rule needs.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * NO `is_blocking`, NO `blocked`, NO `severity` — no state of any kind. A board rule
--     raises a finding through domain/finding.ts like every other check, tier
--     `deterministic`, and D12's stage wall is still E3-3's computation over open findings.
--     0010 refused a flag column and the refusal binds this migration too; there is a test
--     in finding.test.ts that reads pragma_table_info across all of these to keep it that way.
--
--   * NO FRESHNESS. The board is an `artifact` (kind `continuity-board`, already in
--     ARTIFACT_KIND since E1-2) and it records what it was built from through
--     `artifact_input`, per scene. "Your scene-3 edit made script v4, so the board is stale"
--     is then computed by machinery that has existed since E1-2, and E3-1 writes none of it.
--     A `stale` column here would be the 1.3 mistake in the one place the app is proudest of
--     not having made it.
--
--   * NO VERSION COLUMN, and no history. These rows are the CURRENT extraction: a rebuild
--     replaces them for that board wholesale. The board artifact's `version` and its
--     `artifact_revision` rows are where "rebuilt from script v4" is recorded, and a second
--     copy of the version down here could disagree with it.
--
--   * NO `num_scenes`, obviously (0001). A board scene row exists because a `scene` row
--     exists, and scenes are derived from the script (D3).
--
--   * NO event kinds. 0010 left one INSERT here for the taking and E3-1 does not take it: an
--     event kind is a row AND a member of EVENT_KIND AND *a sentence something renders*, and
--     nothing renders a check event until E3-4's panels and E3-7's screen. The extraction
--     step narrates itself with `progress()` like every other step. E3-3 or E3-4 takes it,
--     with a reader.


-- ── The grid ────────────────────────────────────────────────────────────────────
--
-- One row per scene of one board. The primary key is (board, scene) because a board has
-- exactly one reading of each scene — two would be two boards.
--
-- `scene_id` CASCADEs rather than SET NULLing, which is the opposite of what `finding` and
-- `artifact` do with the same reference, and the difference is what the row IS. A finding
-- against a deleted scene is still a record of something someone said, so it degrades to
-- the whole artifact. A board row for a scene that no longer exists is a row about nothing:
-- re-delineating a shorter episode (D3, `delineateScenes`) deletes the scenes past the end,
-- and their grid rows go with them. The board is rebuilt from the script that shortened it.
CREATE TABLE board_scene (
  board_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  scene_id  TEXT NOT NULL REFERENCES scene(id)    ON DELETE CASCADE,

  -- The place, as the script names it: "Harbourmaster's office", "The Long Pier". TEXT and
  -- not only an entity, because the grid's Location column is a place in a script and Grey
  -- Harbor's six scenes happen in ONE canon location — a board that compared entity ids
  -- would report that the mess deck and the pier are the same room, which is both true and
  -- useless. The dual-presence rule compares THIS.
  location  TEXT NOT NULL,
  -- The canon location this place is part of, when the extraction could name one. Nullable
  -- and SET NULL: it is the invariant-2 tie from a grid row back to the sheet whose facts
  -- describe it, never the thing a rule compares.
  location_entity_id  TEXT REFERENCES canon_entity(id) ON DELETE SET NULL,

  -- Is the air on this side of the hull? `inside` | `exposed`. The scene's property, not a
  -- person's: 3.2b's third state, `suited`, is what a BODY wears and lives on
  -- `board_presence.protection` below, because scene 6 of The Long Pier is one exposed place
  -- with one suited woman in it and a single column could not say both. The grid's
  -- Environment cell renders the pair ("suited · exposed"), exactly as the mockup does.
  environment  TEXT NOT NULL,

  -- Where the ship is — "docked · Meridian Spur", "drifting", "under thrust". '' when the
  -- show has no ship to be anywhere: Grey Harbor is a station and says nothing. The EMPTY
  -- one, never a missing one, which is the call `slot`, `quote` and `note` already made.
  ship_position  TEXT NOT NULL DEFAULT '',

  -- The clock, in seconds, and the words for it. TWO COLUMNS because they answer two
  -- questions: `elapsed_seconds` is what the rules compare and `elapsed_label` is what the
  -- grid prints ("07:20", "CONTINUOUS", "T+2h"). Deriving either from the other is a parser
  -- in the rules or a formatter in the schema, and both rot.
  --
  -- NULL SECONDS IS THE HONEST ANSWER when a scene does not place itself in time, and it is
  -- load-bearing: every rule that compares clocks ABSTAINS on a NULL rather than guessing an
  -- order. Deterministic means certain (4.2), and an unstated time is not a time.
  --
  -- A scene marked CONTINUOUS carries the seconds of the one it continues from and the label
  -- CONTINUOUS — the resolution belongs to extraction, which is reading the script, and not
  -- to a rule, which is comparing numbers.
  elapsed_seconds  INTEGER,
  elapsed_label    TEXT NOT NULL DEFAULT '',

  PRIMARY KEY (board_id, scene_id),
  CHECK (location <> ''),
  CHECK (environment <> '')
);


-- ── Who is in it ────────────────────────────────────────────────────────────────
--
-- The grid's Present column, one row per body, because "Ilse, Tobin" is a LIST and a list is
-- rows — the call `finding_fact` and `proposal_alternative` already made. It is also what
-- makes dual presence a `COUNT(*)` rather than a string comparison (episode.md).
--
-- The composite reference back to `board_scene` is deliberate: a body cannot be present in a
-- scene the board has no reading of.
CREATE TABLE board_presence (
  board_id  TEXT NOT NULL,
  scene_id  TEXT NOT NULL,

  -- As the script writes them ("Ilse Renn"), and the canon identity when the extraction
  -- could tie one. NULLABLE, and the rules still work without it: a character the extraction
  -- could not place in canon is still one body, and nothing about "she is in two places at
  -- once" needs a sheet. What DOES need the id is the vacuum rule, which reads this
  -- character's facts in scope — so a body with no id is a body no species fact can reach,
  -- and the rule stays silent rather than guessing. That is the tier's whole discipline.
  character_name  TEXT NOT NULL,
  entity_id       TEXT REFERENCES canon_entity(id) ON DELETE SET NULL,

  -- What is between this body and the void: `none` | `hardsuit` | `containment-field` |
  -- `unknown`. The two exceptions *The hull and the void* names, the absence of both, and the
  -- fourth answer that is not a state at all.
  --
  -- `unknown` IS NOT `none`. A scene that does not say what someone is wearing has not said
  -- they are wearing nothing, and the difference is a person's life: `none` in an exposed
  -- scene is a deterministic finding, `unknown` is silence here and E3-2's honest "could not
  -- check" there. `fact.ts` spent a four-case enum on this same distinction (D22).
  protection  TEXT NOT NULL,

  -- Did they come INTO this place during this scene, as opposed to already being in it? The
  -- duplicate-arrival rule is the only reader: arriving somewhere twice is only wrong if
  -- nothing in between says you left.
  arrives  INTEGER NOT NULL DEFAULT 0 CHECK (arrives IN (0, 1)),

  PRIMARY KEY (board_id, scene_id, character_name),
  FOREIGN KEY (board_id, scene_id) REFERENCES board_scene (board_id, scene_id) ON DELETE CASCADE,
  CHECK (character_name <> ''),
  CHECK (protection <> '')
);

-- Dual presence and duplicate arrival both walk one character across the whole board.
CREATE INDEX board_presence_by_character ON board_presence (board_id, character_name);


-- ── What the geography costs to cross ───────────────────────────────────────────
--
-- `fixtures/greyharbor/canon/location/_category.md`, in the fixture's own words: "A
-- location's facts carry its geography and its transit costs — what is adjacent to what, and
-- how long the crossing takes. Those are the facts the continuity board reads to catch
-- impossible adjacency deterministically, so write them as numbers a machine can compare."
--
-- This table is where those numbers land, and it is why the adjacency rule is free rather
-- than clever. The extraction reads "cycling the No. 4 lock takes ninety seconds in either
-- direction" ONCE, out of a canon fact, and writes 90 twice; the rule after it does nothing
-- but subtract two clocks and compare. No rule in this epic reads prose.
--
-- DIRECTED, one row per ordered pair, because "in either direction" is a property of that
-- crossing rather than of crossings — a chute you can only fall down is a real place. The
-- extraction writes both rows when the fact says both.
--
-- `fact_id` is the lineage the finding quotes: a card that says "the crossing does not fit"
-- has to be able to show the fact that says how long it takes, with its ruling. Nullable,
-- because a transit the script itself states ("the counter starts at ninety") is real and
-- has no canon row behind it. RESTRICT like every other reference into `fact` — nothing
-- deletes a fact (0007 refuses it), so this edge never legitimately needs to give way.
CREATE TABLE board_transit (
  board_id       TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  from_location  TEXT NOT NULL,
  to_location    TEXT NOT NULL,
  seconds        INTEGER NOT NULL CHECK (seconds >= 0),
  fact_id        TEXT REFERENCES fact(id) ON DELETE RESTRICT,

  PRIMARY KEY (board_id, from_location, to_location),
  CHECK (from_location <> ''),
  CHECK (to_location <> ''),
  CHECK (from_location <> to_location)
);


-- ── Which bodies the void kills ─────────────────────────────────────────────────
--
-- D22's whole point, made checkable. "A rule about vacuum catches nobody" until something in
-- scope says what a body IS (`species/_category.md`), and the Halvani sheet's physiology fact
-- is what makes rule 1 of *The hull and the void* land on Tobin Wick.
--
-- The row NAMES A FACT and states nothing itself. The extraction found, in the artifact's
-- scope, a fact meaning this species dies in unprotected vacuum, and recorded which fact it
-- was. Then the vacuum rule does not read that fact's prose — it checks whether the fact is
-- STILL IN THIS CHARACTER'S SCOPE TODAY, through `factsInScope`, and quotes it if so.
--
-- That indirection is where the tier's certainty actually comes from, and it is worth being
-- exact about. The board's reading can go out of date; the scope cannot, because it is
-- computed. So a character whose `species` edge is declared `unknown` (a relation row with a
-- NULL target — D22) inherits nothing, the hazard fact is not in their scope, and the rule
-- is SILENT no matter what this table says. Same for a species fact that has since been
-- reverted. Silence there is not a gap: it is E3-2's semantic checker's honest "could not
-- check", and taking a guess here would spend the one thing this tier has.
--
-- `hazard` is kebab-case and has one member today, `lethal-in-vacuum`. No CHECK, for 0007's
-- reason — the closed set is `BOARD_HAZARD` in domain/board.ts, widened by a code change
-- with a test (the Archon rule).
CREATE TABLE board_hazard (
  board_id   TEXT NOT NULL REFERENCES artifact(id)     ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE CASCADE,
  hazard     TEXT NOT NULL,
  fact_id    TEXT NOT NULL REFERENCES fact(id) ON DELETE RESTRICT,

  PRIMARY KEY (board_id, entity_id, hazard, fact_id),
  CHECK (hazard <> '')
);
