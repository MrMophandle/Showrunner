import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { proposeFactChange } from './canon-bench.ts'
import { FREE, projectLLMCost, type CostProjection } from './cost.ts'
import type { Store } from './db/store.ts'
import {
  declareProvenance,
  findArtifact,
  reviseArtifact,
  staleArtifacts,
  type Artifact,
  type StaleArtifact,
} from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { boardOf } from './domain/board.ts'
import { delineateScript } from './domain/delineate.ts'
import { findFact } from './domain/fact.ts'
import {
  dismissalNotes,
  findFinding,
  findingsIn,
  type CheckPass,
  type Finding,
} from './domain/finding.ts'
import { panelFor } from './domain/panel.ts'
import type { Proposal } from './domain/proposal.ts'
import {
  delineateScenes,
  episodeInShow,
  episodeLabel,
  scenesOf,
  type EpisodeInShow,
  type Scene,
} from './domain/spine.ts'
import { runStructuralChecks } from './domain/structural.ts'
import {
  composeTextCheck,
  readTextCheckReply,
  recordTextCheck,
  sceneSpans,
  type CheckSubject,
  type ComposedCheck,
} from './domain/text-check.ts'
import { writeIfAbsent, type LibraryPaths } from './library.ts'
import type { CallSite, LLMAdapter, LLMEffort } from './llm/adapter.ts'
import type { LLMReadiness } from './llm/choose.ts'
import type { Offer } from './operating.ts'
import { stageBlockedBecause } from './runner/stage-wall.ts'

/**
 * The three buttons behind a finding (4.3): **rewrite the span, propose the canon change,
 * dismiss with note.** E3-7 renders them; this is what makes them true.
 *
 * **Every act here raises, revises, or records. Not one of them ratifies** (invariant 1).
 * The rewrite writes an artifact; the proposal lands on the queue and stops; the dismissal
 * writes a disposition. Nothing in this file calls `createProposalRulings`, and the day
 * something does, a check has written canon.
 *
 * ## The rewrite and its free re-check are ONE MOTION, and that is the whole of E3-3's amendment
 *
 * D12's wall counts open deterministic findings **anchored at the artifact's CURRENT version**
 * (`runner/stage-wall.ts`). That is sound while the only thing that lands a new version is the
 * correction loop, which re-runs the check tier over every draft it writes. A rewrite button
 * breaks it: land v2 and stop, and every finding standing against v1 drops out of the wall
 * before anything has read v2 — **never-checked rendering as checked-clean**, which is the
 * collapse invariant 4 exists to forbid and the three-kinds-of-nothing rule says out loud.
 *
 * So `applyRewrite` is one operation and there is deliberately no way to do half of it: it
 * revises the artifact, names the scene it touched, and **re-runs the free deterministic tier
 * over the new version inside the same transaction**. A `check_pass` at the current version is
 * the receipt that a reading happened, and until that row exists the transaction has not
 * committed — so at no point observable to any reader is the wall answering about a draft
 * nothing has read.
 *
 * The free tier is two things and both are re-run: `runStructuralChecks` over the revised
 * artifact (the canon-graph checks, which record their passes AT the new version — the
 * receipt), and `runBoardRules` over the episode's continuity board when that board was read
 * out of this artifact, because a board rule reads the BOARD and lands its finding in the
 * SCRIPT (E3-1), so it is part of what stands against this draft. Running the rules over a
 * board the script has moved past is the same act `continuity-board-checks` already offers as
 * a free stage, and it is the conservative direction: the board's word keeps the wall up until
 * somebody pays to re-extract it, and `panel.ts` renders those rows `stale` rather than green.
 *
 * The SEMANTIC re-check is not in the motion, and that is invariant 5 rather than an omission:
 * it costs a model call, so it is its own click with its own declared cost (D14, below).
 *
 * ## What a rewrite writes, and what it must not
 *
 * `reviseArtifact` and a file, and **nothing else** (1.3). No stale flag is set anywhere: the
 * board goes stale because freshness computes it from the revision's scene edge, and every
 * downstream artifact goes stale for the same reason. A rewrite that wrote a flag would be
 * remembered state, and it would lie the day a second edge moves.
 *
 * The new draft is a NEW FILE — `script-v2.md` beside `script.md`, never an overwrite. A
 * hand-made asset always wins (D20), every draft stays on the volume, and `writeIfAbsent` is
 * what enforces it: a target that already exists stops the motion rather than being written
 * over.
 *
 * ## Nothing applies itself
 *
 * `predraftRewrite` spends a model call and returns TEXT. It does not touch the artifact, it
 * writes no file, and it stores nothing — a draft that had already landed would not be a
 * draft. Ryan edits it or does not, and `applyRewrite` takes the replacement he settled on and
 * applies it **verbatim**: his edit is a hand-made asset and it wins over the model's words the
 * same way a hand-made still does (D20, invariant 5).
 *
 * ## Where the money goes when there is no run
 *
 * These are clicks, not steps: there is no run, no step row, and nothing to stream into —
 * `event.run_id` is NOT NULL (0003), which is the same reason a bench ruling appends no event
 * (`canon-bench.ts`). So the call site carries the EPISODE and the ledger walks the rest
 * (`recordCost`), the answer arrives whole rather than streamed, and the retry is bounded here
 * because the runner is not in the loop to bound it.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network — every call below is `createFakeLLM`. To watch a real
 * pre-draft rewrite a real span, on real money, by hand, with a finding already standing:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     # found the show, run `text-checks`, then, against a finding it raised:
 *     #   POST /api/finding/<id>/predraft            → one call, ~$0.0x
 *     #   POST /api/finding/<id>/rewrite  {replacement}   → free, and one motion
 *     #   POST /api/artifact/<id>/recheck {sceneId}       → one call per outstanding reviewer
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates and
 * writes Ryan's own library.
 */

// ── What one pre-draft costs, and how hard it thinks ────────────────────────────

/**
 * One span, its scene, and the finding that argued with it — deliberately generous against
 * what it actually sends (cost.ts). A projection that under-states is a button that lies
 * cheaply; over-stating is the safe direction, and the ledger afterwards is what was spent.
 */
export const REWRITE_CALL = { promptTokens: 4000, outputTokens: 800 } as const

/**
 * `high`, and it is worth saying why a span costs the same effort a whole check does: the
 * replacement has to answer the concern, keep the artifact's voice, and not contradict the
 * canon quoted at it — and a cheap rewrite that reintroduces the problem costs another round
 * of everything downstream, which is more than the difference.
 */
export const REWRITE_EFFORT: LLMEffort = 'high'

/** A replacement for one span is a paragraph, not a script. */
export const REWRITE_MAX_TOKENS = 2000

/**
 * One call and the two retries invariant 5 allows, and it is deliberately its own constant.
 *
 * `MAX_ATTEMPTS_PER_STEP` bounds a step the runner is retrying; `MAX_CORRECTION_ROUNDS` bounds
 * a producer arguing with its checks (`correction-loop.ts` says why those two are kept apart).
 * This bounds a button Ryan is standing in front of, where a fourth attempt is his click and
 * not the machine's. Three numbers, three decisions, and folding any two of them would make
 * changing one a change to the others.
 */
export const MAX_PREDRAFT_ATTEMPTS = 3

/**
 * What ONE scene-scoped re-check costs — **and the number is the whole of D14.**
 *
 * A panel reads the script; this reads the scene that was rewritten. That is the difference
 * between re-convening ten reviewers over ten thousand tokens and asking the one or two that
 * had something to say about scene 4 to read scene 4 again. The button states it, so the
 * saving is something Ryan can see rather than something the code believes.
 */
export const RECHECK_CALL = { promptTokens: 5000, outputTokens: 1500 } as const

