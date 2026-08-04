import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import {
  artifactFreshness,
  provenanceOf,
  recordArtifact,
  recordInputs,
  reviseArtifact,
  staleArtifacts,
  type Artifact,
} from './artifact.ts'
import { registerEntity } from './canon.ts'
import { createEpisode, createSeason, createShow, delineateScenes, type Scene } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

/**
 * The episode room's Artifacts panel, in miniature: a script at v3, a continuity board
 * and a shot manifest built from it whole, and one shot image per scene built from the
 * script *scoped to that scene*. Ryan then edits scene 3.
 */
function seedEpisodeRoom() {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  const episode = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })
  const scenes = delineateScenes(store, episode.id, [
    { heading: 'Mess deck' },
    { heading: 'Corridor spine' },
    { heading: 'The quiet deck (deck 9)' },
    { heading: 'Airlock bay → hull' },
    { heading: 'Bridge' },
  ])

  const script = recordArtifact(store, {
    episodeId: episode.id,
    kind: 'script',
    filePath: 'ep05/script.md',
  })
  reviseArtifact(store, script.id, { summary: 'script round 2' })
  reviseArtifact(store, script.id, { summary: 'script round 2, revised' })
  // Script is now v3 — where the mockup's episode starts.

  const board = recordArtifact(store, {
    episodeId: episode.id,
    kind: 'continuity-board',
    filePath: 'ep05/continuity.json',
    builtFrom: [{ artifactId: script.id }],
  })

  // The shot manifest numbers shots straight through the episode: scene 3 owns shots 5–7.
  const shotsPerScene = [2, 2, 3, 2, 2]
  let number = 0
  const shots = scenes.flatMap((scene, index) =>
    Array.from({ length: shotsPerScene[index]! }, () => {
      number += 1
      return recordArtifact(store, {
        episodeId: episode.id,
        kind: 'shot-image',
        slot: `shot-${String(number).padStart(2, '0')}`,
        sceneId: scene.id,
        filePath: `ep05/shot-${number}.png`,
        builtFrom: [{ artifactId: script.id, sceneId: scene.id }],
      })
    }),
  )

  return { episode, scenes, script, board, shots }
}

function sceneThree(scenes: Scene[]): Scene {
  return scenes[2]!
}

function slots(artifacts: { artifact: Artifact }[]): string[] {
  return artifacts.map((s) => s.artifact.slot).sort()
}

