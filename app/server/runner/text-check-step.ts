import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectLLMCost, type CostProjection } from '../cost.ts'
import type { Store } from '../db/store.ts'
import { artifactsOf, type Artifact, type ArtifactKind } from '../domain/artifact.ts'
import type { CheckPass } from '../domain/finding.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import {
  categoryChecksFor,
  composeTextCheck,
  readTextCheckReply,
  recordTextCheck,
  waypointChecksFor,
  type ComposedCheck,
  type PriorNote,
} from '../domain/text-check.ts'
import type { LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import type { Stage, StageCatalogue, Step, StepContext } from './step.ts'

/**
 * Checking an artifact against canon, as a step (2.2, 4.1) — **the semantic tier's paid
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
 * ## One step, every check, and one transaction at the end
 *
 * The step convenes every check the artifact's kind and provenance reach — one per category
 * (4.1), plus one per arc position the episode declares (D8) — calls the model once each,
 * and records nothing until every reply has parsed. That is `board-rules.ts`'s rule with
 * money attached: a tier is one run, and a half-recorded one would tell E3-6 that one check
 * fires less often than its sibling. It also means a broken reply leaves the library exactly
 * as it found it, so a retry starts from a clean sheet rather than from a partial verdict.
 *
 * The cost of that is the retry's: a reply that fails to parse re-runs the whole tier, so a
 * script whose fifth check breaks pays for the first four again. It is bounded — three
 * attempts in all, invariant 5 — and it is the honest trade against filing half a run.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network. To watch a real check read a real script, on real
 * money, by hand:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     # then POST the run: {"episodeId": "<ep01>", "stage": "text-checks"}
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates
 * and writes Ryan's own library. The tier costs one Opus call per check; `textCheckProjection`
 * is what the button says before he clicks.
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

/** The button's sentence for a whole tier: "6 Opus calls, ~$…". */
export function textCheckProjection(checks: number): CostProjection {
  return projectLLMCost({ ...TEXT_CHECK_CALL, calls: checks })
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

/** What the step hands on, and what the gate room's verdict board renders (4.5). */
export interface TextCheckReport {
  artifactId: string
  /** How many checks ran. Every one records a pass, including the silent ones. */
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
  return { name: TEXT_CHECK_STAGE, steps: [checkTextAgainstCanon(library, TEXT_CHECK_KIND)] }
}

/**
 * Reads one artifact against the canon it declares it touches, once per check.
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
    name: `check-the-${kind}-against-canon`,

    async execute(context: StepContext): Promise<TextCheckReport> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const artifact = requireArtifact(context.store, context.episodeId, kind, label)
      const text = readFileSync(join(library.artifactDir, artifact.filePath!), 'utf8')

      // Every check this artifact convenes: the categories its kind and provenance both
      // reach (4.1), then the arc positions its episode declares (D8). An episode that
      // touches no arc is vanilla and simply adds none.
      const subjects = [
        ...categoryChecksFor(context.store, artifact),
        ...waypointChecksFor(context.store, artifact),
      ]
      if (subjects.length === 0) {
        context.progress(
          `Nothing checks the ${label} ${kind}: it declares no canon in scope and its episode ` +
            'declares no arc position. That is a vanilla artifact, not a failure.',
        )
        return { artifactId: artifact.id, checks: 0, findings: 0, gaps: 0, tally: [] }
      }

      context.progress(
        `Checking the ${label} ${kind} v${artifact.version} against canon — ` +
          `${subjects.length} checks, ${textCheckProjection(subjects.length).sentence}`,
      )

      // ── Every call first, and nothing recorded until they all parse ──────────
      const answered: { composed: ComposedCheck; findings: ReturnType<typeof readTextCheckReply> }[] = []
      for (const [index, subject] of subjects.entries()) {
        const composed = composeTextCheck(context.store, { artifact, text, subject, priorNotes })
        context.progress(
          `${index + 1} of ${subjects.length} · ${subject.label} — ` +
            `${composed.scope.length} facts in scope` +
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
      ? `${passes.length} checks read the ${label} ${kind} and found nothing — recorded, ` +
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

function requireArtifact(
  store: Store,
  episodeId: string,
  kind: ArtifactKind,
  label: string,
): Artifact {
  const artifact = artifactsOf(store, episodeId).find(
    (candidate) => candidate.kind === kind && candidate.slot === '',
  )
  if (!artifact?.filePath) {
    throw new Error(
      `${label} has no ${kind} to check. Checks fire at artifact boundaries and never ` +
        'continuously (4.1) — there is no boundary here yet.',
    )
  }
  return artifact
}
