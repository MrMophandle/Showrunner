import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FREE, projectLLMCost, type CostProjection } from '../cost.ts'
import type { Store } from '../db/store.ts'
import { artifactsOf, provenanceOf, staleArtifacts, type Artifact } from '../domain/artifact.ts'
import {
  boardOf,
  parseExtraction,
  recordExtractedBoard,
  type Board,
  type BoardScene,
} from '../domain/board.ts'
import { runBoardRules, BOARD_RULE } from '../domain/board-rules.ts'
import { factsInScope } from '../domain/fact.ts'
import {
  episodeInShow,
  episodeLabel,
  scenesOf,
  type EpisodeInShow,
  type Scene,
} from '../domain/spine.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import type { StageCatalogue, StageOffer, Step, StepContext } from './step.ts'

/**
 * Building the continuity board, as steps (3.2b, 2.2).
 *
 * **The seam, one more time, because it is the whole design:** extraction reads the script
 * with a model and costs money; the rules read the rows it wrote and cost nothing. So there
 * are TWO STAGES here, not one —
 *
 *   * `continuity-board` · extract, then check. The button says "1 Opus 5 call, ~$0.xx".
 *   * `continuity-board-checks` · check only. The button says free, and it is.
 *
 * — and the free one is not a convenience. A scene edit stales the board and a rewrite lands
 * in one scene at a time (D14, E3-5); if re-checking meant re-extracting, every correction
 * loop would bill Ryan for a reading he has already paid for.
 *
 * The extraction step is also idempotent in the way that matters for money: it re-reads the
 * script only when the script has moved past the board it already built. A crash-resumed
 * run, a second click, a stage re-entered after a gate — none of them makes a second call.
 * That is D20's "re-runs fill gaps only" applied to tokens rather than bytes.
 *
 * **No lock.** It is a cloud model call — it holds no GPU, and `image-api` is for cloud
 * IMAGE steps (D20).
 *
 * ── The refusal this stage broke, and how E3-7 mended it ────────────────────────
 * `continuity-board-checks` was the FIRST stage in this app to call no model, and
 * `launchBlockedBecause` (operating.ts) did not know it: it refused every run when the
 * adapter was unready, because until then every stage needed one. So on a process with no
 * backend configured at all, the free stage was refused with "Nothing to call" — a
 * precondition true of the paid stage beside it and false of this one.
 *
 * The fix is **a declaration, never an exemption**. Each stage says what it spends
 * (`StageOffer`, step.ts), which is exactly the data "verb + object + scope + cost" needs
 * anyway, and the refusal consults the declaration: a stage that declares `callsModel: false`
 * runs on a process with nothing behind the adapter. A list of stage names in the refusal
 * would have been the same bug with a longer fuse — right until the next free stage, and
 * wrong from then on with nobody looking.
 */

/** The stage names, as they are persisted on `run.stage` and as the API takes them. */
export const BOARD_STAGE = 'continuity-board'
export const BOARD_CHECK_STAGE = 'continuity-board-checks'

/**
 * Extraction reads a whole script and a show's canon in scope, and writes a structured
 * board back. Deliberately generous against what it actually sends — a projection that
 * under-states is a button that lies cheaply, and over-stating is the safe direction
 * (cost.ts). The ledger afterwards is what was really spent.
 */
export const BOARD_EXTRACTION: CostProjection = projectLLMCost({
  promptTokens: 9000,
  outputTokens: 3000,
})

/**
 * Extraction is reading, not writing: the answer is a transcription of what the script says
 * about where people are, and a model that thinks hard about it is a model inventing. `low`
 * keeps the ceiling for the answer rather than the reasoning.
 */
export const BOARD_EFFORT: LLMEffort = 'low'

/** A board of forty scenes is still only a few thousand tokens of JSON. */
export const BOARD_MAX_TOKENS = 16000

/** What the extraction step hands on, and what the episode room renders. */
export interface BoardBuild {
  boardId: string
  /** Relative to the library's artifact dir. */
  filePath: string
  version: number
  scenes: number
  /** False when the board was already built from this script and no call was made. */
  called: boolean
}

/** What the rules said. Free to produce, and produced every time. */
export interface BoardCheck {
  boardId: string
  /** How many rules ran. Every one of them records a pass, including the silent ones. */
  rules: number
  findings: number
  /** Per rule, in the order the tier runs them — the panel's verdict board (E3-4). */
  tally: { rule: string; findings: number }[]
}