// ── What the check bench renders (E3-7) ─────────────────────────────────────────

/**
 * 4.3's remediations, as offers: what each button says, what it costs, and — when it cannot
 * be pressed — why, in words, BEFORE the click.
 *
 * Four offers for three buttons, because the rewrite button is two acts and 4.3 says so:
 * "rewrite the span (pre-drafted, editable)". The pre-draft is the paid half and applying is
 * the free one, and keeping them apart on the screen is what makes "nothing applies itself"
 * something Ryan can see.
 */
export interface FindingRemediations {
  findingId: string
  artifactId: string
  /** The version the finding was raised against. */
  version: number
  /** The version the artifact stands at now. They differ once anything has been rewritten. */
  currentVersion: number
  sceneId: string | null
  /** The scene as the episode numbers it. Null: the finding is about the whole artifact. */
  scene: number | null
  /** The span, as the artifact writes it. '' when there is none to highlight (4.3). */
  quote: string
  /** Pre-draft a replacement for the span. Paid. */
  predraft: Offer
  /** Apply the draft Ryan settled on — revise, and re-read for free, as one motion. */
  apply: Offer
  /** Raise the canon change the finding's concern implies. Free, and it rules nothing. */
  propose: Offer
  /** Put it down with a note, which rides future runs (4.4). Free. */
  dismiss: Offer
}

export function remediationsFor(
  store: Store,
  library: LibraryPaths,
  findingId: string,
  llm?: LLMReadiness,
): FindingRemediations {
  const at = whereItStands(store, library, findingId)
  // The finding's own preconditions first, then the process's. That order is `launchOffer`'s
  // (operating.ts) and it is the useful one: "this span is gone" is about the work in front of
  // him, and "nothing to call" is a fact about the whole process that the page says once at
  // the top anyway.
  const blocked = rewriteBlockedBecause(at) ?? nothingToCall(llm)
  const cannotApply = rewriteBlockedBecause(at) ?? targetTakenBecause(library, at.artifact)
  const cannotPropose = proposeBlockedBecause(store, at)
  const projection = projectLLMCost({ ...REWRITE_CALL })
  const where = at.scene ? `scene ${at.scene.ordinal} of ${at.subject}` : at.subject

  return {
    findingId: at.finding.id,
    artifactId: at.artifact.id,
    version: at.finding.anchor.version,
    currentVersion: at.artifact.version,
    sceneId: at.finding.anchor.sceneId,
    scene: at.scene?.ordinal ?? null,
    quote: at.finding.anchor.quote,
    predraft: {
      sentence:
        `Pre-draft a rewrite of the ${at.finding.checkKey} span in ${where} — one span, ` +
        'editable before anything is applied',
      cost: `${projection.sentence} · your money, spent when you click`,
      enabled: blocked === null,
      blockedBecause: blocked,
    },
    apply: {
      sentence:
        `Apply the rewrite to ${where} — writes ${at.artifact.kind} v${at.artifact.version + 1} ` +
        'and re-runs the deterministic checks over it, as one act',
      // Applying spends nothing — the deterministic tier it re-runs is free — so a dead
      // adapter does not stand in its way. A draft Ryan wrote himself applies with no model
      // in the building, which is the whole of "a hand-made asset always wins" (D20).
      cost: FREE,
      enabled: cannotApply === null,
      blockedBecause: cannotApply,
    },
    propose: {
      sentence:
        `Propose the canon change behind the ${at.finding.checkKey} finding — a fact delta ` +
        'riding this episode, for your ruling in the queue',
      cost: FREE,
      enabled: cannotPropose === null,
      blockedBecause: cannotPropose,
    },
    dismiss: {
      sentence:
        `Dismiss the ${at.finding.checkKey} finding with your note — the note is read back ` +
        'by later writing runs, and counted against the check that raised it',
      cost: FREE,
      enabled: at.finding.disposition === null,
      blockedBecause:
        at.finding.disposition === null
          ? null
          : `That finding was already ${at.finding.disposition.kind} — ` +
            `“${at.finding.disposition.note}”. Every disposition is kept for good.`,
    },
  }
}

// ── Button one, first half: the pre-draft ───────────────────────────────────────

/** One attempt at the pre-draft, kept whether it worked or not (invariant 5). */
export interface PredraftAttempt {
  attempt: number
  /** Why it did not come back as a rewrite. Null on the one that did. */
  failure: string | null
  dollars: number
}

/** A replacement for one span, drafted and **not applied**. */
export interface Predraft {
  findingId: string
  artifactId: string
  /** The version it was drafted against. Applying refuses if the artifact has moved since. */
  version: number
  sceneId: string | null
  scene: number | null
  /** The span it would replace, as the artifact writes it today. */
  quote: string
  /** What the model wrote. Editable, and nothing has moved because it exists. */
  replacement: string
  /** One sentence on what it changed and how that answers the concern. */
  why: string
  /** Every attempt, in order. Three at most, and every one billed. */
  attempts: PredraftAttempt[]
  dollars: number
  sentence: string
}

/**
 * Drafts a replacement for one finding's span. **It moves nothing.**
 *
 * Bounded at `MAX_PREDRAFT_ATTEMPTS`, with every attempt kept and every attempt billed — a
 * reply that came back as prose rather than as a rewrite was still a call, and a ledger that
 * only recorded the successful ones would under-state a bad afternoon. Exhausting the bound
 * throws with the last failure, and the attempt history is on the error's own report.
 */
