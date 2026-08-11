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
import { episodeInShow, episodeLabel, scenesOf, type EpisodeLifecycle, type Scene } from './domain/spine.ts'
import { sceneSpans } from './domain/text-check.ts'
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
 * ## Editing ONE SCENE is that same motion aimed at a span (D14, E5-2)
 *
 * `mockups/episode-room.html` puts an "edit scene" affordance on every row of the scene grid,
 * and D14 rules that a scene is addressable. **Neither of those is a second way to write
 * bytes.** `editScene` below resolves the scene's span through `sceneSpans` — the same
 * resolver `panel.ts` anchors findings with, so "where does scene 3 start" has one answer in
 * this app — splices Ryan's words into the whole draft, and hands the WHOLE draft to
 * `editArtifact`. Everything downstream is unchanged: verbatim text, re-delineation, the free
 * tier's receipt at the new version, freshness computed off the edges.
 *
 * The one thing it adds is the **touched scene**, and that is not the guess the paragraph
 * below refuses. A whole-artifact edit names no scene because narrowing it would be this file
 * deciding what Ryan meant; a scene edit names one because he *said* which scene he was
 * typing over. Staleness then lands where the edit did — the shots built on scene 3 go stale
 * and the other eight do not — which is `applyRewrite`'s rule (`remediation.ts`) reached by
 * the other door.
 *
 * A span that cannot be located is refused rather than guessed at. `sceneSpans` answers
 * "the whole artifact" for a heading it cannot find, which is right for placing a finding and
 * catastrophic for placing a splice — it would replace the entire draft with one scene.
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
 *     #   POST /api/artifact/<id>/edit  {text, sceneId}  → the same motion, aimed at one scene
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates and
 * writes Ryan's own library (#49).
 */

/** The kinds Ryan writes, and therefore the kinds he may edit — the writing line's own three. */
export const EDITABLE_KIND: readonly ArtifactKind[] = WRITE_STEP.map(producedBy)

/**
 * The one precondition the PAGE owns, because it lives in a textarea this process has never
 * seen — and it is one string with two readers, which is why it is a constant rather than a
 * sentence a screen writes.
 *
 * `nothingNewBecause` opens its refusal with these exact words and then says what an empty
 * version would cost, so a disabled button and a 409 cannot tell Ryan two different stories
 * about the same rule (`CHECK_REFUSALS`'s shape, and its reason).
 */
export const EDIT_REFUSALS = {
  needsText:
    'Type the draft first — an edit lands what is in the box word for word (D20), and an ' +
    'empty box is not a deletion you meant.',
} as const

