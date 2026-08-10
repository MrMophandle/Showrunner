import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE } from './cost.ts'
import type { Store } from './db/store.ts'
import {
  artifactFreshness,
  artifactsOf,
  findArtifact,
  provenanceOf,
  type Artifact,
  type ArtifactKind,
  type FreshnessStatus,
  type StaleReason,
} from './domain/artifact.ts'
import { entitiesOfShow } from './domain/canon.ts'
import { notesOwedBy, type StandingNote } from './domain/routing.ts'
import { episodeInShow, episodeLabel, type EpisodeLifecycle } from './domain/spine.ts'
import { nameAppearingIn, producedBy, WRITE_STEP } from './domain/write-context.ts'
import type { LibraryPaths } from './library.ts'
import type { Offer } from './operating.ts'
import { landNewVersion, targetTakenBecause, type LandedVersion } from './remediation.ts'
import { runsOfEpisode } from './runner/run.ts'

/**
 * **Ryan's hand** (E4-5, #65; 1.1, D20, D21): editing a written artifact directly, and the
 * whole of what that is allowed to be.
 *
 * An edit is a hand-made asset. **His text lands verbatim** — character for character, with
 * whatever spacing, headings and half-finished sentences he typed — because "a hand-made asset
 * always wins" (D20) and an edit that tidied his wording on the way in would be the app having
 * an opinion at the one gate where it is not entitled to one. There is no cleanup, no reflow,
 * no trailing newline it did not have.
 *
 * ## It is E3-5's ONE MOTION, generalized — and that is the only way it may be built
 *
 * `landNewVersion` (`remediation.ts`) is the motion, and this file is its second caller.
 * Revise, re-delineate a script's scenes, and let the free deterministic tier read the new
 * version — all inside one transaction, so **at no point observable to any reader does a
 * version exist that nothing has read.** The E3 constraints ledger's first entry was written
 * about this issue by name: "a version nobody has read looks identical to a version read
 * clean, and the wall cannot tell the difference from findings alone" (D12). The `check_pass`
 * at the new version is the receipt.
 *
 * The two rules it inherits whole, rather than re-deciding:
 *
 *   * **A script edit re-delineates** (E4-3). A heading still there is the same scene wherever
 *     it has moved to; a renamed heading is a NEW scene and the old one goes, taking its
 *     anchors down to the whole artifact rather than migrating them onto prose nobody checked.
 *     A draft whose scenes cannot be read out of it is refused before a byte is written.
 *   * **Files are never overwritten.** `script-v2.md` lands beside `script.md`; a path already
 *     taken stops the motion in words rather than being written over (D20).
 *
 * ## What an edit does NOT do, and every one of these was chosen
 *
 * **It does not move the lifecycle.** The column names the stage an episode is AT, and an
 * APPROVAL is the only thing that moves it (`domain/lifecycle.ts`, E4-1). Editing the outline
 * of an episode sitting at `script` leaves it at `script` and makes the script *stale* — the
 * column says where work is, and staleness carries the truth about what is behind it. Nothing
 * in this file writes a lifecycle, and nothing writes a stale flag either: freshness is a
 * computation over the edges the revision moved (1.3).
 *
 * **It does not re-run E4-4's extraction, and it never will.** The script stage buys one paid
 * reading of the draft Ryan APPROVED and raises what it claims of canon (`runner/claim-step.ts`).
 * A hand edit is not an approval, and a door that spent a model call would break the one
 * promise on this button — "no model call · $0.00" — which is invariant 5 read literally. So
 * the canon consequences of his own edit are his to raise at the bench (#39's add-a-fact door,
 * `canon-bench.ts`) or nobody's. **It was chosen, not forgotten**, and E4-6's sweep collects
 * whatever is riding the episode either way.
 *
 * **It does not launder a finding.** The free tier re-reads, so an edit that leaves a
 * contradiction in place meets the same wall on the far side: the rule fires again, the
 * byte-identical twin comes back open, and Ryan's standing dismissal reaches it exactly as it
 * reaches any other twin (E3-6, `domain/concern.ts`). A NEW contradiction his own words
 * introduce walls normally. His hand is not a fourth door through D12's wall — it is the third
 * one (a new version, read) arriving by another route.
 *
 * ## What it DOES declare: provenance, out of what he wrote
 *
 * Invariant 2 runs backwards for anyone who writes: there is no upstream declaration to read,
 * because this is the act that makes one. So the edited text is matched against canon through
 * the desk's own matcher (`nameAppearingIn`) and what it names is added to what the artifact
 * declares it touches — E4-1's rule, pointed at Ryan's hand. Without it the free tier would
 * read the provenance of the draft he replaced.
 *
 * **The slice is the whole show, and that is the one place his hand differs from a writer's.**
 * A writer may only declare what the desk handed it, because an entity it was never handed is
 * canon nobody read. Ryan was handed the show. An edit that names a location no desk would
 * have offered is him putting it in the episode on purpose, and a check that could not see it
 * would be reading an episode he did not write.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network, and this door never would anyway:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     #   GET  /api/operating                       → every written artifact, with its edit offer
 *     #   POST /api/artifact/<id>/edit  {text}       → free, verbatim, and one motion
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates and
 * writes Ryan's own library (#49).
 */