export async function predraftRewrite(
  store: Store,
  adapter: LLMAdapter,
  library: LibraryPaths,
  findingId: string,
): Promise<Predraft> {
  const at = whereItStands(store, library, findingId)
  const blocked = rewriteBlockedBecause(at)
  if (blocked) throw new Error(blocked)

  // No run, no step, nothing to stream into: `event.run_id` is NOT NULL (0003), so a click
  // outside a run has nowhere to put a chunk and the answer arrives whole. The episode is
  // what the money is charged to, and `recordCost` walks up to the show from there.
  const site: CallSite = {
    store,
    episodeId: at.artifact.episodeId,
    chunk: () => {},
  }

  const attempts: PredraftAttempt[] = []
  for (let attempt = 1; attempt <= MAX_PREDRAFT_ATTEMPTS; attempt += 1) {
    const completion = await adapter.complete(
      {
        system: PREDRAFT_SYSTEM,
        prompt: predraftPrompt(at),
        maxTokens: REWRITE_MAX_TOKENS,
        effort: REWRITE_EFFORT,
      },
      { ...site, attempt },
    )

    try {
      const drafted = readRewriteReply(completion.text, at.finding.anchor.quote)
      attempts.push({ attempt, failure: null, dollars: completion.dollars })
      const dollars = attempts.reduce((sum, one) => sum + one.dollars, 0)
      return {
        findingId: at.finding.id,
        artifactId: at.artifact.id,
        version: at.artifact.version,
        sceneId: at.finding.anchor.sceneId,
        scene: at.scene?.ordinal ?? null,
        quote: at.finding.anchor.quote,
        replacement: drafted.replacement,
        why: drafted.why,
        attempts,
        dollars,
        sentence:
          `A replacement for the span is drafted and nothing has been applied. It says it ` +
          `${lowerFirst(drafted.why)} — edit it or apply it as it stands; an edit applies ` +
          'word for word.',
      }
    } catch (error) {
      attempts.push({ attempt, failure: messageOf(error), dollars: completion.dollars })
      if (attempt === MAX_PREDRAFT_ATTEMPTS) {
        throw new Error(
          `The pre-draft did not come back as a rewrite in ${MAX_PREDRAFT_ATTEMPTS} attempts ` +
            'and every one of them is on the ledger. The last said: ' +
            `${messageOf(error)} Write the replacement yourself and apply it: a hand-made one ` +
            'always wins.',
        )
      }
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt. Stated rather than
  // asserted, because a `!` here would be a claim about a bound written three lines up.
  throw new Error('the pre-draft loop ended without an answer')
}

const PREDRAFT_SYSTEM =
  'You rewrite one span of one artifact of a television episode, to answer one reviewer’s ' +
  'concern about it. You change that span and nothing else, you keep the artifact’s own ' +
  'voice and formatting, and you never restate the concern in the prose. Return one JSON ' +
  'object and nothing else: no preamble, no code fence, no commentary.'

/**
 * The prompt: the concern, the canon it argues with, the scene the span sits in, and the span.
 *
 * **The scope is the finding's, not the artifact's.** What is loaded is the facts this finding
 * quotes — the ones it argued from — rather than everything the artifact declares it touches.
 * That is invariant 2 read strictly rather than loosely: this call answers ONE concern, and
 * whether the new words agree with the rest of canon is a question a check answers, which is
 * exactly what the scene-scoped re-check is for and why it is paid for separately.
 */
function predraftPrompt(at: Standing): string {
  const finding = at.finding
  const lines = [
    `Show: “${at.where.show.title}” · season ${at.where.season.number}, episode ` +
      `${at.where.episode.number}, “${at.where.episode.title}”.`,
    `Artifact: ${at.artifact.kind} v${at.artifact.version}${
      at.scene ? `, scene ${at.scene.ordinal}` : ''
    }.`,
    '',
    '## What the reviewer said about this span',
    '',
    `${finding.checkKey} · severity ${finding.severity} · confidence ${finding.confidence}`,
    '',
    finding.concern.trim(),
    '',
  ]

  if (finding.facts.length > 0) {
    lines.push(
      '## The canon it argues with',
      '',
      'These are established. The replacement has to live with them; it cannot change them —',
      'that is a proposal Ryan rules on, and it is a different button.',
      '',
      ...finding.facts.map((fact) => `- “${fact.statement}”`),
      '',
    )
  }

  lines.push(
    at.scene ? `## Scene ${at.scene.ordinal}, whole, for context` : `## The ${at.artifact.kind}`,
    '',
    at.sceneText.trim(),
    '',
    '## The span you are replacing, word for word',
    '',
    finding.anchor.quote,
    '',
    '## What to return',
    '',
    '```',
    '{',
    '  "replacement": "…",   // what stands where that span stands now. It is substituted for',
    '                        //   the span EXACTLY: nothing before it and nothing after it',
    '                        //   changes, so it has to read on from the words above it and',
    '                        //   into the words below it. Keep the formatting of what it',
    '                        //   replaces — a line of action stays a line of action.',
    '  "why": "…"            // one sentence: what you changed, and how that answers the',
    '                        //   concern. It is what the showrunner reads before applying.',
    '}',
    '```',
  )
  return lines.join('\n')
}

/**
 * Turns one reply into a replacement, or throws.
 *
 * The three refusals are the three ways a reply is not a rewrite: it is not JSON, it has no
 * replacement in it, or its replacement is the span it was asked to replace. The last one
 * matters most — a model that hands the span back has not failed loudly, and applying it would
 * spend a version, stale everything downstream, and re-run the checks to prove nothing changed.
 */
export function readRewriteReply(reply: string, quote: string): { replacement: string; why: string } {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(reply.trim())
  const body = (fenced ? fenced[1]! : reply).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `The answer did not come back as a rewrite — it is not JSON. It began: “${body.slice(0, 80)}…”`,
    )
  }

  const raw = parsed as Record<string, unknown>
  const replacement = typeof raw['replacement'] === 'string' ? raw['replacement'] : ''
  if (replacement.trim() === '') {
    throw new Error(
      'The answer has no `replacement` in it. An empty rewrite is a deletion, and a deletion ' +
        'is something the showrunner types rather than something a draft proposes.',
    )
  }
  if (replacement.trim() === quote.trim()) {
    throw new Error(
      'The answer handed the span back unchanged. A rewrite that changes nothing would still ' +
        'spend a version and stale everything built on it.',
    )
  }
  const why = typeof raw['why'] === 'string' ? raw['why'].trim() : ''
  if (why === '') {
    throw new Error(
      'The answer says nothing about what it changed. `why` is what the showrunner reads ' +
        'before applying, and a draft that cannot say what it did is not one he can rule on.',
    )
  }
  return { replacement, why }
}

// ── Button one, second half: the motion ─────────────────────────────────────────

/** One free deterministic reading of the new draft. The receipt, itemised. */
export interface DeterministicReading {
  checkKey: string
  /** What it read. The board's rules read the BOARD and land here (E3-1). */
  artifactId: string
  artifactVersion: number
  findings: number
}

/** What a rewrite landed, and what read it before the motion was over. */
export interface RewriteApplied {
  findingId: string
  artifactId: string
  /** The version the motion landed. */
  version: number
  /** The new draft on the volume. The old one is still beside it (D20). */
  filePath: string
  sceneId: string | null
  scene: number | null
  /**
   * Every deterministic pass the motion ran, before it returned. **This is the receipt** — a
   * `check_pass` at the current version is what tells "read and clean" from "nobody looked".
   */
  read: DeterministicReading[]
  /** Whether the next stage may start on this episode now, in D12's own words. Null: it may. */
  wall: string | null
  /**
   * What is stale in this episode now — asked of `staleArtifacts` at the moment the motion
   * returned, never set by it (1.3). It is the state after the revision rather than a diff of
   * it, because "what did this act stale" is not a question the edges answer and a remembered
   * before-and-after would be the flag this design refuses.
   */
  stale: { artifactId: string; kind: string; slot: string }[]
  /** The paid half this motion deliberately did not run (D14, invariant 5). */
  recheck: Offer
  sentence: string
}

/**
 * **Applies a rewrite, as one act.** Revise the artifact, name the scene it touched, and
 * re-read the new draft with every deterministic check that costs nothing — in one
 * transaction, so there is no committed state in which the new version exists and nothing has
 * read it.
 *
 * The replacement is applied **verbatim**. Whatever Ryan settled on is what lands, character
 * for character: his edit is a hand-made asset and it wins (D20), and a rewrite that tidied
 * his wording on the way in would be the app quietly having an opinion at the one gate where
 * it is not entitled to one.
 */
export function applyRewrite(
  store: Store,
  library: LibraryPaths,
  request: { findingId: string; replacement: string },
  llm?: LLMReadiness,
): RewriteApplied {
  const at = whereItStands(store, library, request.findingId)
  // Both preconditions, in the sentences the disabled button was already showing — one
  // composer, two readers (`launchBlockedBecause`'s rule).
  const blocked = rewriteBlockedBecause(at) ?? targetTakenBecause(library, at.artifact)
  if (blocked) throw new Error(blocked)

  const span = locateSpan(at)
  if (at.text.slice(span.from, span.to) === request.replacement) {
    throw new Error(
      'That replacement is the span it would replace. A rewrite that changes nothing still ' +
        'spends a version and stales everything built on it.',
    )
  }

  const landed = landNewVersion(store, library, {
    artifact: at.artifact,
    text: at.text.slice(0, span.from) + request.replacement + at.text.slice(span.to),
    summary: `rewrote the ${at.finding.checkKey} span${
      at.scene ? ` in scene ${at.scene.ordinal}` : ''
    }`,
    // The scene is what makes staleness land where the edit did rather than everywhere: a
    // scene-4 revision stales the consumers that consumed scene 4. Left off — a finding about
    // the whole artifact — the whole artifact changed, and everything downstream is stale,
    // which is the honest answer rather than a wider one.
    ...(at.scene && { touchedScenes: [at.scene.id] }),
    subject: at.subject,
  })

  const stale = landed.stale.map((one) => ({
    artifactId: one.artifact.id,
    kind: one.artifact.kind,
    slot: one.artifact.slot,
  }))
  return {
    findingId: at.finding.id,
    artifactId: landed.artifact.id,
    version: landed.artifact.version,
    filePath: landed.filePath,
    sceneId: at.scene?.id ?? null,
    scene: at.scene?.ordinal ?? null,
    read: landed.read.map((pass) => ({
      checkKey: pass.checkKey,
      artifactId: pass.artifactId,
      artifactVersion: pass.artifactVersion,
      findings: pass.findingCount,
    })),
    wall: landed.wall,
    stale,
    // Asked of the scene as it stands AFTER the motion: a re-delineation may have taken the
    // heading with it, and a re-check offered over a scene row that is gone is a button
    // pointing at nothing.
    recheck: recheckOffer(
      store,
      landed.artifact,
      at.scene && scenesOf(store, landed.artifact.episodeId).find((one) => one.id === at.scene!.id),
      llm,
    ),
    sentence: appliedSentence(at, landed.artifact, landed.read, stale.length, landed.wall),
  }
}

