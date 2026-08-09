import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE, projectLLMCost, type CostProjection } from '../cost.ts'
import type { Store } from '../db/store.ts'
import { artifactsOf, type Artifact, type ArtifactKind } from '../domain/artifact.ts'
import { dismissalNotes, type CheckPass } from '../domain/finding.ts'
import { panelFor, verdictBoard } from '../domain/panel.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import {
  composeTextCheck,
  readTextCheckReply,
  recordTextCheck,
  WAYPOINT_CHECK_KEY,
  type CheckSubject,
  type ComposedCheck,
  type PriorNote,
} from '../domain/text-check.ts'
import type { LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'

/**
 * Convening a panel over one artifact, as a step (2.2, 4.1, 4.5) — **the semantic tier's paid
 * half, and it is all paid.**
 *
 * The deterministic tier's split does not apply here and there is deliberately no free
 * sibling stage: a board rule re-runs over rows for nothing, and a category check is a
 * reading. Re-checking after a rewrite costs a call, which is why D14's scene-scoped
 * re-check exists (E3-5) — narrow what is re-read rather than pretend it is free.
 *
 * **No lock.** A cloud model call holds no GPU, and `image-api` is for cloud IMAGE steps
 * (D20).
 *
 * ## What one step convenes
 *
 * Every reviewer `panelFor` reaches: one per category whose declaration names this artifact
 * kind and whose entities are in its provenance (4.1), one per arc position the episode
 * declares (D8), and the craft reviewers this kind is read by — story-craft mandatory (D13).
 * They arrive as one list of `CheckSubject`, so this step calls one composer and one parser
 * and has no idea which kind of reviewer it is running.
 *
 * The DETERMINISTIC verdicts are not convened here. They are `continuity-board-checks`, they
 * cost nothing, and they have their own button; the panel's verdict board READS them where
 * they stand (`panel.ts`) rather than re-running a reading this stage was not asked to buy.
 *
 * ## What every reviewer is told that Ryan already said (4.4, E3-5)
 *
 * Each prompt carries the dismissal notes standing against THAT check, read off
 * `finding_disposition` by `dismissalNotes` (finding.ts). "Dismissed-finding notes feed future
 * runs' context" is the rule, and this is the seam it lands on: a reviewer that raised
 * something Ryan put down last episode argues against his note this time instead of in
 * ignorance of it. It may still re-raise — checks argue (invariant 3) — and E3-6 counts what
 * it does either way.
 *
 * ## The retry granularity: TIER ATOMIC, deliberately (E3-4's ruling)
 *
 * Every call first; nothing recorded until every reply has parsed; then one transaction.
 * At panel scale that is expensive and the number is not hidden: ten reviewers, one garbage
 * reply, three attempts (invariant 5) is thirty calls — and inside E3-3's correction loop
 * that is per ROUND, so a script that argues to the bound can pay it three times. The test
 * `re-calls every reviewer on the retry` asserts the thirty, so nobody discovers it in a
 * ledger.
 *
 * The alternative was per-reviewer recording: write each pass as it parses, and let a retry
 * fill the gaps only (N + 2 calls, the shape `extractTheContinuityBoard` already uses for
 * tokens). It was **rejected**, for three reasons in descending order of weight:
 *
 *   1. **The correction loop reads rows to decide whether a draft has been read**, and its
 *      predicate is "a pass exists at this version" (`correction-loop.ts`). Partial rows make
 *      that predicate LIE on exactly the path it exists for: a loop step re-entered after a
 *      failed attempt would see the version already checked, skip the panel, and open a gate
 *      over a draft three reviewers never read. Fixing it means teaching the generic loop
 *      what a complete panel is — coupling the loop to this file — or adding a completeness
 *      seam to `Step`, which is runner machinery bought for a money optimisation.
 *   2. **A panel cannot be split into runner steps at all.** The loop runs its check by
 *      calling `check.execute(context)` inside its own step, so per-reviewer steps could not
 *      run where the cost actually compounds — and a step list that varies with a convened
 *      roster is a stage assembled from data, which is the shape the Archon rule refuses.
 *   3. Retrying one reviewer INSIDE the step would be a second retry counter beside the
 *      runner's, and it would multiply rather than replace it (3 attempts × 3). The two
 *      loops this app has are already kept apart on purpose (`correction-loop.ts`); a third
 *      is not a granularity change, it is a bound nobody can state.
 *
 * What atomicity buys is the property invariant 4 is about: **there is no such thing as half
 * a verdict board.** Every convened reviewer has a row or the whole run failed loudly with
 * its attempt history — never eight green rows and two absences that read as a short panel.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network. To watch a real panel read a real script, on real
 * money, by hand:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     # then POST the run: {"episodeId": "<ep01>", "stage": "text-checks"}
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates
 * and writes Ryan's own library. The panel costs one Opus call per convened reviewer;
 * `panelProjection` is what the button says before he clicks.
 */

/** The stage name, as it is persisted on `run.stage` and as the API takes it. */
export const TEXT_CHECK_STAGE = 'text-checks'

/**
 * The artifact kind this stage checks. A sibling stage for the outline is this same step
 * function with a different kind and its own name in the catalogue — TypeScript and a test,
 * never a row that describes which artifact to read (the Archon rule).
 */
export const TEXT_CHECK_KIND: ArtifactKind = 'script'

/**
 * What ONE check costs, deliberately generous against what it actually sends (cost.ts): a
 * whole script, the canon in scope, and a reading back. A projection that under-states is a
 * button that lies cheaply; over-stating is the safe direction, and the ledger afterwards is
 * what was really spent.
 */
export const TEXT_CHECK_CALL = { promptTokens: 14000, outputTokens: 2000 } as const

/** What the button says, and what it is made of. */
export interface PanelProjection {
  /** Every row the board will carry — the paid reviewers and the free ones together. */
  reviewers: number
  /** The ones that cost a model call. */
  calls: number
  /** The deterministic rules already standing on this artifact's board. They cost nothing. */
  free: number
  cost: CostProjection
  /** "10 reviewers · 10 Opus calls, ~$1.20" — the tail of E3-7's button sentence. */
  sentence: string
}

/**
 * What convening this panel will cost, per convened reviewer, before Ryan clicks.
 *
 * Priced off `MODEL_PRICE`'s rate card through the one projection path in the app, so that
 * "~$1.20" and the rows it becomes are the same arithmetic (cost.ts). Every text-tier
 * reviewer is estimated at the same generous call: a craft reviewer's prompt is smaller,
 * because it carries no canon (D13), and over-stating is the safe direction for a number on
 * a button.
 *
 * **A gap never renders as a zero.** If the model has no rate-card row the sentence says
 * cost unknown and names it, rather than summing ten unpriced calls to $0.00 — which is the
 * one number on this screen that would be a lie rather than an estimate.
 */
export function panelProjection(
  store: Store,
  artifact: Artifact,
  options: { model?: string } = {},
): PanelProjection {
  const calls = panelFor(store, artifact).length
  const free = verdictBoard(store, artifact).rows.filter(
    (row) => row.tier === 'deterministic',
  ).length
  const cost = projectLLMCost({ ...TEXT_CHECK_CALL, calls, ...(options.model && { model: options.model }) })

  const freely =
    free === 0
      ? ''
      : `; the ${free} deterministic board rule${free === 1 ? '' : 's'} on it are free and already run`
  return {
    reviewers: calls + free,
    calls,
    free,
    cost,
    // The button owns "verb + object + scope" and prefixes this with an em dash, so the
    // separator here is a middle dot: "Convene the ep01 panel — 10 reviewers · 10 Opus
    // calls, ~$1.20".
    sentence: `${calls + free} reviewers · ${cost.sentence}${freely}`,
  }
}

/**
 * Extraction was `low` because transcription is not thinking. This is the opposite: the tier
 * 4.2 calls "strong; high confidence; self-corrects before reaching Ryan" is the one that has
 * to hold three facts and a scene in mind at once and decide whether they contradict. Thinking
 * is what the money buys here.
 */
export const TEXT_CHECK_EFFORT: LLMEffort = 'high'

/** A tier of findings is a page of JSON, not a script. */
export const TEXT_CHECK_MAX_TOKENS = 8000

/**
 * What the step hands on. It is a tally of the run, NOT the verdict board — the board is a
 * read over rows (`panel.ts`) and this is a record of what one panel did. They agree the
 * moment the step returns and diverge the moment Ryan dismisses something, which is why only
 * one of them is stored.
 */
export interface TextCheckReport {
  artifactId: string
  /** How many reviewers ran. Every one records a pass, including the silent ones. */
  checks: number
  findings: number
  /** What could not be checked at all — the third answer, counted separately on purpose. */
  gaps: number
  tally: { check: string; findings: number; gaps: number }[]
}

export function textCheckStages(library: LibraryPaths): StageCatalogue {
  return { [TEXT_CHECK_STAGE]: textCheckStage(library) }
}

function textCheckStage(library: LibraryPaths): Stage {
  return {
    name: TEXT_CHECK_STAGE,
    // It reads the script and records what the panel said (step.ts, `STAGE_WORK`). D12's wall
    // does not stand in front of it: a reading is how a contradiction gets answered, not
    // something built on top of one.
    work: 'reads',
    steps: [checkTextAgainstCanon(library, TEXT_CHECK_KIND)],
    offerOn: (store, episode): StageOffer => {
      const label = episodeLabel(episode.number)
      const artifact = artifactOf(store, episode.id, TEXT_CHECK_KIND)
      if (!artifact) {
        return {
          sentence: `Convene the panel over the ${label} ${TEXT_CHECK_KIND}`,
          cost: FREE,
          callsModel: false,
          nothingToDoBecause: noArtifactBecause(label, TEXT_CHECK_KIND),
        }
      }

      // The roster, counted as Ryan reads it: the categories that argue with canon, the arc
      // positions the episode declared, and the reviewers that read it as craft (D13). Three
      // different kinds of reading, and a button that said "10 reviewers" would hide which.
      const roster = panelFor(store, artifact)
      const projection = panelProjection(store, artifact)
      return {
        sentence:
          `Check the ${label} ${TEXT_CHECK_KIND} v${artifact.version} — ` +
          `${rosterSentence(roster)} read it, ${projection.sentence}`,
        cost: projection.cost.sentence,
        // Every convened reviewer is a call. There is no free half of this tier and there is
        // deliberately no free sibling stage: a board rule re-reads rows, a category check
        // re-reads a script.
        callsModel: roster.length > 0,
        nothingToDoBecause:
          roster.length === 0
            ? `Nothing convenes over the ${label} ${TEXT_CHECK_KIND}: it declares no canon in ` +
              'scope, its episode declares no arc position, and nothing reads this kind as ' +
              'craft. That is a vanilla artifact, not a failure (4.1) — and not a clean ' +
              'reading either.'
            : null,
      }
    },
  }
}

/**
 * "6 category checks, 1 arc position and 3 craft reviewers" — the roster in the words 4.5
 * convenes it with.
 *
 * Told apart by what each one is handed rather than by a kind column: a craft reviewer is the
 * one given no canon at all (`readsCanon: false`, D13), and an arc position is the one whose
 * key is the waypoint check's. That is the same three-way composition `panelFor` makes, read
 * back out of it — a fourth field naming the kind would be a second place for it to be wrong.
 */
function rosterSentence(roster: readonly CheckSubject[]): string {
  const craft = roster.filter((subject) => subject.readsCanon === false).length
  const arcs = roster.filter(
    (subject) => subject.readsCanon !== false && subject.key === WAYPOINT_CHECK_KEY,
  ).length
  const categories = roster.length - craft - arcs
  const parts = [
    categories > 0 ? `${categories} category check${plural(categories)}` : '',
    arcs > 0 ? `${arcs} arc position${plural(arcs)}` : '',
    craft > 0 ? `${craft} craft reviewer${plural(craft)}` : '',
  ].filter((part) => part !== '')

  if (parts.length === 0) return 'nobody'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

const plural = (count: number): string => (count === 1 ? '' : 's')

/**
 * Convenes the panel over one artifact: every reviewer, one call each, one transaction.
 *
 * The precondition is checked in the step and not only in the UI, because "preconditions
 * before the button" is a promise about screens and this is what makes it keepable: an
 * episode with no script has nothing to check, and saying so beats a run that spends a call
 * to find out.
 */
export function checkTextAgainstCanon(
  library: LibraryPaths,
  kind: ArtifactKind,
  priorNotes: PriorNote[] = [],
): Step<TextCheckReport> {
  return {
    // Stable across code changes, because a resume matches persisted rows to code by it —
    // and it carries the kind, so a sibling outline stage reads as itself in the log.
    //
    // It was `check-the-<kind>-against-canon` until E3-4. The name moved because the step
    // did: a panel convenes craft reviewers that are handed no canon at all (D13), and a log
    // line claiming otherwise would be a lie about what was read. Nothing in a shipped
    // library is orphaned by it — the only persisted step rows are dev fixtures.
    name: `convene-the-${kind}-panel`,

    async execute(context: StepContext): Promise<TextCheckReport> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const artifact = requireArtifact(context.store, context.episodeId, kind, label)
      const text = readFileSync(join(library.artifactDir, artifact.filePath!), 'utf8')

      // Every reviewer this artifact convenes (4.5): the categories its kind and provenance
      // both reach (4.1), the arc positions its episode declares (D8), and the craft
      // reviewers its kind is read by (D13). An episode that touches no arc is vanilla and
      // simply adds none.
      const subjects = panelFor(context.store, artifact)
      if (subjects.length === 0) {
        context.progress(
          `No panel convenes over the ${label} ${kind}: it declares no canon in scope, its ` +
            'episode declares no arc position, and nothing reads this kind as craft. That is ' +
            'a vanilla artifact, not a failure.',
        )
        return { artifactId: artifact.id, checks: 0, findings: 0, gaps: 0, tally: [] }
      }

      context.progress(
        `Convening the panel over the ${label} ${kind} v${artifact.version} — ` +
          panelProjection(context.store, artifact).sentence,
      )

      // ── Every call first, and nothing recorded until they all parse ──────────
      const answered: { composed: ComposedCheck; findings: ReturnType<typeof readTextCheckReply> }[] = []
      for (const [index, subject] of subjects.entries()) {
        // 4.4's other half, wired: what Ryan has already put down about THIS check rides the
        // prompt (E3-5). The step fetches them and hands them over rather than the composer
        // going and finding its own, so "what was this check told" is answerable from here.
        // The notes handed in at construction ride with them — a caller with context of its
        // own is not overruled by the ledger's.
        const composed = composeTextCheck(context.store, {
          artifact,
          text,
          subject,
          priorNotes: [
            ...priorNotes,
            ...dismissalNotes(context.store, { showId: where.show.id, checkKey: subject.key }),
          ],
        })
        context.progress(
          `${index + 1} of ${subjects.length} · ${subject.label} — ` +
            // A craft reviewer's zero is not a category check's zero: it was handed no canon
            // on purpose (D13), and "0 facts in scope" would read as a scope that came up
            // empty. Two different silences, and the line Ryan watches says which.
            (subject.readsCanon === false
              ? 'reading it as craft, with no canon in front of it'
              : `${composed.scope.length} facts in scope`) +
            (composed.gaps.length > 0
              ? `, and ${composed.gaps.length} it could not check: ` +
                composed.gaps.map((gap) => gap.detail).join(' ')
              : ''),
        )

        const completion = await context.llm.complete({
          system: composed.system,
          prompt: composed.prompt,
          maxTokens: TEXT_CHECK_MAX_TOKENS,
          effort: TEXT_CHECK_EFFORT,
        })
        // Throws on anything it cannot verify, which fails the step. Deliberately NOT caught:
        // the runner owns retry, and a check that swallowed a broken read would file a clean
        // pass over it (invariant 4).
        answered.push({ composed, findings: readTextCheckReply(completion.text, composed) })
      }

      const passes = context.store.transaction(() =>
        answered.map(({ composed, findings }) => recordTextCheck(context.store, composed, findings)),
      )

      const tally = passes.map((pass) => ({
        check: pass.checkKey,
        findings: pass.findingCount,
        gaps: pass.gapCount,
      }))
      context.progress(sentenceFor(label, kind, passes))
      return {
        artifactId: artifact.id,
        checks: passes.length,
        findings: total(passes, (pass) => pass.findingCount),
        gaps: total(passes, (pass) => pass.gapCount),
        tally,
      }
    },
  }
}

/**
 * What Ryan reads when the tier is done. The three answers are kept apart in the sentence the
 * same way they are kept apart in the schema — found something, found nothing, could not look
 * — because collapsing them on a screen would undo what 0012 exists to prevent.
 */
function sentenceFor(label: string, kind: ArtifactKind, passes: CheckPass[]): string {
  const findings = total(passes, (pass) => pass.findingCount)
  const gaps = total(passes, (pass) => pass.gapCount)

  const said =
    findings === 0
      ? `${passes.length} reviewers read the ${label} ${kind} and found nothing — recorded, ` +
        'because a clean run is a measurement'
      : `${findings} finding(s) on the ${label} ${kind}: ` +
        passes
          .filter((pass) => pass.findingCount > 0)
          .map((pass) => `${pass.checkKey} ×${pass.findingCount}`)
          .join(', ')

  return gaps === 0
    ? said
    : `${said}. And ${gaps} thing(s) it could not check at all — canon has not decided them, ` +
      'so no rewrite would answer one'
}

const total = (passes: CheckPass[], of: (pass: CheckPass) => number): number =>
  passes.reduce((sum, pass) => sum + of(pass), 0)

// ── Preconditions ───────────────────────────────────────────────────────────────

function requireEpisode(store: Store, episodeId: string): EpisodeInShow {
  const where = episodeInShow(store, episodeId)
  if (!where) throw new Error(`no such episode: ${episodeId}`)
  return where
}

/** The episode's artifact of this kind, or undefined when there is none on the volume. */
export function artifactOf(
  store: Store,
  episodeId: string,
  kind: ArtifactKind,
): Artifact | undefined {
  const artifact = artifactsOf(store, episodeId).find(
    (candidate) => candidate.kind === kind && candidate.slot === '',
  )
  return artifact?.filePath ? artifact : undefined
}

/** One sentence, two readers — the disabled button states it, the step throws it. */
export const noArtifactBecause = (label: string, kind: ArtifactKind): string =>
  `${label} has no ${kind} to check. Checks fire at artifact boundaries and never ` +
  'continuously (4.1) — there is no boundary here yet.'

function requireArtifact(
  store: Store,
  episodeId: string,
  kind: ArtifactKind,
  label: string,
): Artifact {
  const artifact = artifactOf(store, episodeId, kind)
  if (!artifact) throw new Error(noArtifactBecause(label, kind))
  return artifact
}