/** The kinds Ryan writes, and therefore the kinds he may edit — the writing line's own three. */
export const EDITABLE_KIND: readonly ArtifactKind[] = WRITE_STEP.map(producedBy)

/** What one edit landed, and what had already read it when this returned. */
export interface ArtifactEdited {
  artifactId: string
  kind: ArtifactKind
  /** The version his text landed as. */
  version: number
  /** The new draft on the volume. The one it replaced is still beside it (D20). */
  filePath: string
  /** The scenes the draft breaks into, re-derived. Empty for every kind but the script. */
  scenes: { id: string; ordinal: number; heading: string }[]
  /** Every free deterministic pass that read the new version. **The receipt.** */
  read: { checkKey: string; artifactId: string; artifactVersion: number; findings: number }[]
  /** Whether the next stage may start on this episode now, in D12's words. Null: it may. */
  wall: string | null
  /** What is stale now, each with the sentence that names why. Computed, never set (1.3). */
  stale: { artifactId: string; kind: ArtifactKind; slot: string; because: string }[]
  /** Where the episode stands. An edit never moves it — an approval does (E4-1). */
  lifecycle: EpisodeLifecycle
  sentence: string
}

/**
 * **Lands Ryan's text as a new version of a written artifact, as one act.**
 *
 * Every precondition is asked in the sentence `editOffer` was already showing, which is what
 * makes "preconditions before the button" true rather than decorative (D15).
 */
export function editArtifact(
  store: Store,
  library: LibraryPaths,
  request: { artifactId: string; text: string },
): ArtifactEdited {
  const artifact = requireArtifact(store, request.artifactId)
  const blocked =
    editBlockedBecause(store, library, artifact) ??
    nothingNewBecause(library, artifact, request.text)
  if (blocked) throw new Error(blocked)

  const where = episodeInShow(store, artifact.episodeId)!
  const label = episodeLabel(where.episode.number)
  const landed = landNewVersion(store, library, {
    artifact,
    text: request.text,
    // Declared inside the motion, before the free tier reads: the structural checks read
    // provenance, so entering it afterwards would have them read the draft he replaced.
    touches: namedIn(store, artifact, request.text),
    // No scene named, on purpose: an edit is of the whole artifact, so everything built on it
    // is stale. Narrowing it to the scenes that happen to differ would be this file guessing
    // at what he meant, and guessing wide is the safe direction (`remediation.ts`).
    summary: 'you edited it by hand',
    subject: `The ${label} ${artifact.kind}`,
  })

  const stale = landed.stale.map((one) => ({
    artifactId: one.artifact.id,
    kind: one.artifact.kind,
    slot: one.artifact.slot,
    because: staleSentence(store, one.artifact, one.reasons),
  }))

  return {
    artifactId: landed.artifact.id,
    kind: landed.artifact.kind,
    version: landed.artifact.version,
    filePath: landed.filePath,
    scenes: (landed.scenes ?? []).map((scene) => ({
      id: scene.id,
      ordinal: scene.ordinal,
      heading: scene.heading,
    })),
    read: landed.read.map((pass) => ({
      checkKey: pass.checkKey,
      artifactId: pass.artifactId,
      artifactVersion: pass.artifactVersion,
      findings: pass.findingCount,
    })),
    wall: landed.wall,
    stale,
    lifecycle: where.episode.lifecycle,
    sentence: editedSentence(label, landed, stale.length, where.episode.lifecycle),
  }
}

/**
 * What the edit button says, what it costs, and — when it cannot be pressed — why, in words,
 * before the click.
 *
 * One composer, two readers: `editArtifact` refuses with the same string (D15, and
 * `launchBlockedBecause`'s rule).
 */