// ── The motion itself, and its two callers ──────────────────────────────────────

/** What one motion left behind: the version, the receipt, and what moved because of it. */
export interface LandedVersion {
  artifact: Artifact
  /** The new draft on the volume. The old one is still beside it (D20). */
  filePath: string
  /** Every deterministic pass that read it before the motion returned. **The receipt.** */
  read: CheckPass[]
  /** The scenes the draft broke into, for a script. Undefined for every other kind. */
  scenes: Scene[] | undefined
  /** What is stale now — asked of `staleArtifacts`, never set by this (1.3). */
  stale: StaleArtifact[]
  /** Whether the next stage may start on this episode now, in D12's own words. */
  wall: string | null
}

/**
 * **A new version of a written artifact, landed — as ONE MOTION.**
 *
 * This is what the module header above argues for, hoisted out of `applyRewrite` so that it
 * has two callers rather than one: the pre-drafted rewrite behind a finding (E3-5) and Ryan's
 * direct edit (`edit.ts`, E4-5). The E3 constraints ledger's first entry asked for exactly
 * that — "any new path that writes an artifact version must go through that same motion (or
 * its equivalent)" — and one function is a stronger answer than an equivalent, because an
 * equivalent is only equivalent until somebody changes one of them.
 *
 * Four things happen, in this order, and the order is the argument:
 *
 *   1. **A script's scenes are derived from the new text, before a byte lands.** A scene is
 *      its heading (`domain/delineate.ts`), so re-delineating is what keeps the grid the
 *      draft's own; doing it before the file is written is what makes a draft whose scenes
 *      cannot be read leave nothing behind (E4-3's ledger entry, which names both callers).
 *   2. **The file is written beside the old one**, never over it — `writeIfAbsent` is what
 *      makes "a hand-made asset always wins" true by the bytes rather than by the button.
 *   3. **The revision, the delineation and the free deterministic tier commit together.**
 *      Until the `check_pass` rows exist the revision has not committed, so at no point
 *      observable to any reader does a version exist that nothing has read.
 *   4. **Staleness and the wall are asked afterwards, never set.** Both are computations over
 *      the rows this motion just wrote (1.3, D12).
 *
 * A rollback removes the file it wrote: left behind, it would refuse the next attempt at the
 * same version with "a hand-made asset always wins" — a dead end built out of a rollback.
 */
export function landNewVersion(
  store: Store,
  library: LibraryPaths,
  what: {
    artifact: Artifact
    /** The bytes, exactly as they will land. Nothing here trims, reflows or reformats them. */
    text: string
    summary: string
    /** Left off, the whole artifact changed — which is the honest answer for a hand edit. */
    touchedScenes?: string[]
    /**
     * Canon entities this version declares it touches (invariant 2), added before the free
     * tier reads it — because the structural checks read PROVENANCE, so a version whose
     * provenance lands afterwards is a version read against the draft it replaced.
     */
    touches?: readonly string[]
    /** "the ep01 script" — what a refusal calls the thing it could not read. */
    subject: string
  },
): LandedVersion {
  const taken = targetTakenBecause(library, what.artifact)
  if (taken) throw new Error(taken)

  // Before anything is written: a draft whose scenes cannot be read out of it is not a draft,
  // and it must not leave a file on the volume for the next attempt to trip over (E4-3).
  const drafted =
    what.artifact.kind === 'script' ? delineateScript(what.text, what.subject) : undefined

  const version = what.artifact.version + 1
  const filePath = versionedPath(what.artifact.filePath!, version)
  const onDisk = join(library.artifactDir, filePath)

  mkdirSync(dirname(onDisk), { recursive: true })
  if (writeIfAbsent(onDisk, what.text) === 'kept') {
    // Checked above as a precondition and again here, because between the two is a filesystem
    // and this is the write that must never clobber. `writeIfAbsent` is the enforcement; the
    // precondition is the courtesy.
    throw new Error(targetTakenBecause(library, what.artifact)!)
  }

  try {
    return store.transaction(() => {
      const artifact = reviseArtifact(store, what.artifact.id, {
        summary: what.summary,
        ...(what.touchedScenes && { touchedScenes: what.touchedScenes }),
        filePath,
      })
      // After the revision, so a revision naming a scene the new draft no longer carries
      // degrades through `releaseScene` rather than being written against a row that is gone.
      const scenes = drafted ? delineateScenes(store, artifact.episodeId, drafted) : undefined
      if (what.touches?.length) declareProvenance(store, artifact.id, [...what.touches])

      const read = readItForFree(store, artifact)
      return {
        artifact,
        filePath,
        read,
        scenes,
        stale: staleArtifacts(store, artifact.episodeId),
        wall: stageBlockedBecause(store, artifact.episodeId),
      }
    })
  } catch (error) {
    rmSync(onDisk, { force: true })
    throw error
  }
}

/**
 * The free deterministic tier, re-run over a draft that has just landed.
 *
 * Two tiers, both free, and neither of them reads a model or a byte of the volume:
 *
 *   * `runStructuralChecks` over the revised artifact — the canon-graph checks (E3-0), whose
 *     passes land ON this artifact AT its new version. That is the receipt the wall's third
 *     condition needs, and the reason it is unconditional.
 *   * `runBoardRules` over the episode's continuity board, when the board was read out of this
 *     artifact — because those rules read the BOARD and anchor their findings in the SCRIPT
 *     (E3-1), so a deterministic finding standing against this draft may well be one of
 *     theirs. Re-running them over a board the script has moved past is the same act the free
 *     `continuity-board-checks` stage already offers, and it is the conservative direction:
 *     the board keeps saying what it saw until somebody pays to re-extract it, and `panel.ts`
 *     renders those rows `stale` rather than green so nobody reads them as a fresh reading.
 *
 * **A dismissal does not survive a re-run of the deterministic tier**, and that is not new
 * here: `runBoardRules` reads rows and knows nothing about dispositions, so the free
 * `continuity-board-checks` stage has raised a fresh open finding over a dismissed one since
 * E3-1. What this motion changes is how ORDINARY it is — a rewrite anywhere in the episode now
 * re-runs the tier, so a finding Ryan put down last week comes back the next time he fixes
 * something. It is left alone deliberately: teaching a deterministic rule to recognise its own
 * dismissed twin is a comparison of two findings' identity, which is E3-6's question and not
 * this one's; and the second dismissal is not waste, it is the measurement — a rule that keeps
 * firing at something he keeps putting down is precisely what D11's cried-wolf ratio exists to
 * surface, and it can only surface it if the firings are recorded.
 */
