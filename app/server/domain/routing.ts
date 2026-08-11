import type { Store } from '../db/store.ts'
import type { NoteDepth } from '../runner/gate.ts'
import type { ArtifactKind } from './artifact.ts'
import { producedBy } from './write-context.ts'

/**
 * **Where a rejection note is addressed, and when it has been answered** (E4-5, D21, 4.7).
 *
 * > Reject is **routed, not rewound**: each note picks its depth, and *nothing regenerates
 * > until the note lands*.
 *
 * On the writing line the depths that matter are three — this draft, the outline, the premise
 * — and the whole of the mechanism is two questions this module answers over rows:
 *
 *   1. **Where does this note land?** Resolved once, when Ryan writes it, because the answer
 *      is about the artifact standing at that moment. `addressOf` turns a depth into an
 *      artifact id and the version it stood at, and `runner/gate.ts` stamps both onto the
 *      `gate_note` row inside the ruling's own transaction (0014).
 *   2. **Has anybody answered it?** `addressed` — a NEWER VERSION of the target exists than
 *      the one standing when the note landed. Computed on every read, never stored: a flag
 *      would be a second answer waiting to disagree with the first, which is the ruling
 *      artifact freshness (1.3), finding status (0010) and gate-round staleness (0004) are all
 *      built on. Nothing is ever written back to a note.
 *
 * ## Nothing here regenerates anything, and that is the point
 *
 * A routed note changes exactly one thing: **the target's OFFER.** A writing stage refuses an
 * episode that already has its artifact — "rule on it at its gate, or edit it directly" — and
 * that refusal yields to a note standing against that artifact, with the note in the sentence
 * (`runner/write-step.ts`). Ryan clicks, or he does not. No run is enqueued, no draft is
 * written, and the note is answered by whatever version he lands, whether the writer wrote it
 * or he typed it himself (`edit.ts`).
 *
 * ## Two questions over one row, and they are not the same question (#76)
 *
 * "Has anybody answered it?" is asked by two callers who want different sets, and answering
 * both with one function is the bug issue #76 was filed for. `routedNotesTo` is the DESK's —
 * notes from elsewhere, because the desk already reads an artifact's own gate rounds and
 * printing them twice would hand one instruction to a writer as two. `notesOwedBy` is the
 * OFFER's — every unanswered note addressed here, own gate included, because a **presenting**
 * gate has no producer and every note it can write is written over the artifact it names.
 * Each is stated at its own export, and each is tested where it is read.
 *
 * ## Three authorities, never blurred
 *
 * A routed note is a `gate_note` row and there is no second table for one, so it reaches a
 * writer through the reader that already composes rejections onto the desk
 * (`write-context.ts`). What keeps the three kinds of note apart there is the ORIGIN, not the
 * storage: "your script-gate note, routed here" is a different instruction from "your round-2
 * rejection of this draft", which is a different instruction again from "a finding you
 * dismissed in ep01". One record, many readers; the attribution travels with it.
 *
 * ## What a depth may name, and what it may not
 *
 * `outline` and `premise` name a written artifact of the episode — one apiece, because the
 * three writing kinds carry no slot. `artifact` is the draft under review and the gate already
 * records which one that is, so it resolves to no address at all: it is the ordinary rejection
 * the correction loop has always answered by writing the draft again. `scene` keeps the target
 * Ryan sent, which is a scene of the artifact under review rather than another artifact — so it
 * carries no version, and `landsOn` leaves it where it was written. `shot` and `take` are E6's
 * and reach nothing here.
 *
 * A depth naming a kind this episode has not written yet resolves to nothing, and is recorded
 * as a note with no address rather than refused. **Nothing may block a ruling** (`gate.ts`):
 * the three verdicts take no preconditions, and a route that lands nowhere is still a verdict
 * Ryan gave.
 */

/**
 * The kind a depth names, when it names a written artifact of the episode at all.
 *
 * It reads through `producedBy` rather than writing the kinds out, so "the premise depth" and
 * "what the premise step writes" cannot drift apart. **A function rather than a constant, on
 * purpose:** `write-context.ts` reads this module and this module reads it back — one record,
 * many readers, in both directions — and a map built at module scope would be evaluated
 * mid-cycle, before the export it reads exists. Called from inside a function it is resolved
 * every time and always right.
 *
 * `artifact` and `scene` are the draft under review, which the gate already names; `shot` and
 * `take` are E6's. All four answer undefined, and the header says what that means.
 */
function depthKind(depth: NoteDepth): ArtifactKind | undefined {
  if (depth === 'premise') return producedBy('premise')
  if (depth === 'outline') return producedBy('outline')
  return undefined
}

