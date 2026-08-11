import { useCallback, useEffect, useState } from 'react'
import type { SayOnTheBench } from '../../server/check-bench.ts'
import type {
  ArtifactInTheRoom,
  ArcInTheRoom,
  EpisodeRoomView,
  FindingCard,
  GateDoor,
  SceneOnTheGrid,
  StageInTheRoom,
} from '../../server/episode-room.ts'
import type { EventRecord } from '../../server/events.ts'
import type { ProposalOnTheBench } from '../../server/canon-bench.ts'
import type { StepInTheRoom } from '../../server/writing-room.ts'
import { Card, CardRow, Section } from '../chrome/Card.tsx'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { Freshness } from '../chrome/Freshness.tsx'
import { LifecycleTrack } from '../chrome/LifecycleTrack.tsx'
import { LiveRegion } from '../chrome/LiveRegion.tsx'
import { onLinkClick } from '../chrome/router.ts'
import { needing, SentenceButton, SentenceLink } from '../chrome/SentenceButton.tsx'
import type { ScreenProps } from '../chrome/Shell.tsx'
import { applyProse, type Prose } from './Floor.tsx'
import './episode-room.css'

/**
 * **The episode room** — one episode, everything about it (E5-2, #82; 5.2, D14;
 * `mockups/episode-room.html`).
 *
 * ── What it is ─────────────────────────────────────────────────────────────────
 * A composition of three reads and nothing else. The scene grid is the continuity board's
 * own rows; the artifacts are `edit.ts`'s freshness with E4-5's two doors on them; the
 * findings are the check bench's clusters with 4.3's three remediations behind each say; the
 * riders are the completion sweep; the rail is the stage catalogue's own offers. **This file
 * writes no word** — every sentence, cost, refusal and column name comes down the wire, and
 * `episode-room.test.tsx` proves it the way `floor.test.tsx` does: hand it a view of empty
 * strings and see whether anything comes out.
 *
 * ── The pip is the floor's, and that is the point ──────────────────────────────
 * Ryan ruled the three states on Aug 11: done / current-**amber** / running-**blue,
 * pulsing**. This room's own mockup paints a merely-current stage blue, and that spelling is
 * overruled — so the track here is `LifecycleTrack` fed by `floor.ts`'s `lifecycleStops`, the
 * same component and the same composer the floor uses. A second pip implementation is exactly
 * the drift the chrome exists to prevent (`chrome/LifecycleTrack.tsx` carries the ruling).
 *
 * ── What it can DO, and what it sends you elsewhere for ────────────────────────
 * It starts a stage, types over a draft or one scene of it, remediates a finding, re-checks a
 * scene, moves an arc pin, and rules the riders of the completion sweep one at a time. Every
 * one of those is a route that existed before this issue.
 *
 * **It does not rule at a gate.** Every gate is a link into the gate room (#83), carrying that
 * room's own honesty about what it can do today — one decision, one room, which is E5-1's
 * precedent. And it does not decide what needs him; that is the floor's read.
 *
 * ── Live, in place ─────────────────────────────────────────────────────────────
 * A run's prose lands in the rail's `LiveRegion` and nowhere else, through E5-1's protocol
 * unchanged: every line carries the `seq` it is as of, anything at or below it is dropped, and
 * a transition re-reads the whole room rather than patching it. The re-read cannot move
 * anything — `episode-room.css` gives every region that can change a fixed height and its own
 * scrollbar, and `episode-room.test.tsx` fails when that stops being true.
 */

/** What Ryan has typed in this room and not yet sent. Every field is one field on one screen. */
export interface RoomDraft {
  /** The scene edit box that is open, with his words in it. Null when none is. */
  scene: { sceneId: string; text: string } | null
  /** The whole-draft edit box that is open, with his words in it. Null when none is. */
  artifact: { artifactId: string; text: string } | null
  /** Per finding: the replacement, the dismissal note, the new statement, the last pre-draft. */
  replacements: Record<string, string>
  notes: Record<string, string>
  statements: Record<string, string>
  drafted: Record<string, string>
  /** Per rider: the note a rejection needs. */
  riderNotes: Record<string, string>
  /** Which writer's desk is folded open, by step. Reading one is free, so it is a fold. */
  openDesk: string | null
}

export const EMPTY_DRAFT: RoomDraft = {
  scene: null,
  artifact: null,
  replacements: {},
  notes: {},
  statements: {},
  drafted: {},
  riderNotes: {},
  openDesk: null,
}