function readItForFree(store: Store, artifact: Artifact): CheckPass[] {
  const passes = [...runStructuralChecks(store, artifact.id)]
  const board = boardOf(store, artifact.episodeId)
  if (board && board.source?.id === artifact.id) {
    passes.push(...runBoardRules(store, board.artifact.id))
  }
  return passes
}

function appliedSentence(
  at: Standing,
  artifact: Artifact,
  read: CheckPass[],
  stale: number,
  wall: string | null,
): string {
  const where = at.scene ? `scene ${at.scene.ordinal} of ${at.subject}` : at.subject
  const found = read.reduce((sum, pass) => sum + pass.findingCount, 0)
  return (
    `Rewrote the ${at.finding.checkKey} span in ${where} — ${at.artifact.kind} ` +
    `v${artifact.version} is on the volume, ${read.length} deterministic check(s) have already ` +
    `read it for nothing and ${found === 0 ? 'found nothing in it' : `raised ${found}`}, and ` +
    `${stale === 0 ? 'nothing downstream went stale' : `${stale} artifact(s) went stale`}. ` +
    (wall === null
      ? 'The next stage is not blocked. '
      : 'The next stage is still blocked, on a reading of this draft rather than on the ' +
        'absence of one. ') +
    'The scene-scoped re-check is the paid half and it has not run.'
  )
}

// ── The paid half: one scene, re-read (D14) ─────────────────────────────────────

/** What the re-check button says before Ryan clicks it. */
export interface RecheckProjection {
  /** How many reviewers would be re-convened — the ones that had something to say here. */
  reviewers: number
  cost: CostProjection
  sentence: string
}

/** What one scene-scoped re-check did, and what it therefore cleared. */
export interface SceneRecheck {
  artifactId: string
  version: number
  sceneId: string
  scene: number
  /** One row per reviewer re-convened, in roster order. */
  read: { checkKey: string; findings: number; gaps: number }[]
  /** What the re-reading raised against the new draft. Zero is what clearing looks like. */
  findings: number
  /**
   * The findings it answered: the ones anchored in this scene, in the draft this one replaced.
   * **Nothing was written to any of them.** They stopped standing when their draft was
   * replaced, and their rows are what the check said at that version, forever (0010).
   */
  answered: string[]
  dollars: number
  sentence: string
}

/**
 * **Re-reads one scene, with the reviewers that had something to say about it** (D14).
 *
 * Two narrowings, and they are the reason this exists rather than a second panel run. The
 * TEXT is one scene — `composeTextCheck` slices it, so what a quote is searched in and what a
 * finding may anchor in narrow with it. The ROSTER is the checks whose findings are anchored
 * in that scene in the draft the rewrite replaced: they are the ones with a question
 * outstanding here, and re-convening the other eight would be paying nine reviewers to read a
 * paragraph none of them complained about.
 *
 * **Clearing is its passing, and there is nothing to write.** A finding raised against v1 has
 * already stopped standing at v2, because every reader that asks what stands filters on the
 * anchored version. What this call buys is the other half of that: a pass at v2 saying the
 * reviewer read the rewritten scene and had nothing to say — the difference between cleared
 * and merely unread, which `panel.ts` renders as `partial` rather than `clean` because the
 * rest of the draft is still unread.
 *
 * Tier-atomic, for E3-4's reasons: every call first, nothing recorded until every reply
 * parses, then one transaction. There is no such thing as half a re-check either.
 */
export async function recheckScene(
  store: Store,
  adapter: LLMAdapter,
  library: LibraryPaths,
  request: { artifactId: string; sceneId: string },
): Promise<SceneRecheck> {
  const artifact = findArtifact(store, request.artifactId)
  if (!artifact) throw new Error(`No such artifact: ${request.artifactId}`)
  if (!artifact.filePath) {
    throw new Error('That artifact has never been produced, so there is nothing to re-read.')
  }
  const scene = scenesOf(store, artifact.episodeId).find((one) => one.id === request.sceneId)
  if (!scene) {
    throw new Error(
      `Scene ${request.sceneId} does not belong to this episode. Scenes are derived from the ` +
        'written episode, and a re-check narrows an artifact to one of its own scenes.',
    )
  }

  const outstanding = outstandingIn(store, artifact, scene)
  const blocked = recheckBlockedBecause(artifact, scene, outstanding)
  if (blocked) throw new Error(blocked)

  const text = readFileSync(join(library.artifactDir, artifact.filePath), 'utf8')
  const site: CallSite = { store, episodeId: artifact.episodeId, chunk: () => {} }
  const where = episodeInShow(store, artifact.episodeId)
  if (!where) throw new Error(`no such episode: ${artifact.episodeId}`)

  const answered: { composed: ComposedCheck; findings: ReturnType<typeof readTextCheckReply> }[] = []
  let dollars = 0
  for (const subject of outstanding.subjects) {
    const composed = composeTextCheck(store, {
      artifact,
      text,
      subject,
      scene,
      // The same notes the panel is handed (4.4), from the same reader. A re-check is a later
      // run like any other, and a reviewer told nothing about what Ryan has already put down
      // would argue in ignorance of it at the one moment he is standing over the artifact.
      priorNotes: dismissalNotes(store, { showId: where.show.id, checkKey: subject.key }),
    })
    const completion = await adapter.complete(
      {
        system: composed.system,
        prompt: composed.prompt,
        maxTokens: RECHECK_MAX_TOKENS,
        effort: RECHECK_EFFORT,
      },
      site,
    )
    dollars += completion.dollars
    // Throws on anything it cannot verify, which fails the whole re-check. Deliberately not
    // caught: a re-check that swallowed a broken read would file a pass saying the scene reads
    // clean now, which is the one sentence this call exists to be able to say honestly.
    answered.push({ composed, findings: readTextCheckReply(completion.text, composed) })
  }

  const passes = store.transaction(() =>
    answered.map(({ composed, findings }) => recordTextCheck(store, composed, findings)),
  )
  const raised = passes.reduce((sum, pass) => sum + pass.findingCount, 0)

  return {
    artifactId: artifact.id,
    version: artifact.version,
    sceneId: scene.id,
    scene: scene.ordinal,
    read: passes.map((pass) => ({
      checkKey: pass.checkKey,
      findings: pass.findingCount,
      gaps: pass.gapCount,
    })),
    findings: raised,
    answered: outstanding.findings.map((finding) => finding.id),
    dollars,
    sentence: recheckSentence(store, artifact, scene, passes, outstanding.findings.length, raised),
  }
}

/** A scene of findings is a page of JSON, not a script. */
export const RECHECK_MAX_TOKENS = 4000

/** The same reading the panel does, over less of the artifact — the effort does not narrow. */
export const RECHECK_EFFORT: LLMEffort = 'high'

/** What the re-check button says, and what it is made of. */
export function recheckProjection(
  store: Store,
  artifact: Artifact,
  scene: Scene,
): RecheckProjection {
  const reviewers = outstandingIn(store, artifact, scene).subjects.length
  const cost = projectLLMCost({ ...RECHECK_CALL, calls: reviewers })
  return {
    reviewers,
    cost,
    sentence: `${reviewers} check${reviewers === 1 ? '' : 's'} · ${cost.sentence}`,
  }
}

/**
 * Whether this process can reach a model at all, in the adapter's own sentence — quoted whole
 * and never re-cased, for `launchBlockedBecause`'s reason: it opens with an environment
 * variable's name often enough that lowering its first letter prints `aNTHROPIC_API_KEY`.
 *
 * Optional, so that a caller which is not a screen — a test, a domain read — asks about the
 * finding rather than about the process. Left out, this precondition is not asserted at all,
 * which is honest: nothing here checked it.
 */