/** A note as Ryan wrote it, before it has an address. The draft `runner/gate.ts` takes. */
export interface NoteToAddress {
  note: string
  depth?: NoteDepth
  target?: string
}

/** Where a note is addressed. Both null: it is about the draft in front of him. */
export interface NoteAddress {
  /** The artifact (or the scene, shot, take) the note names. */
  target: string | null
  /** The version the target stood at when the note landed. Null unless it names an artifact. */
  targetVersion: number | null
}

/** One note with its address, as the row carries it. */
export interface AddressedNote {
  note: string
  depth: NoteDepth | null
  target: string | null
  targetVersion: number | null
}

/**
 * **Resolves a note's address at the moment it lands** — the version is the point.
 *
 * It is answered here, in the ruling's transaction, rather than looked up later: "a newer
 * version of the target exists" needs the version that was standing when Ryan wrote the note,
 * and nothing else in the schema records it (0014 says why timestamps cannot stand in).
 *
 * A depth that names a written kind resolves from the EPISODE, and any `target` the caller
 * sent for it is ignored: there is one outline per episode and one premise-brief, so a second
 * way to say which would be a second answer that can disagree.
 */
export function addressOf(
  store: Store,
  gate: { episodeId: string; artifactId: string },
  note: NoteToAddress,
): NoteAddress {
  const kind = note.depth === undefined ? undefined : depthKind(note.depth)
  if (kind === undefined) {
    return { target: note.target ?? null, targetVersion: null }
  }

  const row = store.get<{ id: string; version: number }>(
    'SELECT id, version FROM artifact WHERE episode_id = ? AND kind = ? ORDER BY slot LIMIT 1',
    gate.episodeId,
    kind,
  )
  return row
    ? { target: row.id, targetVersion: row.version }
    : { target: null, targetVersion: null }
}

/**
 * Whether this note is about the artifact under review — the ones a re-run of the producing
 * step answers by writing the draft again.
 *
 * A note is taken off the draft only when it names ANOTHER artifact, which is exactly the
 * pair `(target, targetVersion)` being present: a scene target carries no version, so a note
 * about scene 4 of the script is still a note about the script.
 */
export const landsOn = (note: AddressedNote, artifactId: string): boolean =>
  note.target === null || note.targetVersion === null || note.target === artifactId

/** One note standing against an artifact, with where Ryan was standing when he wrote it. */
export interface StandingNote {
  note: string
  gateId: string
  round: number
  /**
   * Which verb left it — `reject` or `close` (0015). Carried rather than flattened, because
   * "I sent this back" and "I put this down" are different instructions to whoever reads the
   * note next, and the ledger keeps them apart forever.
   */
  verdict: 'reject' | 'close'
  /** Null when he routed it nowhere — the legal default, and it lands on the draft (D21). */
  depth: NoteDepth | null
  /** The artifact it stands against. */
  targetId: string
  /** The version THAT artifact stood at when the note landed. */
  landedAtVersion: number
  /** The artifact the gate was over — where Ryan was standing when he wrote it. */
  fromArtifactId: string
  fromKind: ArtifactKind
  ruledAt: string
  /** A newer version of the artifact exists. Computed on every read (see the header). */
  addressed: boolean
}

/** A note ROUTED here from another gate. It named this artifact, so it carries a depth. */
export interface RoutedNote extends StandingNote {
  depth: NoteDepth
  /** The version the target stood at when the note landed. `landedAtVersion`, named for it. */
  routedAtVersion: number
}

/**
 * **Every note standing against this artifact**, newest first, from whatever gate — the one
 * read, from which the two questions below are asked.
 *
 * Two arms, and they are `landsOn` said in SQL: a note that NAMED this artifact from anywhere,
 * and a note written at a gate over this artifact that named nothing else. Nothing else can be
 * about this draft, and each arm carries its own answer to "what version was standing when he
 * wrote it" — the routed one carries it on the note (0014 put it there because
 * `gate_round.artifact_version` names another artifact for a routed note), and the one written
 * here IS `gate_round.artifact_version`, which is the same column read where it does apply.
 *
 * Private, because "a note standing here" is not a question anything should be asking: the desk
 * wants the ones from ELSEWHERE and the offer wants the ones still OWED, and a third caller
 * taking the raw list would be taking whichever of those two answers happened to suit.
 */
