import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from '../db/migrate.ts'
import { openStore } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { createRunner } from './runner.ts'
import type { Step, StageCatalogue } from './step.ts'

/**
 * The other half of `crash.test.ts`: a real Showrunner process, run twice against one
 * real library on disk, with a `kill -9` in between.
 *
 *   node crash-fixture.ts <libraryDir> start    — enqueues the run, hangs mid-step
 *   node crash-fixture.ts <libraryDir> restart  — resumes whatever the kill interrupted
 *
 * This file is not a test (vitest collects `*.test.ts` only). It exists because a
 * `resume()` call on a live object proves nothing: the process that died took its memory
 * with it, so the only honest proof is a process that never saw the first one.
 *
 * Both invocations build the SAME stage from the SAME TypeScript. The only difference is
 * the world: `start` is told to hang in the middle step, `restart` is not.
 */

const [, , libraryDir, phase] = process.argv
if (!libraryDir || (phase !== 'start' && phase !== 'restart')) {
  throw new Error('usage: crash-fixture.ts <libraryDir> <start|restart>')
}

const stepLog = join(libraryDir, 'steps.log')
const databaseFile = join(libraryDir, 'showrunner.db')

/** Every execution of every step, in both processes, appended to one file. */
function record(stepName: string): void {
  appendFileSync(stepLog, `${process.pid} ${stepName}\n`, 'utf8')
}

const buildShotManifest: Step = {
  name: 'build-shot-manifest',
  async execute() {
    record('build-shot-manifest')
    return { shots: 14 }
  },
}

const generateShots: Step = {
  name: 'generate-shots',
  lock: 'image-api',
  inputs: ['build-shot-manifest'],
  async execute(context) {
    record('generate-shots')
    const manifest = context.input<{ shots: number }>('build-shot-manifest')
    if (phase === 'start') {
      // The long generation the process is killed in the middle of. It never settles;
      // the parent reads the line below and sends SIGKILL.
      process.stdout.write('mid-step generate-shots\n')
      await new Promise<never>(() => {})
    }
    return { generated: manifest.shots }
  },
}

const assemble: Step = {
  name: 'assemble',
  inputs: ['generate-shots'],
  async execute(context) {
    record('assemble')
    return { assembled: context.input<{ generated: number }>('generate-shots').generated }
  },
}

const STAGES: StageCatalogue = {
  'produce-shot-images': {
    name: 'produce-shot-images',
    steps: [buildShotManifest, generateShots, assemble],
  },
}

const store = openStore(databaseFile)
migrate(store)

if (phase === 'start') {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  const episode = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })

  const runner = createRunner(store, STAGES)
  const run = runner.enqueueRun({ episodeId: episode.id, stage: 'produce-shot-images' })
  process.stdout.write(`started ${run.id}\n`)
  await hangForever()
} else {
  // A brand-new runner that has only ever seen the database. Nothing was handed to it.
  const runner = createRunner(store, STAGES)
  const resumed = runner.resumeInterrupted()
  process.stdout.write(`resuming ${resumed.length}\n`)
  for (const run of resumed) {
    const settled = await runner.settled(run.id)
    process.stdout.write(`finished ${settled.id} ${settled.status}\n`)
  }
  store.close()
}

/**
 * Keeps the `start` process alive for the kill.
 *
 * The timer is load-bearing. A never-resolving promise does not hold Node open on its own —
 * neither this one nor the one the step above is parked on: the event loop empties, Node
 * calls it an unsettled top-level await and exits 13. The parent normally wins that race
 * by microseconds, and when it loses, the test kills a process that had already died of
 * its own accord and proves nothing about surviving anything. A flaky durability test is
 * the worst kind: it goes red, everyone assumes the test is wrong, and the suite starts
 * being re-run until green. The handle makes the process wait to be killed.
 */
function hangForever(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, 1_000)
  })
}