function nothingToCall(llm: LLMReadiness | undefined): string | null {
  if (!llm || llm.ready) return null
  return `Nothing to call. ${llm.label} was chosen (${llm.chosenBy}) — ${llm.sentence}`
}

/** One scene with a question outstanding, and the button that would answer it. */
export interface RecheckOnTheBench {
  sceneId: string
  /** As the episode numbers it. */
  scene: number
  offer: Offer
}

/**
 * **Every scene of this artifact a re-check is owed on** — the ones carrying still-open text
 * findings raised against a draft this artifact has moved past.
 *
 * It is a list per SCENE and not per finding, and that is D14 rather than a convenience: what
 * narrows is the text, so one call answers every finding anchored in that scene at once, and a
 * button behind each finding would offer to buy the same reading three times.
 *
 * The check bench (E3-7) renders these. It cannot get them off the finding cards, because
 * those are the findings standing against the CURRENT draft — a finding awaiting a re-check is
 * by definition one the current draft has moved past, so it has already left the cards. That
 * is the correct behaviour and the reason this reader exists: without it, a rewrite would make
 * the finding it answered disappear along with the button that proves it was answered.
 */
export function recheckOffers(
  store: Store,
  artifact: Artifact,
  llm?: LLMReadiness,
): RecheckOnTheBench[] {
  return scenesOf(store, artifact.episodeId)
    .filter((scene) => outstandingIn(store, artifact, scene).findings.length > 0)
    .map((scene) => ({
      sceneId: scene.id,
      scene: scene.ordinal,
      offer: recheckOffer(store, artifact, scene, llm),
    }))
}

function recheckOffer(
  store: Store,
  artifact: Artifact,
  scene: Scene | undefined,
  llm?: LLMReadiness,
): Offer {
  if (!scene) {
    return {
      sentence: 'Re-check the scene that was rewritten',
      cost: FREE,
      enabled: false,
      blockedBecause:
        'That rewrite was not in a scene. The finding is about the whole artifact, so there ' +
        'is no scene to narrow a re-check to. Call the panel over the new draft instead.',
    }
  }

  const outstanding = outstandingIn(store, artifact, scene)
  const projection = recheckProjection(store, artifact, scene)
  const blocked = recheckBlockedBecause(artifact, scene, outstanding) ?? nothingToCall(llm)
  return {
    sentence:
      `Re-read scene ${scene.ordinal} of the ${artifact.kind} with the ` +
      `${projection.reviewers} check${projection.reviewers === 1 ? '' : 's'} that argued ` +
      `with it — ${projection.sentence}`,
    cost: `${projection.cost.sentence} · your money, spent when you click`,
    enabled: blocked === null,
    blockedBecause: blocked,
  }
}

/** Everything a re-check would answer for, and everyone it would re-convene. */
interface Outstanding {
  findings: Finding[]
  subjects: CheckSubject[]
  /** Keys that were raised here and are no longer convened at all — a category that moved on. */
  gone: string[]
}

/**
 * The reviewers with a question outstanding about this scene: the ones whose still-open
 * findings are anchored in it, in a draft this artifact has already moved past.
 *
 * `tier === 'text'` because the deterministic ones are not re-convened by a model. They were
 * re-run for nothing when the rewrite landed (`readItForFree`), which is what makes them free
 * and what keeps this call to one or two reviewers.
 */
function outstandingIn(store: Store, artifact: Artifact, scene: Scene): Outstanding {
  const findings = findingsIn(store, artifact.id, { sceneId: scene.id }).filter(
    (finding) =>
      finding.tier === 'text' &&
      finding.status === 'open' &&
      finding.anchor.version < artifact.version,
  )

  const roster = panelFor(store, artifact)
  const keys = [...new Set(findings.map((finding) => finding.checkKey))]
  return {
    findings,
    subjects: roster.filter((subject) => keys.includes(subject.key)),
    gone: keys.filter((key) => !roster.some((subject) => subject.key === key)),
  }
}

function recheckBlockedBecause(
  artifact: Artifact,
  scene: Scene,
  outstanding: Outstanding,
): string | null {
  if (outstanding.findings.length === 0) {
    return (
      `Nothing was raised about scene ${scene.ordinal} in a draft this ${artifact.kind} has ` +
      'moved past, so there is nothing here to re-read. A re-check answers findings; reading ' +
      'the whole draft again is the panel, and it has its own button and its own cost.'
    )
  }
  if (outstanding.subjects.length === 0) {
    return (
      `The ${outstanding.gone.join(', ')} check no longer convenes over this ${artifact.kind} ` +
      'any more. Its category’s declaration has changed, or the entities it was about are no ' +
      'longer in its provenance. No check is left to re-read scene ' +
      `${scene.ordinal} for those findings, so dismiss them with a note or rule at the gate.`
    )
  }
  return null
}

function recheckSentence(
  store: Store,
  artifact: Artifact,
  scene: Scene,
  passes: CheckPass[],
  answered: number,
  raised: number,
): string {
  const who = passes.map((pass) => pass.checkKey).join(', ')
  const subject = `the ${subjectOf(store, artifact)}`
  if (raised === 0) {
    return (
      `${passes.length} check(s) re-read scene ${scene.ordinal} of ${subject} v` +
      `${artifact.version} and found nothing there — ${who}. The ${answered} finding(s) they ` +
      'raised against the draft you replaced no longer stand, and nothing was written to them. ' +
      'A finding is what a check said at one version. They have not read the rest of this ' +
      'draft.'
    )
  }
  return (
    `${passes.length} check(s) re-read scene ${scene.ordinal} of ${subject} v` +
    `${artifact.version} and raised ${raised} against the rewrite — ${who}. The ${answered} ` +
    'finding(s) from the draft you replaced no longer stand; these are new, about the new words.'
  )
}

// ── Button two: propose the canon change (it raises, and stops) ─────────────────

/** The five parts, prefilled from the finding — for Ryan to type the after into. */
export interface CanonChangePrefill {
  findingId: string
  /** The ratified fact the concern argues with. The delta's before. */
  factId: string
  before: string
  field: string | null
  entityId: string
  entityName: string
  /** The span with the lines around it, quoted — the second of the five parts (1.2). */
  usageContext: string
  alternatives: string[]
  /** The episode it would ride, so it reaches the completion sweep. */
  episodeId: string
  blockedBecause: string | null
}

export function canonChangePrefill(
  store: Store,
  library: LibraryPaths,
  findingId: string,
): CanonChangePrefill {
  const at = whereItStands(store, library, findingId)
  const fact = at.finding.facts[0]
  // The subject is the FACT's entity, never the finding's, and D22 is why they differ: the
  // world-rules check argued about Tobin Wick and the fact it quoted belongs to the Halvani,
  // inherited across his declared `species`. A delta's before and after are two statements
  // about one subject (proposal.ts refuses otherwise), and the subject here is the species.
  const entity = fact?.entityId ?? ''

  return {
    findingId: at.finding.id,
    factId: fact?.id ?? '',
    before: fact?.statement ?? '',
    field: fact?.field ?? null,
    entityId: entity,
    entityName: entityNameOf(store, entity),
    usageContext: usageContextFor(at),
    alternatives: CHANGE_ALTERNATIVES,
    episodeId: at.artifact.episodeId,
    blockedBecause: proposeBlockedBecause(store, at),
  }
}

/**
 * The two other things Ryan could do with it, so the ruling is a choice (1.2's fourth part).
 * They are the other two buttons, said as alternatives — which is what they are: a finding is
 * either the script's fault or the world's, and a proposal is the claim that it is the world's.
 */