export function editOffer(store: Store, library: LibraryPaths, artifactId: string): Offer {
  const artifact = requireArtifact(store, artifactId)
  const where = episodeInShow(store, artifact.episodeId)
  const label = where ? episodeLabel(where.episode.number) : 'this episode'
  const blocked = editBlockedBecause(store, library, artifact)

  return {
    sentence:
      `Edit the ${label} ${artifact.kind} yourself — what you type lands word for word as ` +
      `v${artifact.version + 1}, and the free checks read it before the button comes back`,
    // Nothing here calls a model, and that is the promise the header keeps: no re-extraction,
    // no re-drafting, no panel. The free deterministic tier is the only thing that runs.
    cost: FREE,
    enabled: blocked === null,
    blockedBecause: blocked,
  }
}

/** One written artifact of an episode, as a screen renders it: fresh or not, and the door. */
export interface WrittenArtifact {
  artifact: Artifact
  status: FreshnessStatus
  /** Why it is stale, in one sentence. Null when it is not. */
  staleBecause: string | null
  edit: Offer
  /**
   * Every note standing against this artifact that nothing has answered yet — the same
   * question the offer asks, so a screen and a button can never disagree about whether one
   * stands (D21, #76). Ryan's own gate rounds included: an edit is one of the two things that
   * can answer them, and the other is the stage that writes it (`domain/routing.ts`).
   */
  standing: StandingNote[]
}

/**
 * **Every written artifact this episode has**, with its freshness, its edit door, and any
 * routed note standing against it.
 *
 * The one read behind the episode card's artifacts panel (5.2), composed here where the
 * sentences have tests rather than in JSX where they would not.
 */
export function writtenArtifacts(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
): WrittenArtifact[] {
  const freshness = new Map(
    artifactFreshness(store, episodeId).map((one) => [one.artifact.id, one]),
  )
  return artifactsOf(store, episodeId)
    .filter((artifact) => EDITABLE_KIND.includes(artifact.kind))
    .map((artifact) => {
      const held = freshness.get(artifact.id)!
      return {
        artifact,
        status: held.status,
        staleBecause:
          held.status === 'stale' ? staleSentence(store, artifact, held.reasons) : null,
        edit: editOffer(store, library, artifact.id),
        standing: notesOwedBy(store, artifact.id),
      }
    })
}

// ── The sentences ───────────────────────────────────────────────────────────────

/**
 * **"built from a draft the outline has moved past"** — staleness, in words (1.3, 5.2).
 *
 * Composed from the edges rather than remembered beside them: what this artifact consumed,
 * what that input stands at now, and what the revisions in between said they did. The
 * revision summaries are the load-bearing part — "the ep01 outline stands at v2 now" is a
 * number, and "you edited it by hand" is the reason, which is what stops the sentence being
 * something Ryan has to go and investigate (4.6).
 */
export function staleSentence(
  store: Store,
  artifact: Artifact,
  reasons: readonly StaleReason[],
): string {
  const label = labelOf(store, artifact.episodeId)
  const subject = `The ${label} ${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`
  const moved = reasons.find((reason) => reason.kind === 'input-moved-on')

  if (!moved) {
    const [first] = reasons
    return first === undefined
      ? `${subject} is stale.`
      : `${subject} was built on the ${label} ${first.input.kind}, and that is stale itself — ` +
          'staleness travels down every edge it was built along (1.3).'
  }

  const said = moved.revisions.map((revision) => revision.summary).filter((one) => one !== '')
  const why = said.length === 0 ? 'it has been rewritten since' : said.join('; ')
  return (
    `${subject} was built from the ${label} ${moved.input.kind} v${moved.consumedVersion}, and ` +
    `the ${label} ${moved.input.kind} stands at v${moved.currentVersion} now — ${why}. It is ` +
    `stale until something is written from what the ${moved.input.kind} says now.`
  )
}

function editedSentence(
  label: string,
  landed: LandedVersion,
  stale: number,
  lifecycle: EpisodeLifecycle,
): string {
  const found = landed.read.reduce((sum, pass) => sum + pass.findingCount, 0)
  const scenes =
    landed.scenes === undefined
      ? ''
      : ` It breaks into ${landed.scenes.length} scene${landed.scenes.length === 1 ? '' : 's'}, ` +
        'derived from what you typed.'

  return (
    `Your ${label} ${landed.artifact.kind} is on the volume as v${landed.artifact.version}, word ` +
    `for word.${scenes} ${landed.read.length} deterministic check(s) read it for nothing before ` +
    `this came back and ${found === 0 ? 'found nothing in it' : `raised ${found}`}, and ` +
    `${stale === 0 ? 'nothing downstream went stale' : `${stale} artifact(s) went stale`}. ` +
    `${label} is still at ${lifecycle} — an approval is the only thing that moves an episode on.`
  )
}

