-- 0012 · what a semantic check was handed, and what it could not reach (E3-2)
--
-- 0010 said it hoped no other E3 issue would have to alter what it built, and this does not:
-- both tables here hang off `check_pass` and neither adds a column, a flag or a status to
-- anything that already exists. What they add is the two records a MODEL-run check needs and
-- a deterministic one does not.
--
-- ── Why a migration at all ──────────────────────────────────────────────────────
--
-- The deterministic tier reads rows and answers `certain`. It has exactly two outcomes and
-- 0010's schema holds both: a finding, or a pass with none. A semantic check has three, and
-- the third one is the reason this file exists.
--
--   1. It found something          → `finding`, as before.
--   2. It looked and found nothing → a `check_pass` at zero findings, as before.
--   3. It COULD NOT LOOK           → neither of those, and 0010 has nowhere to put it.
--
-- Invariant 4 — "never render a weak check as a green checkmark" — is what the third one
-- costs. A character whose `species` is declared `unknown` (D22) inherits no physiology, so a
-- vacuum rule has nothing to land on; the check did not clear that character, it could not
-- reach them. Filed as a zero-finding pass, that reads as a clean run. Filed as a finding, it
-- reads as a complaint about the artifact — and it would land in D11's cried-wolf numerator,
-- where Ryan dismissing it ("nobody has decided her species; that is not the script's fault")
-- would count against a check that was right to abstain. Both are the same failure in
-- different directions, so the gap is a third row.
--
-- `fact.ts` already refuses to collapse this at the layer below: `INHERITANCE_CASE` reports
-- `undeclared`, `declared-unknown` and `source-has-no-facts` separately rather than handing
-- back an empty array. This is where that honesty stops being a return value and becomes a
-- record somebody can query six months later.


-- ── The scope a pass ran with ───────────────────────────────────────────────────
--
-- Every fact that was loaded into the prompt, whether or not any finding quoted it.
--
-- WITHOUT THIS, A MEASURED SILENCE IS INDISTINGUISHABLE FROM AN ABSENT ONE — which is
-- exactly what 0010 built `check_pass` to prevent, one level down. Rules 2 and 3 of *The hull
-- and the void* are obeyed on purpose throughout ep01's script (`episode.md`), and their
-- silence is a measurement. A `check_pass` row says the world-rules check ran; it cannot say
-- that rule 2 was in front of it when it ran. "The check ran and said nothing about rule 2"
-- and "rule 2 never reached the prompt" are two different sentences, and these rows are the
-- only thing that tells them apart. E3-6 needs it for the same reason: a cried-wolf ratio per
-- RULE has its denominator here.
--
-- It is a HISTORICAL RECORD, not a cache and not a freshness flag (1.3). Nothing derives the
-- present from it. `check_pass.artifact_version` is stored on exactly this reasoning — the
-- pass read v2 and the artifact moves on — and canon moves on faster than artifacts do: a
-- fact superseded next week was still what this check was handed today, and re-deriving the
-- scope at read time would answer a different question.
--
-- Invariant 2's other half falls out of it. "Every artifact declares provenance; checks load
-- exactly the entities in scope, never the whole bible" is a promise a test can hold the
-- prompt to, and now also a promise the library can be audited against afterwards.
CREATE TABLE check_pass_fact (
  pass_id  TEXT NOT NULL REFERENCES check_pass(id) ON DELETE CASCADE,

  -- The order the scope was composed in, which is the order it appeared in the prompt.
  ordinal  INTEGER NOT NULL,

  -- RESTRICT, like every other edge into `fact`: a fact is never deleted (0007 refuses it
  -- with a trigger), so nothing legitimate ever needs this to give way.
  fact_id  TEXT NOT NULL REFERENCES fact(id) ON DELETE RESTRICT,

  -- WHOSE scope it was in. The same fact reaches one pass through two entities when a species
  -- is in provenance and one of its members is too, and "could this check see the physiology
  -- when it read Tobin" is the question a gap and a finding are both read against.
  entity_id  TEXT NOT NULL REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- The declaration the fact travelled to get here — `species` (D22, D23). '' when it is the
  -- entity's own fact: the EMPTY edge, never a missing one, exactly as `quote` in 0010 and
  -- `slot` in 0001. Stored as the declared NAME rather than a `relation_type` id because it
  -- is what the pass was told, and a declaration renamed afterwards must not silently rewrite
  -- what a past check was handed.
  via  TEXT NOT NULL DEFAULT '',

  PRIMARY KEY (pass_id, ordinal)
);