const CHANGE_ALTERNATIVES = [
  'reject it — the script is what is wrong here, not the world, and the rewrite button is the ' +
    'answer. Your note says so and rides the next writing run',
  'defer it — leave canon standing and let the episode go on arguing with it until something ' +
    'forces the question',
]

/**
 * **Raises the canon change a finding implies, and stops.**
 *
 * A five-part proposal, kind `fact-delta`, riding the episode — so its claim is provisional
 * and visible to checks (3.3), and so it reaches the completion sweep when the episode is
 * approved rather than being forgotten at this gate.
 *
 * It lands on the queue unruled. **Nothing here rules it**, and that is not a limitation of
 * this button: only Ryan's ratification writes canon (invariant 1), the ruling API is
 * `createProposalRulings`, and the fact this function does not import it is the enforcement.
 *
 * It raises through `proposeFactChange` rather than building its own draft, for the reason
 * `canon-bench.ts` gives for having one builder: a second payload builder eventually builds a
 * different payload. What a closed or provisional fact earns is a refusal in words, and it is
 * the same refusal wherever the button is.
 */
export function proposeCanonChange(
  store: Store,
  library: LibraryPaths,
  findingId: string,
  change: { statement: string; field?: string },
): Proposal {
  const at = whereItStands(store, library, findingId)
  const blocked = proposeBlockedBecause(store, at)
  if (blocked) throw new Error(blocked)

  const fact = at.finding.facts[0]!
  return proposeFactChange(store, fact.id, {
    statement: change.statement,
    ...(change.field !== undefined && { field: change.field }),
    usageContext: usageContextFor(at),
    // A check remediation, not Ryan at the bench and not a writer run. The queue renders the
    // origin (`canon-bench.ts`), and "where did this come from" is the fifth of the five parts.
    raisedBy: 'check',
    // It rides the episode the artifact belongs to: the claim goes provisional, checks on this
    // episode see it (3.3), and the completion sweep collects it at approval.
    episodeId: at.artifact.episodeId,
    alternatives: CHANGE_ALTERNATIVES,
  })
}

function proposeBlockedBecause(store: Store, at: Standing): string | null {
  if (at.finding.disposition) {
    return (
      `That finding was already ${at.finding.disposition.kind} — “${at.finding.disposition.note}”. ` +
      'Every disposition is kept for good; raise the change from the canon bench instead.'
    )
  }
  const fact = at.finding.facts[0]
  if (!fact) {
    return (
      `The ${at.finding.checkKey} finding quotes no canon fact, so there is no before for a ` +
      'delta to carry. A proposal that only adds is not something this app can raise yet — ' +
      'register the claim at the canon bench, where a sheet is typed and promoted.'
    )
  }
  if (findFact(store, fact.id)?.closure) {
    return (
      `“${fact.statement}” was closed at ruling ${findFact(store, fact.id)!.closure!.closedBy} ` +
      'and is no longer what canon says. Propose a change to the fact standing in its place — ' +
      'a closed fact has no after.'
    )
  }
  if (fact.ratifiedBy === null) {
    return (
      `“${fact.statement}” is provisional — it rides its episode and no ruling has reached it. ` +
      'Rule the proposal it belongs to; a change to canon needs canon to change.'
    )
  }
  return null
}

/**
 * The second of the five parts: **the passage that made it necessary** (1.2) — the span, with
 * the lines around it, so the proposal reads as an argument rather than as a citation.
 *
 * The surrounding lines are the point. A ruling on "the pier crossing takes ninety seconds"
 * with nothing under it is a ruling on a sentence; the same ruling with the three lines the
 * scene actually spends on the crossing is a ruling on the episode, which is what Ryan is
 * being asked for.
 *
 * **Three cases, and two of them are not the same nothing.** A finding with no span never had
 * one — it is about the artifact's provenance rather than about a sentence in it (4.3). A
 * finding whose span the draft has moved past DID have one, and it is still recorded; that
 * happens as a matter of course, because propose stays available after a rewrite and should.
 * Collapsing the second into the first would put a false sentence into the second of the five
 * parts and drop the quote Ryan is being asked to rule about — a proposal that says there was
 * no passage, on a record kept forever. So the recorded span is quoted, and the fact that the
 * draft has moved on is said rather than hidden.
 */
function usageContextFor(at: Standing): string {
  const where = at.scene ? `scene ${at.scene.ordinal}` : at.artifact.kind
  const opening = `${at.subject} · ${where}`
  const argued = `The ${at.finding.checkKey} check argued`
  const concern = `“${at.finding.concern.trim()}”`

  if (at.finding.anchor.quote === '') {
    return (
      `${opening}. ${argued} with it: ${concern} It lands on no particular span — it is about ` +
      `what this ${at.artifact.kind} declares it touches rather than about a sentence in it.`
    )
  }

  const span = locateSpanOrNothing(at)
  if (!span) {
    return (
      `${opening}, at the time, read:\n\n> ${at.finding.anchor.quote}\n\n` +
      `${argued} with that span: ${concern} The ${at.artifact.kind} is at ` +
      `v${at.artifact.version} now and those words are no longer in it — the span is quoted as ` +
      'the check recorded it, which is what it was arguing with when it argued.'
    )
  }

  return (
    `${opening} reads:\n\n${quotedLines(at.text, span)}\n\n` +
    `${argued} with the marked line: ${concern} Raised here rather than rewritten because the ` +
    'world is what is wrong, not the script.'
  )
}

/**
 * How many lines of the artifact ride either side of the span.
 *
 * Three rather than one, because a script is blank-line separated: at one, a span with a
 * paragraph break on each side gets two empty lines for context, which is a quotation
 * pretending to be a passage.
 */
const CONTEXT_LINES = 3

/**
 * The span's own lines, blockquoted, with the one it starts on marked.
 *
 * **Exported for E4-4's fact extraction** (`claim.ts`), which needs the identical thing for
 * the identical reason: a claim a script makes, raised as a proposal, carries the passage that
 * made it as the second of the five parts. One composer for "a passage, quoted" — a second one
 * would put two different-looking usage contexts on one queue, and Ryan would be reading two
 * shapes of the same argument depending on which door raised it.
 */
export function quotedLines(text: string, span: { from: number; to: number }): string {
  const lines = text.split('\n')
  const starts = lines.reduce<number[]>((at, line, index) => {
    at.push(index === 0 ? 0 : at[index - 1]! + lines[index - 1]!.length + 1)
    return at
  }, [])

  const first = starts.findLastIndex((start) => start <= span.from)
  const last = starts.findLastIndex((start) => start < span.to)
  const from = Math.max(0, first - CONTEXT_LINES)
  const to = Math.min(lines.length - 1, last + CONTEXT_LINES)

  return lines
    .slice(from, to + 1)
    .map((line, index) => {
      const at = from + index
      const marked = at >= first && at <= last ? '  ← the span' : ''
      return `> ${line}${marked}`
    })
    .join('\n')
}

// ── Where a finding stands, and what may be done about it ───────────────────────

/** One finding, and everything the three buttons need to know about where it sits. */
interface Standing {
  finding: Finding
  artifact: Artifact
  where: EpisodeInShow
  /** The scene it is anchored in, or undefined when it is about the whole artifact. */
  scene: Scene | undefined
  /** The artifact's text, whole, off the volume (D2). */
  text: string
  /**
   * Where the anchored scene begins and ends in that text, or undefined when the finding is
   * about the whole artifact — or when the scene's heading is no longer in the draft.
   *
   * **Resolved against EVERY scene, never against the one being asked about.** `sceneSpans`
   * ends a scene where the NEXT scene's heading starts, so handing it a one-element list gives
   * a span that runs to the end of the file — and a "scene-scoped" search over the rest of the
   * episode is not a scene-scoped search. That mistake is silent: the rewrite lands wherever
   * the quoted words next occur, and the revision names the scene it thought it was editing,
   * so staleness flows to the wrong consumers.
   */
  bounds: { from: number; to: number } | undefined
  /** Just the scene's run of it — what a pre-draft is shown as context. */
  sceneText: string
  /** "the ep01 script" — the artifact in Ryan's words. */
  subject: string
}

