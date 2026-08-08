import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  costOfRun,
  projectLLMCost,
  spentSentence,
  type CostProjection,
  type CostTotals,
} from '../cost.ts'
import { artifactsOf, recordArtifact, reviseArtifact, type Artifact } from '../domain/artifact.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import { boardStages } from './board-step.ts'
import type { Stage, StageCatalogue, Step, StepContext } from './step.ts'
import { textCheckStages } from './text-check-step.ts'

/**
 * The stage catalogue: the map from a persisted `run.stage` back to the TypeScript that
 * is the stage. A restarted process has a row saying `stage = 'produce-shot-images'` and
 * needs the function again; this file is that lookup, and the stages themselves.
 *
 * **Archon.** A stage is added here by writing TypeScript and a test — never by adding a
 * row, a YAML file, a JSON pipeline, or an upload. If this file ever grows a loader, a
 * schema, or a way to describe a stage in data, that is the failure mode this project
 * exists to escape, and it should be deleted rather than extended. The one thing the
 * catalogue takes is the library volume, because steps write files into it and a stage
 * that reached for `process.env` instead could not be run against a temp volume in a test.
 *
 * The real stages arrive with the work they do:
 *   E3 · write   — premise, outline, script, scene delineation
 *   E4 · canon   — checks, proposals, ratification sweeps
 *   E6 · produce — shot manifest, image generation, TTS takes, mix
 *   E7 · assemble — timeline, render, publish kit
 *
 * ── The demo stage, and what it is for ──────────────────────────────────────────
 * `demo` is E1's own, and the only stage E1 ships. It is the thing Ryan operates to prove
 * the spine end to end: one real model call, one artifact on the volume, one gate he rules
 * on, one row in the cost ledger, and a run that survives having its process killed. It is
 * two steps because the epic exit says two — and because a run that stops at the gate
 * would never prove that a ruling sends it onward.
 *
 * It is a real stage, not a mock: it spends Ryan's real money, through the same adapter,
 * priced by the same table, gated by the same primitive. Which is exactly why the call is
 * small (`DEMO_MAX_TOKENS`, `effort: low`) and why the button says what it will cost
 * before he clicks it.
 */

/** The stage name, as it is persisted on `run.stage` and as the API takes it. */
export const DEMO_STAGE = 'demo'

/**
 * The slot the demo writes into. An episode may already have a real `premise-brief` — ep01
 * of the fixture does — and the demo must never land on top of it: `UNIQUE (episode_id,
 * kind, slot)` keeps them apart, and a hand-made asset always wins (D20).
 */
export const DEMO_SLOT = 'demo'

/**
 * The ceiling on one call. Small on purpose: this is a demonstration, it is Ryan's money,
 * and a runaway that thinks for forty thousand tokens would be a bill rather than a demo.
 * `effort: 'low'` is the other half — Opus 5 thinks by default and thinking is billed as
 * output, so a low effort keeps the ceiling from being eaten before a word is written.
 */
export const DEMO_MAX_TOKENS = 700
export const DEMO_EFFORT: LLMEffort = 'low'

/**
 * What the launch button states before the click. Deliberately generous against the prompt
 * this actually sends — a projection that under-states is a button that lies cheaply, and
 * over-stating is the safe direction (cost.ts). The ledger afterwards is what was spent.
 */
export const DEMO_CALL: CostProjection = projectLLMCost({
  promptTokens: 400,
  outputTokens: 350,
})

/** What step one hands step two. Also what the gate room and the page render. */
export interface DemoDraft {
  artifactId: string
  /** Relative to the library's artifact dir — the same string as `artifact.file_path`. */
  filePath: string
  round: number
  /** How the round that closed this was ruled: 'approve' or 'override'. */
  verdict: 'approve' | 'override'
  /** False when the round's draft was already on the volume and was kept (D20). */
  called: boolean
  /** The model stopped at the ceiling: what is on the volume is cut off mid-sentence. */
  truncated: boolean
}

/** What step two returns: the run, closed, with what it cost. */
export interface DemoClose extends DemoDraft {
  spend: CostTotals
  sentence: string
}