export type EditRefusals = typeof EDIT_REFUSALS

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
  /**
   * The scene this edit was aimed at, as it stood when the revision was written — null for a
   * whole-artifact edit, which touches everything and says so.
   *
   * It is read back off the re-delineated draft where it survived, so a heading Ryan renamed
   * on the way past reports the row that is there now rather than the one that went.
   */
  touchedScene: { id: string; ordinal: number; heading: string } | null
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
  request: { artifactId: string; text: string; sceneId?: string },
): ArtifactEdited {
  const artifact = requireArtifact(store, request.artifactId)
  const blocked =
    editBlockedBecause(store, library, artifact) ??
    nothingNewBecause(library, artifact, request.text)
  if (blocked) throw new Error(blocked)

  const where = episodeInShow(store, artifact.episodeId)!
  const label = episodeLabel(where.episode.number)
  const scene =
    request.sceneId === undefined
      ? undefined
      : scenesOf(store, artifact.episodeId).find((one) => one.id === request.sceneId)

  const landed = landNewVersion(store, library, {
    artifact,
    text: request.text,
    // Declared inside the motion, before the free tier reads: the structural checks read
    // provenance, so entering it afterwards would have them read the draft he replaced.
    touches: namedIn(store, artifact, request.text),
    // A whole-artifact edit names NO scene, on purpose: everything built on it is stale, and
    // narrowing it to the scenes that happen to differ would be this file guessing at what he
    // meant — guessing wide is the safe direction (`remediation.ts`). A SCENE edit names one,
    // because he said which scene he was typing over; that is his answer, not a guess.
    ...(scene && { touchedScenes: [scene.id] }),
    summary: scene ? `you edited scene ${scene.ordinal} by hand` : 'you edited it by hand',
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
    scenes: (landed.scenes ?? []).map((one) => ({
      id: one.id,
      ordinal: one.ordinal,
      heading: one.heading,
    })),
    // Read back off the re-delineated draft: a heading he renamed on the way past took the old
    // row with it (E4-3), and reporting the row that went would name a scene nobody can open.
    touchedScene: sceneNow(store, artifact.episodeId, scene),
    read: landed.read.map((pass) => ({
      checkKey: pass.checkKey,
      artifactId: pass.artifactId,
      artifactVersion: pass.artifactVersion,
      findings: pass.findingCount,
    })),
    wall: landed.wall,
    stale,
    lifecycle: where.episode.lifecycle,
    sentence: editedSentence(label, landed, stale.length, where.episode.lifecycle, scene),
  }
}

/** The scene as it stands AFTER a re-delineation, or null when it did not survive one. */
function sceneNow(
  store: Store,
  episodeId: string,
  scene: Scene | undefined,
): { id: string; ordinal: number; heading: string } | null {
  if (!scene) return null
  const now = scenesOf(store, episodeId).find((one) => one.id === scene.id)
  return now ? { id: now.id, ordinal: now.ordinal, heading: now.heading } : null
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
  scene: Scene | undefined,
): string {
  const found = landed.read.reduce((sum, pass) => sum + pass.findingCount, 0)
  const scenes =
    landed.scenes === undefined
      ? ''
      : ` It breaks into ${landed.scenes.length} scene${landed.scenes.length === 1 ? '' : 's'}, ` +
        'derived from what you typed.'
  // The touched scene, named — because that is what decides where staleness landed, and a
  // sentence that said "3 artifact(s) went stale" without saying what he touched would leave
  // him to work out which three (4.6).
  const touched =
    scene === undefined
      ? ''
      : ` You typed over scene ${scene.ordinal}, “${scene.heading}”, and the revision names it — ` +
        'so what was built on that scene is what went stale.'

  return (
    `Your ${label} ${landed.artifact.kind} is on the volume as v${landed.artifact.version}, word ` +
    `for word.${touched}${scenes} ${landed.read.length} deterministic check(s) read it for ` +
    `nothing before this came back and ${found === 0 ? 'found nothing in it' : `raised ${found}`}, ` +
    `and ${stale === 0 ? 'nothing downstream went stale' : `${stale} artifact(s) went stale`}. ` +
    `${label} is still at ${lifecycle} — an approval is the only thing that moves an episode on.`
  )
}

// ── One scene of it, which is the same motion aimed at a span (D14, E5-2) ────────

/** One scene of a script, with the span the edit box opens on and the door that lands it. */
export interface SceneToEdit {
  sceneId: string
  ordinal: number
  heading: string
  /** The scene's own span of the draft, as the volume holds it. '' when it cannot be located. */
  text: string
  /** Type over this scene. Free, verbatim, and the same one motion (`landNewVersion`). */
  edit: Offer
}

/**
 * **Every scene of this episode's script, with its span and its door** — the read behind the
 * scene grid's "edit scene" affordance (5.2).
 *
 * The span comes from `sceneSpans`, which is where a scene's extent is decided in this app —
 * the same resolver `clusterFindings` anchors a finding with. A second way of asking "where
 * does scene 3 start" would eventually disagree with the first, and the one that disagreed
 * would be the one splicing bytes.
 */
export function scenesToEdit(
  store: Store,
  library: LibraryPaths,
  artifactId: string,
): SceneToEdit[] {
  const artifact = requireArtifact(store, artifactId)
  const scenes = scenesOf(store, artifact.episodeId)
  const text = draftOnTheVolume(library, artifact)

  return scenes.map((scene): SceneToEdit => {
    const block = blockOf(text, scenes, scene)
    return {
      sceneId: scene.id,
      ordinal: scene.ordinal,
      heading: scene.heading,
      text: block === null ? '' : text!.slice(block.from, block.to),
      edit: sceneEditOffer(store, library, artifact, scene, block !== null),
    }
  })
}

/**
 * **A scene's span, widened to its own LINES** — from the start of the line its heading sits
 * on, to the start of the line the next scene's heading sits on. Null when the heading is not
 * in the draft at all.
 *
 * `sceneSpans` is still the resolver, and this is the one documented adjustment to its answer.
 * It resolves to the heading TEXT, which is exactly right for anchoring a finding — a quote
 * search starts where the words start — and exactly wrong for a splice: a script writes its
 * heading as `## 3 · INT. NO. 4 LOCK — 07:05` (`domain/delineate.ts`), so a span opening at
 * `INT.` leaves `## 3 · ` outside the block and takes `## 4 · ` off the scene after it.
 * Splicing over that pair writes a draft whose scenes cannot be read out of it — which
 * `delineateScript` refuses, loudly and before a byte lands, which is how this was found.
 */
function blockOf(
  text: string | null,
  scenes: readonly Scene[],
  scene: Scene,
): { from: number; to: number } | null {
  if (text === null || !text.includes(scene.heading)) return null
  const span = sceneSpans(text, [...scenes]).find((one) => one.scene.id === scene.id)
  if (span === undefined) return null
  return {
    from: startOfLine(text, span.from),
    to: span.to >= text.length ? text.length : startOfLine(text, span.to),
  }
}

/** Where the line holding `at` begins. */
const startOfLine = (text: string, at: number): number =>
  text.lastIndexOf('\n', Math.max(0, at - 1)) + 1

/**
 * **Lands Ryan's words over one scene**, by splicing them into the whole draft and handing the
 * whole draft to `editArtifact`. There is deliberately no second write path here: this
 * function produces a string, and every byte that reaches the volume goes through the one
 * motion (`landNewVersion`).
 */
export function editScene(
  store: Store,
  library: LibraryPaths,
  request: { artifactId: string; sceneId: string; text: string },
): ArtifactEdited {
  const artifact = requireArtifact(store, request.artifactId)
  const scenes = scenesOf(store, artifact.episodeId)
  const scene = scenes.find((one) => one.id === request.sceneId)
  const text = draftOnTheVolume(library, artifact)
  // Resolved against EVERY scene, never against this one alone: a block ends where the next
  // heading's line begins, and a single-scene resolution would run to the end of the draft and
  // swallow every scene after it.
  const block = scene === undefined ? null : blockOf(text, scenes, scene)

  const blocked = sceneEditBlockedBecause(store, library, artifact, scene, block !== null)
  if (blocked) throw new Error(blocked)

  return editArtifact(store, library, {
    artifactId: artifact.id,
    text: text!.slice(0, block!.from) + request.text + text!.slice(block!.to),
    sceneId: scene!.id,
  })
}

/** What the scene's edit button says, and why it cannot be pressed. One composer, two readers. */
function sceneEditOffer(
  store: Store,
  library: LibraryPaths,
  artifact: Artifact,
  scene: Scene,
  located: boolean,
): Offer {
  const label = labelOf(store, artifact.episodeId)
  const blocked = sceneEditBlockedBecause(store, library, artifact, scene, located)
  return {
    sentence:
      `Edit scene ${scene.ordinal} of the ${label} ${artifact.kind} yourself — what you type ` +
      `lands word for word inside the draft as v${artifact.version + 1}, the scenes are ` +
      're-derived from what you typed, and the free checks read the whole draft before the ' +
      'button comes back',
    cost: FREE,
    enabled: blocked === null,
    blockedBecause: blocked,
  }
}

/**
 * Why this scene cannot be typed over, in the words the disabled button shows and `editScene`
 * refuses with. Null when it can.
 *
 * The first two are about scenes and the third is `editBlockedBecause`, whole — an edit of a
 * scene is an edit of the artifact, so every precondition on the artifact stands here too and
 * is quoted rather than restated.
 */
function sceneEditBlockedBecause(
  store: Store,
  library: LibraryPaths,
  artifact: Artifact,
  scene: Scene | undefined,
  located: boolean,
): string | null {
  if (!scene) {
    return (
      `That scene does not belong to this episode. Scenes are derived from the written ` +
      'episode (D3), and an edit narrows an artifact to one of its own.'
    )
  }
  if (artifact.kind !== 'script') {
    return (
      `Only a script breaks into scenes (D3), and this is a ${artifact.kind}. Edit the whole ` +
      'draft instead — the door beside it does exactly that, and costs the same nothing.'
    )
  }
  const blocked = editBlockedBecause(store, library, artifact)
  if (blocked) return blocked
  if (!located) {
    return (
      `Scene ${scene.ordinal} is recorded as “${scene.heading}” and that heading is not in the ` +
      `${artifact.kind} on the volume, so there is no span to type over. A scene IS its heading ` +
      '(E4-3) — edit the whole draft, and the scenes are re-derived from what you type.'
    )
  }
  return null
}

/** The draft itself, off the volume, or null when there is nothing there to read. */
function draftOnTheVolume(library: LibraryPaths, artifact: Artifact): string | null {
  if (artifact.filePath === null) return null
  try {
    return readFileSync(join(library.artifactDir, artifact.filePath), 'utf8')
  } catch {
    return null
  }
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
    // It opens with the page's own refusal, verbatim, so the disabled button and this 409 are
    // one rule said once — and then says what an empty version would actually cost.
    return (
      `${EDIT_REFUSALS.needsText} An empty ${artifact.kind} is not a draft — there is nothing ` +
      'for a check to read or a gate to render, and a version that says nothing still stales ' +
      'everything built on it. Putting the work down is abandoning the episode, which is its ' +
      'own verb (3.3).'
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
