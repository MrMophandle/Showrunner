-- 0015 · the fourth verdict: a draft you put down (E5-3, #83)
--
-- 0004 wrote three verbs and said why the third is its own word: *"'override' is 'approve'
-- over something the checks argued... the verb is distinct here from the start, because
-- retrofitting the distinction would mean every override recorded before E3 is
-- indistinguishable forever."* This migration is that ruling applied a second time, to a
-- fourth act nobody had a word for.
--
-- ── The gap, in Ryan's own shape ────────────────────────────────────────────────
--
-- The E4 ledger records it: **"A presenting gate has one exit, and it is approve."** A
-- presenting stage produces nothing (`runner/present-step.ts`), so a rejection whose note is
-- about the draft in front of him re-presents the SAME BYTES as the next round — and D7 holds
-- the episode while that gate stands open, so the rewrite the note asked for cannot happen
-- until he approves the draft he just rejected. Round 2 of a presenting gate can therefore
-- never show him anything the round before did not. The ledger's closing line: *"a rejection
-- he means as 'put this down for now' has no verb: he must approve, or leave the run parked
-- forever."*
--
-- ── Why a fourth verdict, and not a fourth meaning for the third ────────────────
--
-- The alternative considered and rejected was to add no verdict at all — to rule instead that
-- at a presenting gate every rejection ends the run, since round 2 there is a dead branch. It
-- is cheaper, it moves no schema, and it is wrong for one reason: **the record.** Under it,
-- "reject" means *do it again* at a writing gate and *I am putting this down* at a presenting
-- one — one word, two acts, told apart only by joining out to the run's stage and asking a
-- CATALOGUE that can lose an entry (E4-1 retired `demo` and left its gates in Ryan's library).
-- A season later "did I put ep02's premise down, or did I expect a rewrite?" would be
-- archaeology, which is the one thing the HIL contract forbids (4.6).
--
-- So: a distinct act gets a distinct verb, recorded from the start. That is 0004's own rule,
-- and this is the second time it has been needed.
--
-- ── What `close` is, exactly ────────────────────────────────────────────────────
--
--   * It ends the run. The step it returns into does not re-present and does not re-produce,
--     so D7 lets go and the episode is free the moment the ruling lands.
--   * Its note STANDS. `domain/routing.ts` and `domain/write-context.ts` read a closing note
--     exactly as they read a rejection's, so the stage that writes the artifact becomes
--     offerable again with his words quoted on it, and the next writer run reads them back.
--   * It advances no lifecycle, rules no finding, and takes no wall down. A close is not an
--     approval and it is not an override; `overriddenVersions` still filters on `'override'`
--     alone, so D12's wall and D11's cried-wolf ratio cannot see this verb at all.
--   * It takes no precondition on the artifact's account — no findings check, no validation
--     (invariant 3, D12). Its one refusal is its own note, which is the verb's OBJECT rather
--     than a condition on the world, exactly as `reject`'s is: a parking says why, because 4.4
--     reads it back later.
--
-- It is available at EVERY gate, not only a presenting one. `createRulings` knows nothing
-- about stages and must not learn — *a gate says where Ryan stood, never whether he may rule.*
-- At a writing gate a close means the same thing it means here: stop, the note stands, and
-- nothing is rewritten until you ask.
--
-- ── The rebuild, and the trap in it ─────────────────────────────────────────────
--
-- SQLite cannot widen a CHECK, so `gate_ruling` is rebuilt — 0014's precedent, at a size where
-- it costs nothing. But `gate_ruling` is the first table rebuilt in this schema that something
-- else POINTS AT: `gate_note` carries `FOREIGN KEY (gate_id, round) REFERENCES gate_ruling`
-- with ON DELETE CASCADE, and foreign keys are ON in this process (`db/store.ts`) and cannot
-- be turned off inside a transaction, which is what every migration runs in (`db/migrate.ts`).
--
-- **`DROP TABLE gate_ruling` would take every note in the database with it.** DROP TABLE
-- performs an implicit row removal that fires no TRIGGERS but does fire FOREIGN KEY ACTIONS,
-- and the action here is a cascade. 0004's rebuild of `event` was safe precisely because
-- nothing references `event`, and it says so; this one is not, so the notes are lifted out
-- first, the parent is rebuilt with nothing pointing at it, and the notes are put back with
-- their key and their `seq` intact. `migrate.test.ts` proves a note written before this
-- migration is still there after it.

-- ── One · lift the notes out of the blast radius ────────────────────────────────
--
-- No foreign key and no AUTOINCREMENT: this table exists for three statements and is dropped
-- below. `seq` is carried verbatim, because a note keeps the order Ryan wrote it in.
CREATE TABLE gate_note_held (
  seq             INTEGER PRIMARY KEY,
  gate_id         TEXT NOT NULL,
  round           INTEGER NOT NULL,
  note            TEXT NOT NULL,
  depth           TEXT,
  target          TEXT,
  target_version  INTEGER
);

INSERT INTO gate_note_held (seq, gate_id, round, note, depth, target, target_version)
  SELECT seq, gate_id, round, note, depth, target, target_version FROM gate_note ORDER BY seq;

-- Nothing references `gate_note`, so this drops rows and violates nothing.
DROP TABLE gate_note;

-- ── Two · the rebuild proper ────────────────────────────────────────────────────
--
-- Column for column identical to 0004 except `verdict`, which gains one word. Everything 0004
-- argued for survives: the primary key still refuses a second ruling on one round, so round 2
-- can never overwrite round 1, and the trigger below still refuses every UPDATE.
CREATE TABLE gate_ruling_rebuilt (
  gate_id   TEXT NOT NULL,
  round     INTEGER NOT NULL,
  verdict   TEXT NOT NULL CHECK (verdict IN ('approve', 'reject', 'override', 'close')),
  comment   TEXT,     -- Ryan's optional words on an approval or an override
  ruled_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (gate_id, round),
  FOREIGN KEY (gate_id, round) REFERENCES gate_round(gate_id, round) ON DELETE CASCADE
);

INSERT INTO gate_ruling_rebuilt (gate_id, round, verdict, comment, ruled_at)
  SELECT gate_id, round, verdict, comment, ruled_at FROM gate_ruling;

DROP TABLE gate_ruling;
ALTER TABLE gate_ruling_rebuilt RENAME TO gate_ruling;

-- 0004's, recreated verbatim against the new table. It went with the old one when it dropped.
CREATE TRIGGER gate_ruling_is_history BEFORE UPDATE ON gate_ruling
  BEGIN SELECT RAISE(ABORT, 'a ruling is history — a new opinion is a new round, never an edit'); END;

-- ── Three · the notes back, with their key ──────────────────────────────────────
--
-- 0014's table, verbatim, including both CHECKs and the closed depth set — this migration
-- widens the VERDICT and nothing else. Explicit `seq` again, so AUTOINCREMENT continues above
-- the highest copied value rather than restarting at 1.
CREATE TABLE gate_note (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,   -- the order Ryan wrote them in
  gate_id         TEXT NOT NULL,
  round           INTEGER NOT NULL,
  note            TEXT NOT NULL,
  depth           TEXT CHECK (depth IN ('artifact', 'scene', 'outline', 'premise', 'shot', 'take')),
  target          TEXT,
  target_version  INTEGER CHECK (target_version IS NULL OR target_version >= 1),
  CHECK (depth IS NOT NULL OR target IS NULL),
  CHECK (target IS NOT NULL OR target_version IS NULL),
  FOREIGN KEY (gate_id, round) REFERENCES gate_ruling(gate_id, round) ON DELETE CASCADE
);

INSERT INTO gate_note (seq, gate_id, round, note, depth, target, target_version)
  SELECT seq, gate_id, round, note, depth, target, target_version FROM gate_note_held ORDER BY seq;

DROP TABLE gate_note_held;

CREATE INDEX gate_note_by_round ON gate_note (gate_id, round, seq);
CREATE INDEX gate_note_by_target ON gate_note (target);

-- ── Four · the fourth gate kind ─────────────────────────────────────────────────
--
-- One INSERT, which is what 0004 bought when it traded `event`'s CHECK for this lookup table.
-- A fifth gate kind rather than a flag on `gate-rejected`, for 0004's own reason: "closed the
-- ep02 premise gate — the run ended and ep02 is free" and "rejected the ep02 premise, round 2
-- opens" are different sentences on the floor, and a log that cannot tell them apart has lost
-- the only record that Ryan put anything down.
INSERT INTO event_kind (kind) VALUES ('gate-closed');