export function stageCatalogue(library: LibraryPaths): StageCatalogue {
  // E3-1's two, and the split between them is the point: `continuity-board` reads the
  // script with a model and costs money, `continuity-board-checks` re-runs the same
  // deterministic rules over the rows it wrote for nothing. Both are TypeScript in
  // `board-step.ts` — the catalogue is a lookup, never a place stages are described.
  //
  // `text-checks` is the semantic tier beside them, and it has no free half: a category
  // check is a reading, and every re-check is a call (`text-check-step.ts`). E3-4 grew it
  // into a PANEL — the categories, the arc positions and the craft reviewers convened as
  // one verdict board (4.5) — which changed what one run of the stage convenes and not what
  // the stage is. The deterministic rules stay on their own free stage above; the board
  // reads them where they stand rather than paying to re-run them.
  return {
    [DEMO_STAGE]: demoStage(library),
    ...boardStages(library),
    ...textCheckStages(library),
  }
}

function demoStage(library: LibraryPaths): Stage {
  return {
    name: DEMO_STAGE,
    steps: [writeTheDemoPremise(library), tallyTheDemoSpend()],
  }
}

// ── Step one: the call, the artifact, the gate ──────────────────────────────────

/**
 * Writes one paragraph, files it on the volume, and presents it for Ryan's ruling — the
 * three things the epic exit needs in one step.
 *
 * They are one step because a gate belongs to the step that PRODUCED its artifact
 * (gate.ts): a rejection sends the run back into this same step, which finds the notes,
 * writes again, and presents round 2. Split the call from the gate and a rejection would
 * re-enter a step with nothing to rewrite.
 *
 * **No lock.** It is a cloud model call: it holds no GPU, and `image-api` is for cloud
 * IMAGE steps (D20). A lock held across a gate would starve every other episode for as
 * long as Ryan took to look at it, which is the one thing D7's locks must never do.
 */
function writeTheDemoPremise(library: LibraryPaths): Step<DemoDraft> {
  return {
    name: 'write-the-demo-premise',

    async execute(context: StepContext): Promise<DemoDraft> {
      const where = episodeInShow(context.store, context.episodeId)
      if (!where) throw new Error(`no such episode: ${context.episodeId}`)
      const label = episodeLabel(where.episode.number)

      const standing = context.gate()
      const ruled = standing?.ruling

      // ── Back in on a ruling ──────────────────────────────────────────────────
      // Approved (or overridden): the work is done and on the volume. Nothing is re-run
      // and nothing is re-spent — which is precisely what the kill-and-resume drill is
      // watching for, because a fresh start would put a second call in the ledger.
      if (ruled && ruled.verdict !== 'reject') {
        const filed = demoArtifact(context, where.episode.id)
        if (!filed?.filePath) {
          throw new Error(
            `${label}'s demo premise was ruled "${ruled.verdict}" but its artifact is no ` +
              'longer in the library. There is nothing to carry on with.',
          )
        }
        context.progress(
          `${ruled.verdict === 'override' ? 'Overridden' : 'Approved'} at round ${standing!.round}` +
            ' — nothing rewritten, nothing re-spent',
        )
        return {
          artifactId: filed.id,
          filePath: filed.filePath,
          round: standing!.round,
          verdict: ruled.verdict,
          called: false,
          truncated: false,
        }
      }

      const round = ruled ? standing!.round + 1 : (standing?.round ?? 1)
      const filePath = join(
        where.show.key,
        `s${pad(where.season.number)}e${pad(where.episode.number)}`,
        DEMO_SLOT,
        `premise-round-${round}.md`,
      )
      const onDisk = join(library.artifactDir, filePath)

      // ── The draft for this round ─────────────────────────────────────────────
      // Each round writes its own file, once. If this round's file is already there — a
      // crash between writing it and recording the gate, or Ryan's own hand — it is what
      // he rules on, and NO second call is made for it. Re-runs fill gaps only (D20), and
      // here that rule is worth money as well as bytes.
      let called = false
      let truncated = false
      if (existsSync(onDisk)) {
        context.progress(
          `Round ${round}'s draft was already in the library — kept as it stands, and no ` +
            'second call made for it',
        )
      } else {
        context.progress(
          `Writing the ${label} demo premise — ${DEMO_CALL.sentence}` +
            (ruled ? `, against your ${ruled.notes.length} note(s) from round ${round - 1}` : ''),
        )
        const completion = await context.llm.complete({
          system: DEMO_SYSTEM,
          prompt: demoPrompt(where, ruled?.notes.map((note) => note.note) ?? []),
          maxTokens: DEMO_MAX_TOKENS,
          effort: DEMO_EFFORT,
        })
        called = true
        // 'max_tokens' means the paragraph stops mid-sentence. It was paid for and it is
        // real, so it is filed — but Ryan is told, here and on the gate, rather than
        // handed a truncated artifact that looks finished.
        truncated = completion.stopReason === 'max_tokens'
        if (truncated) {
          context.progress(
            `The model hit the ${DEMO_MAX_TOKENS}-token ceiling — what follows stops mid-sentence`,
          )
        }
        mkdirSync(dirname(onDisk), { recursive: true })
        // Belt and braces with the check above: the same rule, said once for the money and
        // once for the bytes. Nothing this app writes may land on a file already there.
        writeIfAbsent(onDisk, `${completion.text.trim()}\n`)
      }

      // ── The artifact row ─────────────────────────────────────────────────────
      // Version tracks round, so "round 2" and "premise-brief demo v2" are the same fact
      // said twice, and the gate's round history reads straight. Re-entering a round it
      // has already revised for changes nothing — steps are idempotent because they will
      // be re-run.
      let artifact = demoArtifact(context, where.episode.id)
      artifact ??= recordArtifact(context.store, {
        episodeId: where.episode.id,
        kind: 'premise-brief',
        slot: DEMO_SLOT,
        filePath,
        // Provenance, declared honestly (invariant 2): this prompt carries no canon at
        // all — not an entity, not a fact, not a rule — so it touches nothing. An empty
        // declaration is a declaration; a missing one is a guess.
        touches: [],
      })
      if (artifact.version < round) {
        artifact = reviseArtifact(context.store, artifact.id, {
          summary: `rewritten against ${ruled!.notes.length} note(s) from round ${round - 1}`,
          filePath,
        })
      }

      context.openGate({
        artifactId: artifact.id,
        payload: {
          round,
          words: readFileSync(onDisk, 'utf8').trim().split(/\s+/).length,
          calledTheModel: called,
          truncated,
        },
      })
    },
  }
}