export function EpisodeRoom({ id, cockpit }: ScreenProps) {
  const [view, setView] = useState<EpisodeRoomView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [stream, setStream] = useState<EpisodeRoomView['stream'] | null>(null)
  const [prose, setProse] = useState<Prose>({})
  const [draft, setDraft] = useState<RoomDraft>(EMPTY_DRAFT)

  const load = useCallback(async (): Promise<void> => {
    if (id === null) return
    try {
      const res = await fetch(`/api/episode/${id}`)
      if (!res.ok) {
        setProblem(((await res.json()) as { error?: string }).error ?? null)
        return
      }
      const next = (await res.json()) as EpisodeRoomView
      setView(next)
      setStream((held) => held ?? next.stream)
      setProse((held) => seedLive(held, next))
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!stream) return
    // Opened at the position the first read was taken from, so the replay is the gap rather
    // than the whole log. Anything served twice is dropped by `applyProse`'s own seq check —
    // E5-1's protocol, reused rather than reinvented.
    const source = new EventSource(`/api/events?since=${stream.since}`)
    for (const kind of stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        setProse((held) => applyProse(held, record))
        if (stream.prose.includes(record.kind)) return
        void load()
      })
    }
    return () => source.close()
  }, [stream, load])

  /** One act, one refusal path: the API answers in the words the button was already showing. */
  const act = useCallback(
    async (key: string, path: string, body: unknown, after?: () => void): Promise<void> => {
      setBusy(key)
      setProblem(null)
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const answered = (await res.json()) as { error?: string; sentence?: string }
        if (!res.ok) setProblem(answered.error ?? null)
        else after?.()
        await load()
      } catch (error) {
        setProblem(`The API did not answer: ${String(error)}`)
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? cockpit.destinations[1]!.explains}
      </p>
    )
  }

  const script = view.checks.artifact.id

  return (
    <EpisodeRoomScreen
      view={view}
      prose={prose}
      draft={draft}
      busy={busy}
      problem={problem}
      onDraft={(next) => setDraft((held) => ({ ...held, ...next }))}
      onLaunch={(stage) => void act(stage, '/api/run', { episodeId: view.episodeId, stage })}
      onOpenScene={(sceneId, text) => setDraft((held) => ({ ...held, scene: { sceneId, text } }))}
      onLandScene={() =>
        void act(
          'scene-edit',
          `/api/artifact/${script}/edit`,
          { sceneId: draft.scene?.sceneId, text: draft.scene?.text ?? '' },
          () => setDraft((held) => ({ ...held, scene: null })),
        )
      }
      onOpenArtifact={(artifactId) => {
        void (async () => {
          const res = await fetch(`/api/artifact/${artifactId}`)
          const held = (await res.json()) as { text?: string | null; error?: string }
          if (!res.ok) setProblem(held.error ?? null)
          else setDraft((was) => ({ ...was, artifact: { artifactId, text: held.text ?? '' } }))
        })()
      }}
      onLandArtifact={() =>
        void act(
          'artifact-edit',
          `/api/artifact/${draft.artifact?.artifactId}/edit`,
          { text: draft.artifact?.text ?? '' },
          () => setDraft((held) => ({ ...held, artifact: null })),
        )
      }
      onPredraft={(findingId) => {
        setBusy(findingId)
        setProblem(null)
        void (async () => {
          try {
            const res = await fetch(`/api/finding/${findingId}/predraft`, { method: 'POST' })
            const held = (await res.json()) as {
              error?: string
              replacement?: string
              sentence?: string
            }
            if (!res.ok) setProblem(held.error ?? null)
            else
              setDraft((was) => ({
                ...was,
                replacements: { ...was.replacements, [findingId]: held.replacement ?? '' },
                drafted: { ...was.drafted, [findingId]: held.sentence ?? '' },
              }))
            await load()
          } finally {
            setBusy(null)
          }
        })()
      }}
      onApply={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/rewrite`, {
          replacement: draft.replacements[findingId] ?? '',
        })
      }
      onPropose={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/canon-change`, {
          statement: draft.statements[findingId] ?? '',
        })
      }
      onDismiss={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/dismiss`, {
          note: draft.notes[findingId] ?? '',
        })
      }
      onRecheck={(sceneId) => void act(sceneId, `/api/artifact/${script}/recheck`, { sceneId })}
      onDeclare={(arcId, waypointId) =>
        void act(waypointId, `/api/canon/episode/${view.episodeId}/position`, { arcId, waypointId })
      }
      onRule={(proposalId, verdict) =>
        void act(proposalId, `/api/sweep/proposal/${proposalId}/${verdict}`, {
          note: draft.riderNotes[proposalId] ?? '',
        })
      }
    />
  )
}

/**
 * The prose a browser missed, off the server's read — so a page opened mid-run shows the line
 * the step is on rather than an empty box. Seeded once per run and never overwritten, for
 * `Floor.tsx`'s reason: after the first chunk the browser has the fuller picture.
 */
export function seedLive(held: Prose, view: EpisodeRoomView): Prose {
  const live = view.live
  if (live.runId === null || held[live.runId] !== undefined) return held
  return {
    ...held,
    [live.runId]: { latest: live.latest, chunks: [...live.stream], seq: live.seq },
  }
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface EpisodeRoomScreenProps {
  view: EpisodeRoomView
  prose: Prose
  draft: RoomDraft
  busy: string | null
  problem: string | null
  onDraft(next: Partial<RoomDraft>): void
  onLaunch(stage: string): void
  onOpenScene(sceneId: string, text: string): void
  onLandScene(): void
  onOpenArtifact(artifactId: string): void
  onLandArtifact(): void
  onPredraft(findingId: string): void
  onApply(findingId: string): void
  onPropose(findingId: string): void
  onDismiss(findingId: string): void
  onRecheck(sceneId: string): void
  onDeclare(arcId: string, waypointId: string): void
  onRule(proposalId: string, verdict: 'ratify' | 'reject' | 'defer'): void
}

export function EpisodeRoomScreen(props: EpisodeRoomScreenProps) {
  const { view } = props
  const said = view.live.runId === null ? undefined : props.prose[view.live.runId]

  return (
    <div className="room">
      <header className="room-head">
        <div>
          <p className="crumb">
            <a
              className="room-crumb__back"
              href={view.floorHref}
              onClick={onLinkClick(view.floorHref)}
            >
              {view.floorName}
            </a>{' '}
            · {view.where}
          </p>
          <span className="room-head__num">{view.label}</span>
          <h1>{view.title}</h1>
          <span className="room-head__standing">{view.standing}</span>
        </div>
        {/*
         * The ruled three states, from the floor's own component and the floor's own composer.
         * This room's mockup paints a merely-current stage blue; that is overruled (see the
         * header above and `chrome/LifecycleTrack.tsx`).
         */}
        <LifecycleTrack stops={view.track} label={view.trackLabel} />
      </header>

      <div className="room-cols stacks">
        <div className="room-main">
          <Grid {...props} />
          <Artifacts {...props} />
          <Findings {...props} />
          <Desks {...props} />
          <CriedWolf view={view} />
        </div>

        <div className="room-rail">
          <Card className="room-panel">
            {/*
             * Always rendered, idle or not. A region that appeared when a run started would
             * move the page by existing, which is the defect it exists to end (E5-0).
             */}
            <div className="room-body room-body--live">
              <LiveRegion
                id={`live-${view.episodeId}`}
                heading={view.live.heading}
                latest={said?.latest ?? view.live.latest}
                stream={said?.chunks ?? view.live.stream}
                entries={view.live.entries}
                idle={view.live.idle}
              />
            </div>
          </Card>

          <Rail {...props} />
          <Gates view={view} />
          <Riders {...props} />
          <Arcs {...props} />
          <Ledger view={view} />
        </div>
      </div>

      {props.problem !== null && (
        <p className="room-problem" role="alert">
          {props.problem}
        </p>
      )}
    </div>
  )
}

// ── Board-first: the scene grid, which is the room's face ───────────────────────

/**
 * The continuity board as UI (3.2b): scenes down, the board's own readings across, and the
 * deterministic verdicts where a rule meets a scene.
 *
 * **Nothing here is computed.** Every cell is a `board_scene` / `board_presence` row and every
 * verdict is a say the check bench already composed; the grid's health is `panel.ts`'s own
 * verdict word with `panel.ts`'s own sentence and the check bench's sentence for what would
 * answer it. If this component ever starts deciding what a row means, it has stopped being a
 * grid and started being a rule.
 */
function Grid(props: EpisodeRoomScreenProps) {
  const { view, draft } = props
  const grid = view.grid

  return (
    <Section
      name={view.headings.grid.name}
      explains={view.headings.grid.explains}
      className="room-panel"
    >
      <div className="room-body room-body--grid">
        {grid.notYet !== null ? (
          <EmptyState lead={grid.notYet.lead} sentence={grid.notYet.sentence}>
            <div className="room-offer">
              <SentenceButton
                offer={grid.notYet.build}
                busy={props.busy === grid.notYet.stage}
                onClick={() => props.onLaunch(grid.notYet!.stage)}
                wide
                dense
              />
            </div>
          </EmptyState>
        ) : (
          <>
            <div className="room-grid__head">
              <p className="room-grid__health">
                {grid.health.map((verdict) => (
                  <span
                    className="room-verdict"
                    key={verdict.checkKey}
                    data-verdict={verdict.verdict}
                    data-check={verdict.checkKey}
                    title={verdict.fix ?? verdict.what}
                  >
                    {verdict.checkKey} · {verdict.verdict} — {verdict.what}
                    {verdict.fix !== null && <> · {verdict.fix}</>}
                  </span>
                ))}
              </p>
              <p className="room-grid__built">{grid.builtFrom}</p>
              <p className="room-grid__built">{grid.sentence}</p>
              <Freshness standing={grid.standing} because={grid.freshness} stale={grid.stale} />
            </div>

            <div className="scrolls-sideways">
              <table className="room-scenes">
                <thead>
                  <tr>
                    {grid.columns.map((column, index) => (
                      <th key={index}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.flatMap((scene) => [
                    <Scene key={scene.sceneId} scene={scene} {...props} />,
                    ...says(scene, grid.columns.length),
                  ])}
                </tbody>
              </table>
            </div>

            {grid.transits.map((transit) => (
              <span className="room-arc__note" key={transit.sentence}>
                {transit.sentence}
              </span>
            ))}
            {grid.hazards.map((hazard) => (
              <span className="room-arc__note" key={hazard.factId}>
                {hazard.sentence}
              </span>
            ))}
          </>
        )}
        {draft.scene !== null && grid.notYet === null && <SceneBox {...props} />}
      </div>
    </Section>
  )
}

function Scene({ scene, ...props }: { scene: SceneOnTheGrid } & EpisodeRoomScreenProps) {
  return (
    <tr id={`scene-${scene.sceneId}`}>
      <td className="room-scenes__num">{scene.ordinal}</td>
      <td>{scene.location}</td>
      <td className="room-scenes__who">{scene.present}</td>
      <td>
        <span className={`room-env ${scene.exposed ? 'room-env--exposed' : ''}`.trim()}>
          {scene.environment}
        </span>
      </td>
      <td>{scene.ship}</td>
      <td>{scene.elapsed}</td>
      <td>
        {/*
         * D14's door. It opens a box rather than spending anything, which is why it is an
         * `.editlink` and not a `.btn` — the priced button is the one that LANDS it.
         */}
        <button
          type="button"
          className="editlink"
          id={`edit-scene-${scene.sceneId}`}
          disabled={!scene.edit.enabled}
          title={scene.edit.blockedBecause ?? scene.edit.sentence}
          onClick={() => props.onOpenScene(scene.sceneId, scene.text)}
        >
          {scene.editLabel}
        </button>
      </td>
    </tr>
  )
}

/**
 * **Where the row meets the scene**: what the deterministic rules said about it, in the say's
 * own sentence, with D12's sentence on the ones the wall is standing on. Never a verdict this
 * grid worked out — these are the check bench's says, filtered to the deterministic tier.
 *
 * A row of its own, under the scene it is about and across the whole table, because a say is
 * a sentence and a column wide enough for one would push the edit door off the grid.
 */
function says(scene: SceneOnTheGrid, columns: number) {
  if (scene.verdicts.length === 0 && scene.recheck === null) return []
  return [
    <tr key={`${scene.sceneId}-says`} id={`scene-says-${scene.sceneId}`}>
      <td colSpan={columns}>
        {scene.verdicts.map((say) => (
          <span
            className="room-scenes__say"
            key={say.findingId}
            data-blocking={say.blocking}
            title={say.blockingSentence ?? say.concern}
          >
            {say.sentence} — {say.concern}
          </span>
        ))}
        {scene.recheck !== null && (
          <span className="room-scenes__say" data-blocking="false">
            {scene.recheck.sentence}
          </span>
        )}
      </td>
    </tr>,
  ]
}

/**
 * The open scene box: his words, and the button that lands them.
 *
 * It grows the grid's own scroll box and nothing else, and it grows because he clicked — the
 * one movement this page allows (`episode-room.css`, and the ratchet's invariant).
 */
function SceneBox(props: EpisodeRoomScreenProps) {
  const open = props.draft.scene!
  const scene = props.view.grid.rows.find((one) => one.sceneId === open.sceneId)
  if (!scene) return null

  return (
    <div className="room-editbox">
      <textarea
        id="scene-edit-box"
        rows={12}
        value={open.text}
        onChange={(event) =>
          props.onDraft({ scene: { sceneId: open.sceneId, text: event.target.value } })
        }
      />
      <div className="room-offer">
        <SentenceButton
          offer={needing(scene.edit, open.text, props.view.refusals.needsText)}
          busy={props.busy === 'scene-edit'}
          onClick={() => props.onLandScene()}
          wide
          dense
        />
      </div>
    </div>
  )
}

// ── Artifacts, with freshness in words and both of Ryan's doors ─────────────────

function Artifacts(props: EpisodeRoomScreenProps) {
  const { view, draft } = props
  return (
    <Section
      name={view.headings.artifacts.name}
      explains={view.headings.artifacts.explains}
      className="room-panel"
    >
      <div className="room-body room-body--artifacts">
        {view.noArtifacts !== null ? (
          <EmptyState lead={view.noArtifacts.lead} sentence={view.noArtifacts.sentence} />
        ) : (
          view.artifacts.map((artifact) => (
            <Artifact key={artifact.id} artifact={artifact} {...props} />
          ))
        )}
        {draft.artifact !== null && <ArtifactBox {...props} />}
      </div>
    </Section>
  )
}

function Artifact({
  artifact,
  ...props
}: { artifact: ArtifactInTheRoom } & EpisodeRoomScreenProps) {
  return (
    <div className="room-art" id={`artifact-${artifact.id}`}>
      <span className="room-art__name">
        {artifact.kind} {artifact.slot} v{artifact.version}
      </span>
      <Freshness standing={artifact.standing} because={null} stale={artifact.stale} />
      <span className="room-art__because">{artifact.because}</span>
      {artifact.notes.map((note) => (
        <span className="room-art__because" key={note.note}>
          {note.sentence}
        </span>
      ))}
      <span className="room-art__doors">
        {artifact.present !== null && (
          <SentenceButton
            offer={artifact.present}
            busy={props.busy === artifact.presentStage}
            onClick={() => props.onLaunch(artifact.presentStage!)}
            dense
          />
        )}
        <SentenceButton
          offer={artifact.edit}
          busy={props.busy === 'artifact-edit'}
          onClick={() => props.onOpenArtifact(artifact.id)}
          dense
          quiet
        />
      </span>
    </div>
  )
}

/** The whole-draft edit door E4-5 built, beside the scene-level one. Both land the same way. */
function ArtifactBox(props: EpisodeRoomScreenProps) {
  const open = props.draft.artifact!
  const artifact = props.view.artifacts.find((one) => one.id === open.artifactId)
  if (!artifact) return null

  return (
    <div className="room-editbox">
      <textarea
        id="artifact-edit-box"
        rows={14}
        value={open.text}
        onChange={(event) =>
          props.onDraft({ artifact: { artifactId: open.artifactId, text: event.target.value } })
        }
      />
      <div className="room-offer">
        <SentenceButton
          offer={needing(artifact.edit, open.text, props.view.refusals.needsText)}
          busy={props.busy === 'artifact-edit'}
          onClick={() => props.onLandArtifact()}
          wide
          dense
        />
      </div>
    </div>
  )
}

// ── Findings: checks argue, never veto ──────────────────────────────────────────

function Findings(props: EpisodeRoomScreenProps) {
  const { view } = props
  const checks = view.checks

  return (
    <Section
      name={view.headings.findings.name}
      explains={view.headings.findings.explains}
      className="room-panel"
    >
      <div className="room-body room-body--findings">
        {checks.emptyBecause !== null && (
          <EmptyState lead={checks.board.sentence} sentence={checks.emptyBecause} />
        )}

        {/* Everything a reviewer could not check at all — never folded into a silence (0012). */}
        {checks.gaps.map((gap, index) => (
          <p className="room-finding__where" key={`${gap.checkKey}-${index}`}>
            {gap.checkKey} · {gap.reason} — {gap.detail}
          </p>
        ))}

        {view.findings.map((card, index) => (
          <Finding key={index} card={card} {...props} />
        ))}

        {/*
         * The paid half a rewrite deliberately did not run (D14). It cannot come off the cards
         * above — a finding awaiting a re-check is one this draft has already moved past, so it
         * has left them by construction (`remediation.ts`).
         */}
        {checks.rechecks.map((recheck) => (
          <div className="room-offer" key={recheck.sceneId}>
            <SentenceButton
              offer={recheck.offer}
              busy={props.busy === recheck.sceneId}
              onClick={() => props.onRecheck(recheck.sceneId)}
              wide
              dense
            />
          </div>
        ))}
      </div>
    </Section>
  )
}

/** One card: a span of the artifact, the sentence that says where it is, and every say on it. */
function Finding({ card, ...props }: { card: FindingCard } & EpisodeRoomScreenProps) {
  return (
    <div className="room-finding">
      <div className="room-finding__top">
        <span className="room-finding__where">{card.where}</span>
      </div>
      {card.quote !== '' && <span className="room-finding__quote">{card.quote}</span>}
      {card.says.map((say) => (
        <Say key={say.findingId} say={say} {...props} />
      ))}
    </div>
  )
}

/**
 * One reviewer's say, and 4.3's three buttons behind it.
 *
 * Severity and confidence arrive side by side inside `say.sentence`, composed by `panel.ts`
 * where a say is defined — two values, never one (invariant 4), and never folded into a tick.
 */
function Say({ say, ...props }: { say: SayOnTheBench } & EpisodeRoomScreenProps) {
  const { draft, view } = props
  const id = say.findingId
  const replacement = draft.replacements[id] ?? ''
  const statement = draft.statements[id] ?? ''
  const note = draft.notes[id] ?? ''

  return (
    <div id={`finding-${id}`}>
      <div className="room-finding__top">
        <span className={`tag ${say.blocking ? 'tag--critical' : 'tag--warn'}`}>{say.status}</span>
        <span className="room-finding__where">{say.sentence}</span>
      </div>
      <p className="room-finding__concern">{say.concern}</p>
      {say.facts.map((fact) => (
        <span className="room-finding__where" key={fact}>
          {fact}
        </span>
      ))}
      {say.blockingSentence !== null && (
        <span className="room-finding__where">{say.blockingSentence}</span>
      )}
      {say.dismissal !== null && (
        <span className="room-finding__where">
          {say.dismissal.note} · {say.dismissal.at}
        </span>
      )}
      {/* E3-6's loop, closed on screen: an open twin, and why the wall stayed down. */}
      {say.inherited !== null && (
        <span className="room-finding__where">{say.inherited.sentence}</span>
      )}
      {draft.drafted[id] !== undefined && (
        <span className="room-finding__where">{draft.drafted[id]}</span>
      )}

      <label>
        {say.remediations.apply.sentence}
        <textarea
          rows={3}
          value={replacement}
          onChange={(event) =>
            props.onDraft({ replacements: { ...draft.replacements, [id]: event.target.value } })
          }
        />
      </label>
      <div className="room-finding__acts">
        <SentenceButton
          offer={say.remediations.predraft}
          busy={props.busy === id}
          onClick={() => props.onPredraft(id)}
          dense
        />
        <SentenceButton
          offer={needing(
            say.remediations.apply,
            replacement,
            view.checks.refusals.rewriteNeedsReplacement,
          )}
          busy={props.busy === id}
          onClick={() => props.onApply(id)}
          dense
        />
      </div>

      <label>
        {say.remediations.propose.sentence}
        <input
          value={statement}
          onChange={(event) =>
            props.onDraft({ statements: { ...draft.statements, [id]: event.target.value } })
          }
        />
      </label>
      <label>
        {say.remediations.dismiss.sentence}
        <textarea
          rows={2}
          value={note}
          onChange={(event) =>
            props.onDraft({ notes: { ...draft.notes, [id]: event.target.value } })
          }
        />
      </label>
      <div className="room-finding__acts">
        <SentenceButton
          offer={needing(
            say.remediations.propose,
            statement,
            view.checks.refusals.changeNeedsStatement,
          )}
          busy={props.busy === id}
          onClick={() => props.onPropose(id)}
          dense
        />
        <SentenceButton
          offer={needing(say.remediations.dismiss, note, view.checks.refusals.dismissNeedsNote)}
          busy={props.busy === id}
          onClick={() => props.onDismiss(id)}
          dense
          quiet
        />
      </div>
    </div>
  )
}

// ── The writer's desk, given its cockpit home (E4-7's one new render) ───────────

function Desks(props: EpisodeRoomScreenProps) {
  const { view, draft } = props
  return (
    <Section
      name={view.headings.desk.name}
      explains={view.headings.desk.explains}
      className="room-panel"
    >
      <div className="room-body room-body--desk">
        {view.writing.line.map((step) => (
          <Desk
            key={step.step}
            step={step}
            open={draft.openDesk === step.step}
            onOpen={() => props.onDraft({ openDesk: draft.openDesk === step.step ? null : step.step })}
          />
        ))}
      </div>
    </Section>
  )
}

/**
 * What a writer would be handed if the stage above were clicked — E4-0's `WriteContext`, in
 * its own vocabulary, and a fold rather than a fetch because reading it is free (invariant 5).
 */
function Desk({
  step,
  open,
  onOpen,
}: {
  step: StepInTheRoom
  open: boolean
  onOpen: () => void
}) {
  const desk = step.desk
  return (
    <CardRow className={`room-desk ${step.current ? 'room-desk--current' : ''}`.trim()}>
      <button type="button" className="editlink" id={`desk-${step.step}`} onClick={onOpen}>
        {desk.sentence}
      </button>
      {open && (
        <>
          <span className="room-arc__note">{desk.upstream.note ?? desk.upstream.text}</span>
          {desk.entities.map((entity) => (
            <div key={entity.id}>
              <span className="room-art__name">
                {entity.name} · {entity.categoryKey} · {entity.standing} · {entity.status}
              </span>
              {entity.reasons.map((reason) => (
                <span className="room-arc__note" key={reason.reason}>
                  {reason.because}
                </span>
              ))}
              {entity.facts.map((fact) => (
                <span className="room-arc__note" key={fact.id}>
                  {fact.statement} — {fact.reachSentence}
                  {fact.inherited !== null && (
                    <>
                      {' '}
                      · {fact.inherited.source} · {fact.inherited.via}
                    </>
                  )}
                </span>
              ))}
              {entity.gaps.map((gap) => (
                <span className="room-arc__note" key={gap.via}>
                  {gap.because}
                </span>
              ))}
            </div>
          ))}
          {/* The half that cannot be inferred from what WAS included (E4-0). */}
          {desk.leftOut.map((entity) => (
            <span className="room-arc__note" key={entity.id}>
              {entity.name} — {entity.because}
            </span>
          ))}
          {desk.arcs.map((arc) => (
            <span className="room-arc__note" key={arc.arcId}>
              {arc.sentence}
            </span>
          ))}
          {/* Ryan's own words, with the three authorities kept apart (D21). */}
          {desk.notes.map((note) => (
            <span className="room-arc__note" key={`${note.origin}-${note.at}-${note.note}`}>
              {note.note} — {note.originSentence}
            </span>
          ))}
          <span className="room-arc__note">{desk.promptCaveat}</span>
          <pre className="room-finding__quote">{desk.prompt}</pre>
        </>
      )}
    </CardRow>
  )
}

// ── D11: reviewing the reviewers. A question, and nothing acts on it. ───────────

function CriedWolf({ view }: { view: EpisodeRoomView }) {
  return (
    <Section
      name={view.headings.criedWolf.name}
      explains={view.headings.criedWolf.explains}
      className="room-panel"
    >
      <div className="room-body room-body--wolf">
        {view.checks.tune.map((sentence) => (
          <p className="room-finding__concern" key={sentence}>
            {sentence}
          </p>
        ))}
        {view.criedWolf.map((one) => (
          <p className="room-finding__where" key={one.checkKey}>
            <b className="room-art__name">{one.checkKey}</b> {one.sentence}
          </p>
        ))}
      </div>
    </Section>
  )
}

// ── The stage rail ──────────────────────────────────────────────────────────────

/**
 * Every stage this build has, with its offer for this episode — and the blocked ones rendered
 * disabled with the reason in words, which is where D12's wall appears: on the producing
 * button it refuses, in the same sentence the API refuses the POST with.
 */
function Rail(props: EpisodeRoomScreenProps) {
  const { view } = props
  return (
    <Section
      name={view.headings.rail.name}
      explains={view.headings.rail.explains}
      className="room-panel"
    >
      <div className="room-body room-body--rail">
        {/*
         * A box that is there whether or not a wall is. A check landing is the system's
         * doing, so it may not move the buttons under it — the space is reserved instead.
         */}
        <div className="room-rail__news">
          {view.rail.wall !== null && <span className="room-rail__wall">{view.rail.wall}</span>}
          {view.rail.queued !== null && (
            <span className="room-rail__queued">{view.rail.queued}</span>
          )}
        </div>
        {view.rail.stages.map((stage) => (
          <Offer key={stage.stage} stage={stage} {...props} />
        ))}
        <span className="room-rail__later">{view.rail.notInThisBuild}</span>
      </div>
    </Section>
  )
}

function Offer({ stage, ...props }: { stage: StageInTheRoom } & EpisodeRoomScreenProps) {
  return (
    <div className="room-offer" id={`stage-${stage.stage}`} data-work={stage.work}>
      <SentenceButton
        offer={stage.offer}
        busy={props.busy === stage.stage}
        onClick={() => props.onLaunch(stage.stage)}
        wide
        dense
        ruling={stage.work === 'reads'}
      />
    </div>
  )
}

// ── The gates: a link, never a ruling (#83 rules; this room links) ──────────────

function Gates({ view }: { view: EpisodeRoomView }) {
  return (
    <Section
      name={view.headings.gates.name}
      explains={view.headings.gates.explains}
      className="room-panel"
    >
      <div className="room-body room-body--gates">
        {view.rail.noGates !== null ? (
          <EmptyState lead={view.rail.noGates.lead} sentence={view.rail.noGates.sentence} />
        ) : (
          view.rail.gates.map((gate) => <Gate key={gate.gateId} gate={gate} />)
        )}
      </div>
    </Section>
  )
}

function Gate({ gate }: { gate: GateDoor }) {
  return (
    <div className="room-door" id={`gate-${gate.gateId}`}>
      <span className="room-door__standing">{gate.standing}</span>
      <SentenceLink
        offer={gate.open}
        href={gate.href}
        ruling={gate.isOpen}
        dense
        title={gate.roomNotYet ?? undefined}
      />
      <span className="room-door__standing" title={gate.roomNotYet ?? undefined}>
        {gate.room}
      </span>
    </div>
  )
}

// ── What rides this episode: the completion sweep, one rider at a time ─────────

/**
 * The riders, each with its five parts and its own three verbs. **There is deliberately no
 * button that rules the pass** — three riders take three rulings and leave three rows on the
 * ledger (1.2, and E4-6's ledger entry forbids a fourth button in as many words).
 */
function Riders(props: EpisodeRoomScreenProps) {
  const { view } = props
  const sweep = view.sweep
  return (
    <Section
      name={view.headings.riders.name}
      explains={view.headings.riders.explains}
      className="room-panel"
    >
      <div className="room-body room-body--riders">
        <p className="room-rider__what">{sweep.sentence}</p>
        {sweep.nothingBecause !== null && (
          <span className="room-rider__part">{sweep.nothingBecause}</span>
        )}
        {sweep.riders.map((rider) => (
          <Rider key={rider.id} rider={rider} {...props} />
        ))}
        {sweep.ruled.map((rider) => (
          <span className="room-rider__part" key={rider.id}>
            {rider.status} — {rider.sentence}
          </span>
        ))}
      </div>
    </Section>
  )
}

function Rider({ rider, ...props }: { rider: ProposalOnTheBench } & EpisodeRoomScreenProps) {
  const note = props.draft.riderNotes[rider.id] ?? ''
  return (
    <div className="room-rider" id={`rider-${rider.id}`}>
      <span className="room-rider__what">{rider.sentence}</span>
      {rider.change.map((line) => (
        <span className="room-rider__part" key={line}>
          {line}
        </span>
      ))}
      <span className="room-rider__part">{rider.usageContext}</span>
      {/* Computed at read time and never stored — the freshness pattern (1.2). */}
      <span className="room-rider__part">{rider.implications}</span>
      {rider.alternatives.map((alternative) => (
        <span className="room-rider__part" key={alternative}>
          {alternative}
        </span>
      ))}
      <div className="room-offer">
        <SentenceButton
          offer={rider.ratify}
          busy={props.busy === rider.id}
          onClick={() => props.onRule(rider.id, 'ratify')}
          wide
          dense
          ruling
        />
      </div>
      <label>
        {rider.reject.sentence}
        <textarea
          rows={2}
          value={note}
          onChange={(event) =>
            props.onDraft({ riderNotes: { ...props.draft.riderNotes, [rider.id]: event.target.value } })
          }
        />
      </label>
      <div className="room-offer">
        <SentenceButton
          offer={needing(rider.reject, note, props.view.sweep.refusals.rejectNeedsNote)}
          busy={props.busy === rider.id}
          onClick={() => props.onRule(rider.id, 'reject')}
          wide
          dense
        />
      </div>
      <div className="room-offer">
        <SentenceButton
          offer={rider.defer}
          busy={props.busy === rider.id}
          onClick={() => props.onRule(rider.id, 'defer')}
          wide
          dense
          quiet
        />
      </div>
    </div>
  )
}

// ── The arcs this episode is written under ─────────────────────────────────────

function Arcs(props: EpisodeRoomScreenProps) {
  const { view } = props
  return (
    <Section
      name={view.headings.arcs.name}
      explains={view.headings.arcs.explains}
      className="room-panel"
    >
      <div className="room-body room-body--arcs">
        {view.noArcs !== null ? (
          <EmptyState lead={view.noArcs.lead} sentence={view.noArcs.sentence} />
        ) : (
          view.arcs.map((arc) => <ArcRow key={arc.arcId} arc={arc} {...props} />)
        )}
      </div>
    </Section>
  )
}

function ArcRow({ arc, ...props }: { arc: ArcInTheRoom } & EpisodeRoomScreenProps) {
  return (
    <div className="room-arc" id={`arc-${arc.arcId}`}>
      <a
        className="room-arc__name"
        href={arc.href}
        onClick={onLinkClick(arc.href)}
        title={arc.roomNotYet ?? undefined}
      >
        {arc.name} <span className="room-arc__kind">{arc.kindAndScope}</span>
      </a>
      <div className="room-way">
        {arc.waypoints.map((waypoint, index) => (
          <span key={waypoint.waypointId}>
            {index > 0 && <span className="room-way__sep">·</span>}{' '}
            <span
              className="room-wp"
              data-standing={waypoint.standing}
              title={waypoint.landingCriteria}
            >
              {waypoint.ordinal} {waypoint.name}
            </span>
          </span>
        ))}
      </div>
      <span className="room-arc__note">{arc.note}</span>
      <span className="room-arc__note">{arc.statement}</span>
      {arc.waypoints.map((waypoint) => (
        <div className="room-offer" key={waypoint.waypointId}>
          <SentenceButton
            offer={waypoint.declare}
            busy={props.busy === waypoint.waypointId}
            onClick={() => props.onDeclare(arc.arcId, waypoint.waypointId)}
            wide
            dense
            quiet
          />
        </div>
      ))}
    </div>
  )
}

// ── The ledger: projection against actual ──────────────────────────────────────

/**
 * What each button projected, against what the ledger recorded — and nothing else new. Every
 * number is a `cost_entry` row through `cost.ts`, and every projection is the stage's own
 * declared cost. There is no budget here: that is the floor's tile and #88's door.
 */
function Ledger({ view }: { view: EpisodeRoomView }) {
  const ledger = view.ledger
  return (
    <Section
      name={view.headings.ledger.name}
      explains={view.headings.ledger.explains}
      className="room-panel"
    >
      <div className="room-body room-body--ledger">
        <table className="room-ledger">
          <tbody>
            {ledger.lines.map((line, index) => (
              <tr key={index} data-line={line.label}>
                <td>
                  {line.label}
                  <span className="room-ledger__detail">{line.detail}</span>
                  {line.projected !== null && (
                    <span className="room-ledger__projected">{line.projected}</span>
                  )}
                </td>
                <td>{line.spent}</td>
              </tr>
            ))}
            <tr className="room-ledger__total" id="ledger-total">
              <td>{ledger.sentence}</td>
              <td>{ledger.spent}</td>
            </tr>
          </tbody>
        </table>
        <span className="room-ledger__projection">{ledger.projection}</span>
      </div>
    </Section>
  )
}
