-- 0013 · a scene may stop existing, and the schema already said what happens then (E4-3)
--
-- E4-3 decided how scene identity survives a rewrite: **a scene is its heading**
-- (`domain/delineate.ts`). Re-delineating matches a new draft's scenes to the standing rows by
-- heading, so a heading that is gone takes its scene with it — and that is the first time
-- anything in this app deletes a scene that other rows point at.
--
-- Every one of those rows already declares what it wants to happen. 0001 gave `artifact`,
-- `artifact_revision` and `artifact_input` `scene_id … ON DELETE SET NULL`; 0010 gave `finding`
-- the same, and said why in as many words: "a shorter re-delineation deletes scenes, and a
-- finding against an older version degrades to the whole artifact rather than vanishing with
-- the scene it named." 0011 ruled the other way for `board_scene` and said why: a board row for
-- a scene that no longer exists is a row about nothing.
--
-- So no ruling changes here. **One of them was unreachable, and this makes it reachable.**
--
-- ── The defect: an immutability trigger that fires on the schema's own degradation ─
--
-- 0010's `finding_is_history` aborts every UPDATE on `finding`, for a reason that is still
-- right: a check that could edit its own findings could edit its own report card, and E3-6
-- computes cried-wolf ratios off exactly these rows.
--
-- But SQLite implements `ON DELETE SET NULL` as an UPDATE of the child row. So the trigger
-- fires on the FK's own action, the delete aborts, and the degradation 0010 designed cannot
-- happen at all. Nothing had noticed, because until E4-3 nothing ever deleted a scene a finding
-- pointed at: `delineateScenes` only ever truncated an episode's tail, and the fixture never
-- shortened.
--
-- The trigger is therefore narrowed to permit EXACTLY that one update and nothing else: the
-- scene going from something to nothing, with every other column of the row identical. A
-- finding still cannot change its concern, its severity, its confidence, its quote, its entity,
-- its version or its pass — and, the part that matters most for an anchor, it cannot be
-- re-pointed at a DIFFERENT scene. An anchor may degrade to the whole artifact; it may never
-- migrate to prose nobody checked, which is the whole of E4-3's identity argument.
--
-- `IS` rather than `=` throughout: it is SQLite's null-safe comparison, and two of these
-- columns are nullable.
--
-- ── THE OBLIGATION THIS CREATES, and it is a real cost ──────────────────────────
--
-- 0007 chose a blanket ABORT over a guarded one-way UPDATE for `fact`, and gave the reason
-- this schema keeps proving: tables here grow by ADD COLUMN, and a WHEN clause that enumerates
-- the immutable columns silently stops covering the column added after it. 0010's blanket
-- ABORT on `finding` inherited that ruling. **This narrowing re-opens that exposure, knowingly,
-- because the alternative was a foreign key the schema declares and cannot fire.**
--
-- So it is not free, and the price is stated where the next person will be standing:
-- **any future ADD COLUMN on `finding` must extend this trigger's pin list, or a
-- scene-degradation UPDATE can smuggle a change to the unpinned column.** The list above is
-- every column `finding` has today; a column added without a line here is a column a caller
-- may rewrite by nulling a scene in the same statement.
--
-- And it does not depend on anybody reading this paragraph. `migrate.test.ts` reads the pin
-- list off the DEPLOYED trigger (`sqlite_master`, not this file) and diffs it against
-- `PRAGMA table_info(finding)`, so the column added without a pin fails there with the
-- sentence that says what to do — extend the list in a NEW migration, because this one is
-- applied and an applied migration is history. A third case in that block adds a column and
-- smuggles a write through, so the hole is demonstrated rather than described.
--
-- The message is 0010's, word for word. It is what a caller trying to edit a finding sees, and
-- that has not changed.
DROP TRIGGER finding_is_history;

CREATE TRIGGER finding_is_history BEFORE UPDATE ON finding
  WHEN NOT (
        OLD.scene_id         IS NOT NULL
    AND NEW.scene_id         IS NULL
    AND NEW.id               IS OLD.id
    AND NEW.pass_id          IS OLD.pass_id
    AND NEW.artifact_id      IS OLD.artifact_id
    AND NEW.artifact_version IS OLD.artifact_version
    AND NEW.quote            IS OLD.quote
    AND NEW.concern          IS OLD.concern
    AND NEW.entity_id        IS OLD.entity_id
    AND NEW.severity         IS OLD.severity
    AND NEW.confidence       IS OLD.confidence
  )
  BEGIN SELECT RAISE(ABORT, 'a finding is what a check said at a version — a later opinion is a later pass'); END;

-- ── What this file deliberately does NOT do ─────────────────────────────────────
--
-- `artifact_revision` and `artifact_input` are the other two tables whose `scene_id` degrades,
-- and both carry a UNIQUE index over `COALESCE(scene_id, '')` — so two scene-scoped rows of one
-- artifact degrading in the same delete would collide on it. That is not a schema defect and
-- there is no ALTER to make it one: the two rows really are the same row once they have
-- forgotten which scene they were about, and which of "merge them" or "drop them" is right
-- differs by table.
--
--   * a REVISION is a record — "your scene-3 edit made v4" — so it degrades and MERGES, and v4
--     is left saying it changed the whole artifact, which is the same claim with less detail;
--   * an INPUT EDGE is a per-scene reading, so it is dropped with the scene, which is 0011's
--     ruling for `board_scene` said about the same fact; the next rebuild rewrites the whole
--     set through `replaceInputs` anyway.
--
-- Both are done in `releaseScene` (domain/artifact.ts), called by `delineateScenes` before the
-- row goes — in TypeScript, where the difference between the two is readable and has a test.