// ── Step two: what it cost, and that the run carried on ─────────────────────────

/**
 * Closes the run with what it spent. In a real stage this is where the next production
 * step goes; here its job is to exist on the far side of the gate, so that a ruling
 * visibly sends the run onward rather than merely un-pausing it. It calls no model, takes
 * no lock, and is safe to run as many times as a crash makes it run.
 */
function tallyTheDemoSpend(): Step<DemoClose> {
  return {
    name: 'tally-the-demo-spend',
    inputs: ['write-the-demo-premise'],

    async execute(context: StepContext): Promise<DemoClose> {
      const draft = context.input<DemoDraft>('write-the-demo-premise')
      const spend = costOfRun(context.store, context.runId)
      const sentence =
        `${draft.verdict === 'override' ? 'Overridden' : 'Approved'} at round ${draft.round} · ` +
        spentSentence(spend)
      context.progress(sentence)
      return { ...draft, spend, sentence }
    },
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────────

const DEMO_SYSTEM =
  'You are helping a showrunner test a production pipeline end to end. Answer in plain ' +
  'prose: no preamble, no heading, no bullet points, no quotation marks around the answer.'

/**
 * One small prompt, carrying the episode's own identity and nothing else.
 *
 * It sends **no canon** — no entity, no fact, no house style. That is what makes the
 * artifact's empty provenance honest, and it is the line between this demo and E3's real
 * writing steps, which load exactly the entities in scope (invariant 2) and will compose
 * their prompts in their own files.
 */
function demoPrompt(where: EpisodeInShow, notes: readonly string[]): string {
  const season = `season ${where.season.number}${where.season.title ? ` ("${where.season.title}")` : ''}`
  const lines = [
    `Show: "${where.show.title}" — ${season}, episode ${where.episode.number}, "${where.episode.title}".`,
    `That episode is at the "${where.episode.lifecycle}" stage of its lifecycle.`,
    '',
    'Write one paragraph of at most 70 words: the premise this episode\'s title suggests,',
    'in the register of a quiet, salt-worn working drama. Invent no proper nouns beyond',
    'the ones above. Return the paragraph and nothing else.',
  ]
  if (notes.length > 0) {
    lines.push(
      '',
      'The showrunner read your last attempt and rejected it. His notes, verbatim:',
      ...notes.map((note) => `- ${note}`),
      '',
      'Write it again, answering every note. Return the paragraph and nothing else.',
    )
  }
  return lines.join('\n')
}

// ── Rows ────────────────────────────────────────────────────────────────────────

/** This episode's demo artifact, or undefined before the first round wrote one. */
function demoArtifact(context: StepContext, episodeId: string): Artifact | undefined {
  return artifactsOf(context.store, episodeId).find(
    (artifact) => artifact.kind === 'premise-brief' && artifact.slot === DEMO_SLOT,
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')