function notesStandingAgainst(store: Store, artifactId: string): StandingNote[] {
  return store
    .all<StandingRow>(
      `SELECT n.note, n.gate_id, n.round, n.depth, n.target, n.target_version, r.ruled_at,
              r.verdict,
              COALESCE(n.target_version, gr.artifact_version) AS landed_at,
              g.artifact_id AS from_id, from_art.kind AS from_kind, art.version AS at_version
         FROM gate_note n
         JOIN gate_ruling r ON r.gate_id = n.gate_id AND r.round = n.round
         JOIN gate_round gr ON gr.gate_id = n.gate_id AND gr.round = n.round
         JOIN gate g ON g.id = n.gate_id
         JOIN artifact from_art ON from_art.id = g.artifact_id
         JOIN artifact art ON art.id = ?
        -- Both verbs that leave a note behind (0015). A close is a rejection that stops
        -- rather than reopening, and what it leaves standing against the artifact is the
        -- same row read the same way — otherwise putting a draft down would end the run,
        -- free the episode and quietly drop the only record of why he stopped.
        WHERE r.verdict IN ('reject', 'close')
          AND ((n.target = ? AND n.target_version IS NOT NULL)
               OR (g.artifact_id = ? AND (n.target IS NULL OR n.target_version IS NULL)))
        ORDER BY r.ruled_at DESC, n.seq DESC`,
      artifactId,
      artifactId,
      artifactId,
    )
    .map((row) => ({
      note: row.note,
      gateId: row.gate_id,
      round: row.round,
      verdict: row.verdict,
      depth: row.depth,
      targetId: artifactId,
      landedAtVersion: row.landed_at,
      fromArtifactId: row.from_id,
      fromKind: row.from_kind,
      ruledAt: row.ruled_at,
      addressed: row.at_version > row.landed_at,
    }))
}

/**
 * **Every note routed to this artifact from somewhere else** — the DESK's question
 * (`write-context.ts`).
 *
 * A note whose gate was over the artifact it names is deliberately not here: that is an
 * ordinary rejection of this artifact with a depth written on it, and `write-context.ts` has
 * read those since E4-0. Counting it twice would print Ryan's words to a writer twice.
 */
export const routedNotesTo = (store: Store, artifactId: string): RoutedNote[] =>
  notesStandingAgainst(store, artifactId)
    .filter((note) => note.fromArtifactId !== artifactId && note.depth !== null)
    .map((note) => ({
      ...note,
      depth: note.depth as NoteDepth,
      routedAtVersion: note.landedAtVersion,
    }))

/**
 * **Every note this artifact still owes an answer to** — the OFFER's question, and the other
 * half of the split issue #76 was filed for (`runner/write-step.ts`, `edit.ts`, `app.ts`).
 *
 * It asks about the ARTIFACT and not about where Ryan was standing, so it keeps the notes he
 * wrote at the artifact's own gate: the unrouted default, a scene of it, and a depth that
 * resolved to this very artifact. That difference is the whole of #76 — a **presenting** gate
 * has no producer behind it, so every note it can write is one of those, and read through the
 * desk's exclusion they vanished, leaving an episode holding an artifact no writing gate ever
 * approved with no door out of its lifecycle stop. The desk's exclusion is right where it is
 * and was not weakened to fix this; the second question got its own function instead.
 *
 * **Answered means a newer version exists, and nothing else** — the same rule E4-5 wrote for a
 * routed note, applied here rather than re-decided. A later ruling over the same words is a
 * ruling on the draft, not an answer to the note: what the note asked for is a rewrite, and
 * until one lands the stage that writes this artifact still owes it.
 */
export const notesOwedBy = (store: Store, artifactId: string): StandingNote[] =>
  notesStandingAgainst(store, artifactId).filter((note) => !note.addressed)

/**
 * What the reopened offer says, in Ryan's own words — the note quoted, and where he gave it.
 *
 * The quote is the load-bearing part: "there is a note on this" is a button that sends him to
 * go and find out what he said, which is the archaeology the HIL contract forbids (4.6). The
 * newest is quoted and the rest counted, because a button has room for one.
 */
export function routedNoteSentence(notes: readonly StandingNote[], subject: string): string {
  const [newest, ...rest] = notes
  if (!newest) return ''
  const where = `${newest.fromKind} gate`
  // Which verb left it, in the button's own words (0015). "You sent this back from the script
  // gate" and "you put this down at its own gate" send Ryan to two different memories, and a
  // button that told him the wrong one is the archaeology the quote exists to prevent.
  const one = newest.verdict === 'close' ? `the note you put it down with at the ${where}` : `your note from the ${where}`
  const what = rest.length === 0 ? one : `${notes.length} notes from the ${where}`
  return `${subject} has ${what} standing against it — rewriting reads it: “${newest.note}”`
}

interface StandingRow {
  note: string
  gate_id: string
  round: number
  verdict: 'reject' | 'close'
  depth: NoteDepth | null
  target: string | null
  target_version: number | null
  /** The version the artifact stood at when the note landed — off the note, or off the round. */
  landed_at: number
  ruled_at: string
  from_id: string
  from_kind: ArtifactKind
  /** What the artifact stands at now. */
  at_version: number
}