-- E3-6's question from the other end: every time this fact was loaded, and every pass that
-- had it in front of it.
CREATE INDEX check_pass_fact_by_fact ON check_pass_fact (fact_id);


-- ── What the check could not reach ──────────────────────────────────────────────
--
-- The third kind of nothing, recorded. "Could not check the vacuum rules against Sefa Doule —
-- her species is declared unknown, so no physiology is in scope."
--
-- NOT A FINDING, and the separation is the whole point. A finding is a complaint about the
-- ARTIFACT and it is loud: it lands on the verdict board, it counts in D11's ratio, and Ryan
-- has to put a disposition on it. A gap is a statement about the SCOPE — the world has not
-- decided something, and no rewrite of the script would answer it. It is quiet, it is
-- queryable, and the remediation for it is a canon proposal at somebody's leisure rather than
-- a rewrite at this gate. Neither is derivable from the other, so neither is stored as the
-- other.
--
-- NOT A SILENCE either: a pass with zero findings and one gap is not a clean run, and
-- `finding_count` alone would say it was.
--
-- NO DISPOSITION TABLE. A gap is not something Ryan rules on — closing it means somebody
-- deciding the species, which is a proposal ruled at a gate (invariant 1), and the next run
-- of the check simply does not raise it again. Adding a `gap_disposition` here would be a
-- second way to make canon quiet, which is the one thing invariant 1 forbids.
CREATE TABLE check_gap (
  id       TEXT PRIMARY KEY,
  pass_id  TEXT NOT NULL REFERENCES check_pass(id) ON DELETE CASCADE,

  -- Who could not be checked. Nullable for the same reason `finding.entity_id` is: a gap that
  -- is about the artifact rather than about an entity has no canon to name.
  entity_id  TEXT REFERENCES canon_entity(id) ON DELETE RESTRICT,

  -- Which kind of nothing, kebab-case, from `INHERITANCE_CASE` in app/server/domain/fact.ts:
  -- 'declared-unknown', 'undeclared', 'source-has-no-facts'. NO CHECK, for 0007's reasoning
  -- about `canon_ruling.kind` — the closed set is the TypeScript union, widened by a code
  -- change with a test rather than by rebuilding a table with real records hanging off it.
  reason  TEXT NOT NULL,

  -- The declaration whose far end was empty. '' when the gap is not about an edge at all.
  via  TEXT NOT NULL DEFAULT '',

  -- The sentence Ryan reads. Prose, and a record — what this check said at that version.
  detail  TEXT NOT NULL,

  -- A gap that cannot say which kind of nothing it hit, or what it could not do, is a gap in
  -- the record rather than a record of a gap.
  CHECK (reason <> ''),
  CHECK (detail <> '')
);

CREATE INDEX check_gap_by_pass ON check_gap (pass_id);
-- The canon library's gaps list, from the checking side (D22 has the declaration side).
CREATE INDEX check_gap_by_entity ON check_gap (entity_id);


-- ── Both are records, and records do not move ───────────────────────────────────
--
-- 0010's rule, held for its reason: a check that could edit what it was handed could edit its
-- own report card, and E3-6 computes ratios off exactly these rows. UPDATE only, on both —
-- the DELETE path stays open so an artifact deleted with its episode takes its passes, its
-- findings, its scope and its gaps with it (0010's cascade, unchanged).
CREATE TRIGGER check_pass_fact_is_history BEFORE UPDATE ON check_pass_fact
  BEGIN SELECT RAISE(ABORT, 'a pass is a record of what it was handed — a different scope is a different pass'); END;

CREATE TRIGGER check_gap_is_history BEFORE UPDATE ON check_gap
  BEGIN SELECT RAISE(ABORT, 'a gap is what a check could not check at a version — the next run raises its own'); END;
