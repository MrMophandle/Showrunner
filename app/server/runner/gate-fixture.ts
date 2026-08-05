import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from '../db/migrate.ts'
import { openStore } from '../db/store.ts'
import { recordArtifact, reviseArtifact } from '../domain/artifact.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { createEventLog } from '../events.ts'
import { createRulings, gateOfStep, gateStanding, openGates } from './gate.ts'
import { reclaimAfterCrash } from './run.ts'
import { createRunner } from './runner.ts'
import type { Step, StageCatalogue } from './step.ts'

/**
 * The other half of `gate-restart.test.ts`: a real Showrunner process that opens a gate and
 * is killed with it open, and a second process that boots from nothing but the library on
 * disk and rules on it.
 *
 *   node gate-fixture.ts <libraryDir> start    — runs to the gate, parks, hangs
 *   node gate-fixture.ts <libraryDir> rule     — boots, finds the open gate, rules on it
 *
 * This file is not a test (vitest collects `*.test.ts` only). It runs in a child process
 * because a second `createRunner` in ONE process shares whatever that process is holding:
 * if open gates were ever cached in module state — the obvious "avoid a query"
 * optimization — a same-process test would pass while a real reboot lost Ryan's pending
 * decision. Only a process that never saw the first one can prove it did not.
 *
 * Both invocations build the SAME stage from the SAME TypeScript. The only difference is
 * that `start` has nobody to rule and `rule` does.
 */

const [, , libraryDir, phase] = process.argv
if (!libraryDir || (phase !== 'start' && phase !== 'rule')) {
  throw new Error('usage: gate-fixture.ts <libraryDir> <start|rule>')
}

const stepLog = join(libraryDir, 'steps.log')
const databaseFile = join(libraryDir, 'showrunner.db')

/** Every execution of every step, in both processes, appended to one file. */
function record(line: string): void {
  appendFileSync(stepLog, `${process.pid} ${line}\n`, 'utf8')
}

const store = openStore(databaseFile)
migrate(store)
const events = createEventLog(store)

/**
 * The producing step. It writes, presents, and parks — and on the way back in it finds the
 * ruling and returns. The `image-api` lock is deliberate: a gate step that generated
 * images before presenting them would hold one, and a lock held across a decision would
 * starve every other episode until Ryan woke up.
 */
const writeScript: Step = {
  name: 'write-script',
  lock: 'image-api',
  async execute(context) {
    const standing = context.gate()
    const ruling = standing?.ruling
    if (ruling && ruling.verdict !== 'reject') {
      record(`write-script resumed on ${ruling.verdict}`)
      return { script: `v${standing!.round}`, ruling: ruling.verdict }
    }
    record(
      ruling ? `write-script rewrote against ${ruling.notes.length} notes` : 'write-script wrote and presented',
    )
    const artifact = store.get<{ id: string }>(
      "SELECT id FROM artifact WHERE kind = 'script' LIMIT 1",
    )!
    // A rewrite publishes a new version, so round 2 presents "script v2 under review".
    if (ruling) reviseArtifact(store, artifact.id, { summary: 'rewritten against the notes' })
    context.openGate({ artifactId: artifact.id, payload: { scenes: 6, pages: 14 } })
  },
}

const publish: Step = {
  name: 'publish-the-cut',
  inputs: ['write-script'],
  async execute(context) {
    record('publish-the-cut ran')
    return { published: context.input<{ ruling: string }>('write-script').ruling }
  },
}

const STAGES: StageCatalogue = {
  write: { name: 'write', steps: [writeScript, publish] },
}

if (phase === 'start') {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  const episode = createEpisode(store, { seasonId: season.id, number: 6, title: 'Cold Ledger' })
  recordArtifact(store, { episodeId: episode.id, kind: 'script' })

  const runner = createRunner(store, STAGES, events)
  const run = runner.enqueueRun({ episodeId: episode.id, stage: 'write' })
  await runner.settled(run.id)

  const gate = gateOfStep(store, stepId(run.id))!
  process.stdout.write(`parked ${run.id} ${gate.id}\n`)
  await hangForever()
} else {
  // What a fresh process must put right before it can be trusted. A run paused on a gate
  // is not interrupted work: reclaim must report nothing for it and leave it alone.
  const reclaimed = reclaimAfterCrash(store)
  process.stdout.write(`reclaimed ${reclaimed.length}\n`)

  const waiting = openGates(store)
  process.stdout.write(
    `open ${waiting.length} ${waiting.map((gate) => `${gate.subject}|round ${gate.round}`).join(',')}\n`,
  )

  // A runner that has only ever seen the database, and a ruling on a gate it did not open.
  const runner = createRunner(store, STAGES, events)
  runner.resumeInterrupted()
  const rulings = createRulings(store, events, runner)
  const gate = waiting[0]!.gate
  rulings.reject(gate.id, {
    notes: [
      { note: 'scene 4 puts Mara in two places.', depth: 'scene', target: 'scene-4' },
      { note: 'and the ledger-office shot is the wrong lens.', depth: 'shot', target: 'shot-05' },
    ],
  })
  const afterReject = await runner.settled(gate.runId)
  process.stdout.write(`rejected ${afterReject.status} round ${gateStanding(store, gate.id)!.round}\n`)

  rulings.approve(gate.id, { comment: 'that reads.' })
  const settled = await runner.settled(gate.runId)
  process.stdout.write(`finished ${settled.id} ${settled.status}\n`)
  store.close()
}

function stepId(runId: string): string {
  return store.get<{ id: string }>(
    "SELECT id FROM step WHERE run_id = ? AND name = 'write-script'",
    runId,
  )!.id
}

/**
 * Keeps the `start` process alive for the kill, with its gate open.
 *
 * The timer is load-bearing. A never-resolving promise does not hold Node open on its own:
 * the event loop empties, Node calls it an unsettled top-level await and exits 13 — so the
 * test would sometimes be killing a process that had already died of its own accord, which
 * proves nothing about a gate surviving anything. The handle makes the process wait to be
 * killed, the way a real app process waits on its socket.
 */
function hangForever(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, 1_000)
  })
}