function whereItStands(store: Store, library: LibraryPaths, findingId: string): Standing {
  const finding = findFinding(store, findingId)
  if (!finding) throw new Error(`No such finding: ${findingId}`)

  const artifact = findArtifact(store, finding.anchor.artifactId)
  if (!artifact) throw new Error(`No such artifact: ${finding.anchor.artifactId}`)
  const where = episodeInShow(store, artifact.episodeId)
  if (!where) throw new Error(`no such episode: ${artifact.episodeId}`)

  if (!artifact.filePath) {
    throw new Error(
      `The ${episodeLabel(where.episode.number)} ${artifact.kind} has never been produced, so ` +
        'there is nothing to rewrite, quote, or read.',
    )
  }
  const text = readFileSync(join(library.artifactDir, artifact.filePath), 'utf8')
  const scenes = scenesOf(store, artifact.episodeId)
  const scene = scenes.find((one) => one.id === finding.anchor.sceneId)
  // Against all of them, so a scene ends where the next one begins. See `Standing.bounds`.
  const span = scene
    ? sceneSpans(text, scenes).find((one) => one.scene.id === scene.id)
    : undefined
  // A heading the draft no longer carries gets the whole text from `sceneSpans` — the honest
  // fallback for a check that must still refuse an invented quote, and a hole for anything
  // that narrows. Treated as "no bounds" here, and refused where it matters.
  const bounds =
    span && text.includes(scene!.heading) ? { from: span.from, to: span.to } : undefined

  return {
    finding,
    artifact,
    where,
    scene,
    text,
    bounds,
    sceneText: bounds ? text.slice(bounds.from, bounds.to) : text,
    subject: `the ${episodeLabel(where.episode.number)} ${artifact.kind}${
      artifact.slot ? ` ${artifact.slot}` : ''
    }`,
  }
}

/**
 * Why this finding's span cannot be rewritten, in the words the disabled button shows and the
 * act refuses with. Null when it can.
 *
 * One function, two readers — `launchBlockedBecause`'s rule (operating.ts), for its reason: a
 * precondition the API enforced in one wording and the button stated in another is a failure
 * after a click wearing a different coat.
 */
function rewriteBlockedBecause(at: Standing): string | null {
  if (at.finding.disposition) {
    return (
      `That finding was already ${at.finding.disposition.kind} — “${at.finding.disposition.note}”. ` +
      'Every disposition is kept for good, and a rewrite answering one you dismissed would be ' +
      'the app arguing with your ruling.'
    )
  }
  if (at.finding.anchor.quote === '') {
    return (
      `The ${at.finding.checkKey} finding lands on no span — it is about what this ` +
      `${at.artifact.kind} declares it touches rather than about a sentence in it. ` +
      'There is nothing here to rewrite: propose the canon change, or dismiss it with a note.'
    )
  }
  if (at.finding.anchor.version !== at.artifact.version) {
    return (
      `That finding was raised against ${at.artifact.kind} v${at.finding.anchor.version} and ` +
      `the ${at.artifact.kind} stands at v${at.artifact.version}. The draft it argued with is ` +
      'gone, so its span is not this draft’s to rewrite — re-check the scene, and rewrite what ' +
      'the new reading says.'
    )
  }
  if (!locateSpanOrNothing(at)) {
    return (
      `The span “${at.finding.anchor.quote.slice(0, 60)}” is not in ` +
      `${at.scene ? `scene ${at.scene.ordinal} of ` : ''}${at.subject} on the volume any more. ` +
      'An anchor is searched for by its quote, and this one lands nowhere. The file has ' +
      'been edited by hand since the check read it.'
    )
  }
  return null
}

/**
 * Whether the file the next version would be written to is already there, in the words the
 * disabled button shows (D20, D15).
 *
 * It is asked HERE, before the click, and not only by `writeIfAbsent` on the way past. A
 * process killed between the write and the commit leaves exactly this — a draft on the volume
 * with no row pointing at it — and without this the button stays lit and fails afterwards
 * every time, which is the failure-after-launch that "preconditions before the button" exists
 * to forbid.
 */
export function targetTakenBecause(library: LibraryPaths, artifact: Artifact): string | null {
  const filePath = versionedPath(artifact.filePath!, artifact.version + 1)
  if (!existsSync(join(library.artifactDir, filePath))) return null
  return (
    `${filePath} is already on the volume, and nothing here is ever written over. The ` +
    `${artifact.kind} is still at v${artifact.version}, so that file is either one you ` +
    'wrote by hand — in which case it is the draft and there is nothing here to apply — or ' +
    'one a rewrite left behind when its transaction rolled back. Read it, then keep it or ' +
    'remove it.'
  )
}

/** Where the span is in the artifact's text, searched inside its scene when it has one. */
function locateSpan(at: Standing): { from: number; to: number } {
  const span = locateSpanOrNothing(at)
  if (!span) throw new Error(rewriteBlockedBecause(at) ?? 'that span is not in the artifact')
  return span
}

/**
 * The span, searched inside the scene it is anchored in — and **ending where that scene ends**.
 *
 * The bound at both ends is what makes this a scene search. A line that Ryan has cut from
 * scene 2 and that still stands word for word in scene 5 must not be found: rewriting it there
 * would edit a scene nobody asked about, and the revision would name scene 2, so freshness
 * would stale the wrong consumers and leave the real ones fresh. The button refuses instead,
 * and says the span is gone.
 */
function locateSpanOrNothing(at: Standing): { from: number; to: number } | undefined {
  // No bounds and a scene means the heading is gone from the draft. Search nothing: a span
  // whose scene cannot be located is not a span this artifact can be said to have.
  if (at.scene && !at.bounds) return undefined
  const from = at.bounds?.from ?? 0
  const to = at.bounds?.to ?? at.text.length

  const found = at.text.indexOf(at.finding.anchor.quote, from)
  if (found < 0 || found + at.finding.anchor.quote.length > to) return undefined
  return { from: found, to: found + at.finding.anchor.quote.length }
}

/**
 * `greyharbor/s01e01/script.md` → `greyharbor/s01e01/script-v2.md`.
 *
 * One file per version, the way `board-step.ts` writes one per build and for the same reason:
 * every draft stays on the volume, human-readable and git-versionable (D2), and nothing is
 * ever written over (D20). The `-v<n>` already on a path is replaced rather than appended to,
 * so a second rewrite gives `script-v3.md` and not `script-v2-v3.md`.
 */
function versionedPath(filePath: string, version: number): string {
  const slash = filePath.lastIndexOf('/')
  const dot = filePath.lastIndexOf('.')
  const hasExtension = dot > slash
  const stem = (hasExtension ? filePath.slice(0, dot) : filePath).replace(/-v\d+$/, '')
  return `${stem}-v${version}${hasExtension ? filePath.slice(dot) : ''}`
}

function entityNameOf(store: Store, entityId: string): string {
  if (entityId === '') return ''
  return (
    store.get<{ name: string }>('SELECT name FROM canon_entity WHERE id = ?', entityId)?.name ?? ''
  )
}

/** "ep01 script" — what the sentences above are about. */
function subjectOf(store: Store, artifact: Artifact): string {
  const where = episodeInShow(store, artifact.episodeId)
  const label = where ? `${episodeLabel(where.episode.number)} ` : ''
  return `${label}${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