export function boardStages(library: LibraryPaths): StageCatalogue {
  return {
    [BOARD_STAGE]: {
      name: BOARD_STAGE,
      // Both of these READ the script and record what they found (step.ts, `STAGE_WORK`).
      // Neither is walled, and the free one especially must not be: the wall's own sentence
      // sends Ryan here — "fix it and re-run the checks, the deterministic ones cost nothing".
      work: 'reads',
      steps: [extractTheContinuityBoard(library), runTheBoardRules()],
      offerOn: (store, episode): StageOffer => {
        const label = episodeLabel(episode.number)
        const script = scriptOf(store, episode.id)
        const standing = boardOf(store, episode.id)
        const again =
          standing && isStale(store, episode.id, standing)
            ? ', which the script has moved past'
            : ''
        return {
          sentence:
            `Read the ${label} script into a continuity board and run the rules over it — ` +
            `one reading of the whole script${
              standing ? `, replacing the board built from v${standing.source?.version ?? '?'}${again}` : ''
            }`,
          cost: BOARD_EXTRACTION.sentence,
          callsModel: true,
          nothingToDoBecause: script ? null : noScriptBecause(label),
        }
      },
    },
    [BOARD_CHECK_STAGE]: {
      name: BOARD_CHECK_STAGE,
      work: 'reads',
      steps: [runTheBoardRules()],
      offerOn: (store, episode): StageOffer => {
        const label = episodeLabel(episode.number)
        const standing = boardOf(store, episode.id)
        return {
          sentence:
            `Re-run the ${BOARD_RULE.length} deterministic rules over the ${label} continuity ` +
            'board — they read the rows an extraction already wrote, and read no script',
          // The whole reason this stage exists, said on its own button: a correction loop that
          // billed Ryan for re-reading a script he had already paid to have read would make
          // every rewrite cost an extraction.
          cost: FREE,
          callsModel: false,
          nothingToDoBecause: standing
            ? null
            : `${label} has no continuity board yet, and these rules read the rows an ` +
              'extraction wrote. Build the board first — that is the reading that costs money, ' +
              'and this is the one that never does.',
        }
      },
    },
  }
}

// ── The paid step ───────────────────────────────────────────────────────────────

/**
 * Reads the episode's script into the board — once.
 *
 * The precondition is checked in the step and not only in the UI, because "preconditions
 * before the button" is a promise about screens and this is what makes it keepable: an
 * episode with no script has nothing to extract, and saying so is better than an empty grid.
 */
export function extractTheContinuityBoard(library: LibraryPaths): Step<BoardBuild> {
  return {
    name: 'extract-the-continuity-board',

    async execute(context: StepContext): Promise<BoardBuild> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const script = requireScript(context.store, context.episodeId, label)
      const scenes = scenesOf(context.store, context.episodeId)

      // ── Already built from this script? Then nothing is re-read and nothing re-spent ──
      const standing = boardOf(context.store, context.episodeId)
      if (standing && !isStale(context.store, context.episodeId, standing)) {
        context.progress(
          `${label}'s continuity board is already built from ${script.kind} v${script.version}` +
            ' — nothing re-read, and no second call made for it',
        )
        return {
          boardId: standing.artifact.id,
          filePath: standing.artifact.filePath ?? '',
          version: standing.artifact.version,
          scenes: standing.scenes.length,
          called: false,
        }
      }

      const version = (standing?.artifact.version ?? 0) + 1
      const filePath = join(
        where.show.key,
        `s${pad(where.season.number)}e${pad(where.episode.number)}`,
        `continuity-board-v${version}.md`,
      )

      context.progress(
        `Reading the ${label} script into a continuity board — ${scenes.length} scenes, ` +
          `${BOARD_EXTRACTION.sentence}`,
      )
      const completion = await context.llm.complete({
        system: BOARD_SYSTEM,
        prompt: boardPrompt(context.store, library, where, script, scenes),
        maxTokens: BOARD_MAX_TOKENS,
        effort: BOARD_EFFORT,
      })

      const board = recordExtractedBoard(context.store, {
        episodeId: context.episodeId,
        scriptId: script.id,
        extraction: parseExtraction(completion.text),
        filePath,
      })

      // The grid on the volume, human-readable and git-versionable (D2). One file per build,
      // so `writeIfAbsent` still holds and a hand-made asset can never be written over (D20).
      const onDisk = join(library.artifactDir, filePath)
      mkdirSync(dirname(onDisk), { recursive: true })
      writeIfAbsent(onDisk, renderGrid(where, board))

      context.progress(
        `${label}'s continuity board is built from ${script.kind} v${script.version} — ` +
          `${board.scenes.length} scenes`,
      )
      return {
        boardId: board.artifact.id,
        filePath,
        version: board.artifact.version,
        scenes: board.scenes.length,
        called: true,
      }
    },
  }
}

// ── The free step ───────────────────────────────────────────────────────────────

/**
 * Runs the four deterministic rules over the board that is there.
 *
 * It calls no model, takes no lock, reads nothing off the volume, and is safe to run as
 * many times as a crash or a click makes it run — every run is a fresh set of passes,
 * because a check pass is a record of a run and never an edit of one (0010).
 *
 * It deliberately does NOT declare the extraction step as an input. It reads the board out
 * of the store, which is what lets `continuity-board-checks` run it alone.
 */