// ── Preconditions ───────────────────────────────────────────────────────────────

/**
 * Why this artifact cannot be edited by hand, in the words the disabled button shows and the
 * act refuses with. Null when it can.
 *
 * The order is from what the artifact IS to what is happening around it, which is
 * `launchBlockedBecause`'s order and the useful one: "nobody writes one of those by hand" is
 * about the thing in front of him, and "a run holds this episode" is about the whole episode.
 */
function editBlockedBecause(
  store: Store,
  library: LibraryPaths,
  artifact: Artifact,
): string | null {
  if (!EDITABLE_KIND.includes(artifact.kind)) {
    return (
      `A ${artifact.kind} is not written by hand — it is derived from something that is, and ` +
      'editing it would put a reading on the volume that nothing read. The kinds that are ' +
      `yours to type are: ${EDITABLE_KIND.join(', ')}. Edit what this was built from, and ` +
      'rebuild it.'
    )
  }
  if (artifact.filePath === null) {
    return (
      `That ${artifact.kind} has been recorded but never produced, so there is no draft to ` +
      'edit. Write it first — the stage that writes it says what it costs before the click.'
    )
  }

  // D7's one-run-per-episode, in the same words `launchBlockedBecause` refuses a stage with.
  // A run holding this episode may be about to write this very artifact, or parked at a gate
  // over it, and an edit landing underneath either is a version arriving from two hands at
  // once. Ruling on it or letting it finish is the way through, exactly as it is for a stage.
  const busy = runsOfEpisode(store, artifact.episodeId).find((run) =>
    ['queued', 'running', 'paused'].includes(run.status),
  )
  if (busy) {
    const label = labelOf(store, artifact.episodeId)
    const doing =
      busy.status === 'paused'
        ? `is waiting on your ruling — ${busy.pauseReason ?? 'a gate is open'}`
        : `is ${busy.status}`
    return (
      `${label} already has a ${busy.stage} run, and it ${doing}. One run per episode (D7): ` +
      'rule on it, or let it finish, and then the draft is yours to type over.'
    )
  }

  return targetTakenBecause(library, artifact)
}

/** The two ways a submitted text is not a new draft: it is nothing, or it is the old one. */
function nothingNewBecause(
  library: LibraryPaths,
  artifact: Artifact,
  text: string,
): string | null {
  if (text.trim() === '') {
    return (
      `An empty ${artifact.kind} is not a draft — there is nothing for a check to read or a ` +
      'gate to render, and a version that says nothing still stales everything built on it. ' +
      'Putting the work down is abandoning the episode, which is its own verb (3.3).'
    )
  }
  if (readFileSync(join(library.artifactDir, artifact.filePath!), 'utf8') === text) {
    return (
      `That is the ${artifact.kind} already on the volume, character for character. A version ` +
      'that changes nothing still spends a version and stales everything built on it.'
    )
  }
  return null
}

// ── Reading ─────────────────────────────────────────────────────────────────────

function requireArtifact(store: Store, artifactId: string): Artifact {
  const artifact = findArtifact(store, artifactId)
  if (!artifact) throw new Error(`No such artifact: ${artifactId}`)
  return artifact
}

/**
 * **The entities his text names — out of the whole show, and that is the difference.**
 *
 * A writer declares provenance out of what it wrote, matched against the entities the DESK
 * handed it, because an entity a writer was never handed is canon nobody read (E4-1). Ryan is
 * not a writer with a desk: he is the showrunner, the whole bible is his, and an edit naming a
 * location the desk would have left out is him putting it in the episode deliberately. So the
 * slice is the show's and the MATCHER is still the desk's — `nameAppearingIn`, so that "named
 * in" means one thing in this app (`write-context.ts`).
 *
 * Additive, like every provenance write: what is already declared rides through untouched, and
 * an edit that stops mentioning somebody has not un-touched them.
 */
function namedIn(store: Store, artifact: Artifact, text: string): string[] {
  const where = episodeInShow(store, artifact.episodeId)
  if (!where) return []
  const already = new Set(provenanceOf(store, artifact.id).map((entity) => entity.id))
  return entitiesOfShow(store, where.show.id)
    .filter((entity) => !already.has(entity.id))
    .filter((entity) => nameAppearingIn(text, entity) !== undefined)
    .map((entity) => entity.id)
}

const labelOf = (store: Store, episodeId: string): string => {
  const where = episodeInShow(store, episodeId)
  return where ? episodeLabel(where.episode.number) : 'this episode'
}