describe('artifacts, provenance, and computed freshness', () => {
  it('declares provenance onto the canon entities the artifact touches', () => {
    const { episode, script } = seedEpisodeRoom()
    const show = store.get<{ show_id: string }>(
      'SELECT s.show_id FROM episode e JOIN season s ON s.id = e.season_id WHERE e.id = ?',
      episode.id,
    )!
    const vessa = registerEntity(store, {
      showId: show.show_id,
      categoryKey: 'character',
      name: 'Vessa',
    })
    const ferro = registerEntity(store, {
      showId: show.show_id,
      categoryKey: 'character',
      name: 'Ferro',
    })

    recordArtifact(store, {
      episodeId: episode.id,
      kind: 'outline',
      filePath: 'ep05/outline.md',
      touches: [vessa.id, ferro.id],
      builtFrom: [{ artifactId: script.id }],
    })

    const outline = artifactFreshness(store, episode.id).find((f) => f.artifact.kind === 'outline')!
    expect(provenanceOf(store, outline.artifact.id).map((e) => e.name)).toEqual(['Ferro', 'Vessa'])
  })

  it('refuses provenance onto an entity that does not exist', () => {
    const { episode } = seedEpisodeRoom()

    expect(() =>
      recordArtifact(store, {
        episodeId: episode.id,
        kind: 'outline',
        touches: ['entity_that_never_was'],
      }),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('reports everything fresh while nothing has moved on', () => {
    const { episode } = seedEpisodeRoom()

    expect(staleArtifacts(store, episode.id)).toEqual([])
    const statuses = new Set(artifactFreshness(store, episode.id).map((f) => f.status))
    expect(statuses).toEqual(new Set(['fresh']))
  })

  it('marks an artifact not-started until it has a file', () => {
    const { episode } = seedEpisodeRoom()
    recordArtifact(store, { episodeId: episode.id, kind: 'mix' })

    const mix = artifactFreshness(store, episode.id).find((f) => f.artifact.kind === 'mix')!
    expect(mix.status).toBe('not-started')
  })

  it('goes stale for exactly the scene Ryan edited, and says what it was built from', () => {
    const { episode, scenes, script, shots } = seedEpisodeRoom()

    reviseArtifact(store, script.id, {
      summary: 'your scene-3 edit',
      touchedScenes: [sceneThree(scenes).id],
    })

    const stale = staleArtifacts(store, episode.id)
    const staleShots = stale.filter((s) => s.artifact.kind === 'shot-image')

    // "shots 5–7 (scene 3) built from script v3; your scene-3 edit made v4" — 3 stale.
    expect(slots(staleShots)).toEqual(['shot-05', 'shot-06', 'shot-07'])
    const reason = staleShots[0]!.reasons[0]!
    expect(reason).toMatchObject({
      kind: 'input-moved-on',
      consumedVersion: 3,
      currentVersion: 4,
    })
    expect(reason.kind === 'input-moved-on' && reason.input.kind).toBe('script')
    expect(reason.kind === 'input-moved-on' && reason.revisions.map((r) => r.summary)).toEqual([
      'your scene-3 edit',
    ])

    // The shots on untouched scenes are not stale — that is the whole point of the scope.
    expect(shots.filter((s) => !slots(staleShots).includes(s.slot))).toHaveLength(8)
  })

  it('stales an unscoped consumer on any revision of its input', () => {
    const { episode, scenes, script, board } = seedEpisodeRoom()

    reviseArtifact(store, script.id, {
      summary: 'your scene-3 edit',
      touchedScenes: [sceneThree(scenes).id],
    })

    const stale = staleArtifacts(store, episode.id)
    expect(stale.map((s) => s.artifact.id)).toContain(board.id)
  })

  it('carries staleness downstream — a mix built on stale shots is itself stale', () => {
    const { episode, scenes, script, shots } = seedEpisodeRoom()
    const mix = recordArtifact(store, {
      episodeId: episode.id,
      kind: 'mix',
      filePath: 'ep05/mix.wav',
      builtFrom: shots.map((shot) => ({ artifactId: shot.id })),
    })

    reviseArtifact(store, script.id, {
      summary: 'your scene-3 edit',
      touchedScenes: [sceneThree(scenes).id],
    })

    const staleMix = staleArtifacts(store, episode.id).find((s) => s.artifact.id === mix.id)!
    expect(staleMix.reasons).toHaveLength(3) // the three scene-3 shots, and nothing else
    expect(staleMix.reasons.every((r) => r.kind === 'input-is-stale')).toBe(true)
    expect(staleMix.reasons.every((r) => r.input.kind === 'shot-image')).toBe(true)
  })

  it('flips a freshness edge — script v4 → v6 leaves the board two versions behind', () => {
    const { episode, script, board } = seedEpisodeRoom()
    reviseArtifact(store, script.id, { summary: 'round 3' })
    recordInputs(store, board.id, [{ artifactId: script.id }]) // board rebuilt at v4

    reviseArtifact(store, script.id, { summary: 'round 4' })
    const atV6 = reviseArtifact(store, script.id, { summary: 'round 5' })

    expect(atV6.version).toBe(6)
    const staleBoard = staleArtifacts(store, episode.id).find((s) => s.artifact.id === board.id)!
    expect(staleBoard.reasons[0]).toMatchObject({ consumedVersion: 4, currentVersion: 6 })
    expect(
      staleBoard.reasons[0]!.kind === 'input-moved-on' &&
        staleBoard.reasons[0]!.revisions.map((r) => r.summary),
    ).toEqual(['round 4', 'round 5'])
  })

  it('goes fresh again when the artifact is rebuilt from the current version', () => {
    const { episode, scenes, script, shots } = seedEpisodeRoom()
    reviseArtifact(store, script.id, {
      summary: 'your scene-3 edit',
      touchedScenes: [sceneThree(scenes).id],
    })
    const staleShot = staleArtifacts(store, episode.id).find(
      (s) => s.artifact.kind === 'shot-image',
    )!.artifact
    const scene = shots.find((s) => s.id === staleShot.id)!.sceneId

    recordInputs(store, staleShot.id, [{ artifactId: script.id, sceneId: scene }])

    expect(staleArtifacts(store, episode.id).map((s) => s.artifact.id)).not.toContain(staleShot.id)
  })
})