export function runTheBoardRules(): Step<BoardCheck> {
  return {
    name: 'run-the-board-rules',

    async execute(context: StepContext): Promise<BoardCheck> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const board = boardOf(context.store, context.episodeId)
      if (!board) {
        throw new Error(
          `${label} has no continuity board to check. Build it first — the rules read the ` +
            'rows an extraction wrote, and there is nothing here to read.',
        )
      }

      context.progress(
        `Checking the ${label} continuity board — ${BOARD_RULE.length} deterministic rules, free`,
      )
      const passes = runBoardRules(context.store, board.artifact.id)
      const tally = passes.map((pass) => ({ rule: pass.checkKey, findings: pass.findingCount }))
      const findings = tally.reduce((total, rule) => total + rule.findings, 0)

      context.progress(
        findings === 0
          ? `${BOARD_RULE.length} rules ran over the ${label} board and found nothing — ` +
              'recorded, because a clean run is a measurement'
          : `${findings} deterministic finding(s) on the ${label} board: ` +
              tally
                .filter((rule) => rule.findings > 0)
                .map((rule) => `${rule.rule} ×${rule.findings}`)
                .join(', '),
      )
      return { boardId: board.artifact.id, rules: passes.length, findings, tally }
    },
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────────

const BOARD_SYSTEM =
  'You extract continuity boards from screenplays. You transcribe what a script says and ' +
  'never infer what it leaves out. Return one JSON object and nothing else: no preamble, ' +
  'no code fence, no commentary.'

/**
 * The script, the scenes, and **exactly the canon in scope** — `provenanceOf` then
 * `factsInScope` per entity, never the whole bible (invariant 2). The facts arrive with
 * their ids beside them, which is what makes a citation in the answer a copy rather than a
 * guess: the board quotes fact ids and this is where it gets them.
 */
function boardPrompt(
  store: Store,
  library: LibraryPaths,
  where: EpisodeInShow,
  script: Artifact,
  scenes: Scene[],
): string {
  const lines = [
    `Show: “${where.show.title}” · season ${where.season.number}, episode ` +
      `${where.episode.number}, “${where.episode.title}”.`,
    '',
    '## The canon in scope',
    '',
    'These are the only entities this script declares it touches, and the only facts loaded',
    'with them. Cite a fact by the id in brackets; never cite one that is not listed here.',
    '',
    ...scopeLines(store, script),
    '',
    '## The scenes, numbered',
    '',
    ...scenes.map((scene) => `${scene.ordinal} · ${scene.heading}`),
    '',
    '## The script',
    '',
    readFileSync(join(library.artifactDir, script.filePath!), 'utf8').trim(),
    '',
    '## What to return',
    '',
    ...SHAPE,
  ]
  return lines.join('\n')
}

/**
 * One block per entity in the artifact's provenance, with the facts that load with it —
 * `factsInScope` once per entity, and the inheritance read off that same answer. An
 * inherited fact says which edge it travelled, which is D22 made visible in the prompt:
 * the model can see that the Halvani physiology arrived with Tobin Wick rather than being
 * about a species standing in the scene.
 */
function scopeLines(store: Store, script: Artifact): string[] {
  const lines: string[] = []
  for (const entity of provenanceOf(store, script.id)) {
    const scope = factsInScope(store, entity.id)
    const travelled = new Map(
      scope.inheritance.flatMap((edge) =>
        edge.facts.map((fact) => [fact.id, edge.type.name] as const),
      ),
    )
    const aliases = entity.aliases.length > 0 ? ` (also: ${entity.aliases.join(', ')})` : ''
    lines.push(`### ${entity.name} — ${entity.categoryKey}${aliases}`)
    if (scope.inScope.length === 0) lines.push('- (no facts)')
    for (const fact of scope.inScope) {
      const edge = travelled.get(fact.id)
      lines.push(
        `- [${fact.id}] ${fact.statement}${edge ? ` (inherited via ${edge})` : ''}`,
      )
    }
    lines.push('')
  }
  return lines
}

/**
 * The shape, stated once, in the prompt rather than in a schema object — one system prompt,
 * one user prompt, one answer (llm/adapter.ts). Every rule here exists because a rule
 * downstream depends on it, and the two `never guess` lines are what keep the deterministic
 * tier honest: a model that fills in a protection nobody wrote has turned an abstention into
 * a certainty.
 */
const SHAPE = [
  '```',
  '{',
  '  "scenes": [{',
  '    "scene": 1,                       // the number above. EVERY scene, none skipped.',
  '    "location": "Mess deck",          // the place, named the SAME WAY every time it recurs',
  '    "locationEntity": "…",            // an entity name from the list, or omit',
  '    "environment": "inside",          // "inside" | "exposed" (outside the pressure hull)',
  '    "shipPosition": "",               // "docked · Meridian Spur", "drifting"; "" if none',
  '    "elapsed": "06:10",               // what a reader should see: a clock, "CONTINUOUS", "T+2h"',
  '    "elapsedSeconds": 22200,          // the same moment as a number, for comparison.',
  '                                      // Resolve CONTINUOUS to the previous scene\'s number.',
  '                                      // null when the script does not say when this is.',
  '    "present": [{',
  '      "character": "Ilse Renn",',
  '      "entity": "Ilse Renn",          // an entity name from the list, or omit',
  '      "protection": "none",           // "none" | "hardsuit" | "containment-field" | "unknown"',
  '                                      // "unknown" when the script does not say. NEVER GUESS:',
  '                                      // a wrong "none" is a person reported dead.',
  '      "arrives": false                // true ONLY where the script SHOWS them coming in',
  '    }]',
  '  }],',
  '  "transits": [{                      // only from facts that state a NUMBER',
  '    "from": "No. 4 lock", "to": "The Long Pier",',
  '    "seconds": 90, "fact": "fact_…", "eitherWay": true',
  '  }],',
  '  "hazards": [{                       // only where a fact says a body dies unprotected',
  '    "entity": "Halvani", "hazard": "lethal-in-vacuum", "fact": "fact_…"',
  '  }]',
  '}',
  '```',
]

// ── The grid on the volume ──────────────────────────────────────────────────────

/**
 * The board as a markdown table — the same six columns the episode room renders, on the
 * volume, human-readable and git-versionable (D2).
 *
 * The rows in SQLite are the truth and this file is the readable copy; a build writes a new
 * one rather than editing the old, so there is never a stale file pretending otherwise.
 */
export function renderGrid(where: EpisodeInShow, board: Board): string {
  const lines = [
    `# ${where.show.title} · ${episodeLabel(where.episode.number)} — continuity board`,
    '',
    `> Derived from the script, v${board.source?.version ?? '?'}. Scenes come from the ` +
      'script and are never prescribed to it.',
    '',
    '| Scene | Location | Present | Environment | Ship | Elapsed |',
    '| --- | --- | --- | --- | --- | --- |',
    ...board.scenes.map((scene) =>
      [
        '',
        String(scene.ordinal),
        scene.location,
        scene.present.map((who) => who.characterName).join(', ') || '—',
        environmentCell(scene),
        scene.shipPosition || '—',
        scene.elapsedLabel || '—',
        '',
      ].join(' | ').trim(),
    ),
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * "suited · exposed", "unprotected · exposed", "inside" — the mockup's cell. The environment
 * is the scene's and the protection is each body's, and this is the one place they are said
 * together, because that is how Ryan reads them.
 */
function environmentCell(scene: BoardScene): string {
  if (scene.environment === 'inside') return 'inside'
  const worn = [...new Set(scene.present.map((who) => WORN[who.protection]))]
  return [...worn, 'exposed'].join(' · ')
}

const WORN: Record<string, string> = {
  none: 'unprotected',
  hardsuit: 'suited',
  'containment-field': 'field',
  unknown: 'protection unstated',
}

// ── Preconditions ───────────────────────────────────────────────────────────────

function requireEpisode(store: Store, episodeId: string): EpisodeInShow {
  const where = episodeInShow(store, episodeId)
  if (!where) throw new Error(`no such episode: ${episodeId}`)
  return where
}

/** The episode's script, or undefined when there is none on the volume to read. */
function scriptOf(store: Store, episodeId: string): Artifact | undefined {
  const script = artifactsOf(store, episodeId).find(
    (artifact) => artifact.kind === 'script' && artifact.slot === '',
  )
  return script?.filePath ? script : undefined
}

/**
 * One sentence, two readers — the disabled button states it before the click and the step
 * throws it when something calls the API directly. `launchBlockedBecause`'s rule (operating.ts):
 * a precondition worded one way in front of a button and another way behind it is a failure
 * after the click wearing a different coat.
 */
const noScriptBecause = (label: string): string =>
  `${label} has no script to read. A continuity board is DERIVED from the written episode ` +
  'and never prescribed to it, so there is nothing here to extract.'

function requireScript(store: Store, episodeId: string, label: string): Artifact {
  const script = scriptOf(store, episodeId)
  if (!script) throw new Error(noScriptBecause(label))
  return script
}

/** Freshness, asked of the machinery that owns it rather than recomputed here (1.3). */
function isStale(store: Store, episodeId: string, board: Board): boolean {
  return staleArtifacts(store, episodeId).some((stale) => stale.artifact.id === board.artifact.id)
}

const pad = (n: number): string => String(n).padStart(2, '0')
