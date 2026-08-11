import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  canonBenchView,
  declareEpisodePosition,
  promoteCandidate,
  proposeFactChange,
  proposeNewFact,
  registerAndPropose,
  type BenchStanding,
  type SheetDraft,
} from './canon-bench.ts'
import { cockpitView } from './cockpit.ts'
import type { Store } from './db/store.ts'
import { artifactFreshness, findArtifact, type Artifact } from './domain/artifact.ts'
import { ENTITY_STANDING, findEntityById } from './domain/canon.ts'
import { notesOwedBy, routedNoteSentence } from './domain/routing.ts'
import { findFact } from './domain/fact.ts'
import { dismissFinding, findFinding } from './domain/finding.ts'
import { foundCanon } from './domain/founding.ts'
import { createProposalRulings, findProposal } from './domain/proposal.ts'
import { episodeInShow, findShow } from './domain/spine.ts'
import { eventsSince, type EventLog, type EventRecord } from './events.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMAdapter } from './llm/adapter.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { checkBenchView } from './check-bench.ts'
import { editArtifact, editOffer, editScene, staleSentence, writtenArtifacts } from './edit.ts'
import { episodeRoomView } from './episode-room.ts'
import { floorView } from './floor.ts'
import { findStage, launchBlockedBecause, operatingView, runView, type Offer } from './operating.ts'
import {
  applyRewrite,
  canonChangePrefill,
  predraftRewrite,
  proposeCanonChange,
  recheckScene,
  remediationsFor,
} from './remediation.ts'
import { gateIndexView, gateRoomView } from './gate-room.ts'
import {
  closingNeedsANote,
  gateStanding,
  rejectionNeedsANote,
  type NoteDraft,
  type Rulings,
} from './runner/gate.ts'
import type { Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { notOnAnEpisodeSweepBecause, sweepView } from './sweep.ts'
import { writingRoomView } from './writing-room.ts'

const WEB_ROOT = './dist/web'

/**
 * One written artifact, as the edit door hands it over: the draft itself, why it is stale,
 * what Ryan has routed at it, and the button that types over it (E4-5).
 *
 * The artifact is rendered rather than named — the same rule a gate keeps (D15, 4.6): a door
 * that handed over a path would make Ryan go and find the thing he is about to edit.
 */
export interface ArtifactOnTheWire {
  artifact: Artifact
  /** Off the volume. Null when there is nothing to read, with the reason beside it. */
  text: string | null
  note: string | null
  staleBecause: string | null
  standing: { note: string; sentence: string }[]
  edit: Offer
}

/**
 * The one app process (2.1): web UI, API, and the event stream, all here.
 *
 * ── What the API is for ─────────────────────────────────────────────────────────
 * Four verbs and three reads. Ryan launches a run, rules on a gate, and watches; the page
 * renders the sentences this process composed (operating.ts) rather than composing its
 * own. Nothing here decides anything — the runner runs, the rulings rule, and this file
 * is the wire between them and a browser.
 *
 * **Nothing runs without a click** (invariant 5): the only thing that starts a run is
 * `POST /api/run`, and the only thing that resumes one is a ruling. No GET starts work,
 * so a page load, a refresh, a health check, and a crawler are all free.
 *
 * **Preconditions before the button** (D15): the launch refuses with the exact sentence
 * the disabled button was already showing, because both come out of `launchBlockedBecause`.
 * A precondition the API enforced and the button did not show would be a failure after a
 * click, which is the thing that rule exists to forbid.
 */

/** What the API needs to operate: the two things that act, and the one that reports. */
export interface Operating {
  runner: Runner
  rulings: Rulings
  /**
   * Claude, unbound (D6) — for the two acts in this app that spend money outside a run: the
   * pre-drafted rewrite and the scene-scoped re-check (E3-5). A step is handed a BOUND adapter
   * so it cannot bill nowhere; a remediation has no step to bind to, so `remediation.ts` builds
   * the call site out of the episode and the ledger walks up to the show from there.
   */
  llm: LLMAdapter
  /**
   * Whether this process can reach a model right now. A function, not a value: it is
   * re-asked on every health check, so a snapshot taken at boot cannot go on claiming
   * "ready" after the thing it checked went away.
   */
  readiness: () => LLMReadiness
}

export function createApp(
  paths: LibraryPaths,
  store: Store,
  events: EventLog,
  operating: Operating,
): Hono {
  const app = new Hono()

  /**
   * Rules, then hands back the whole run as the ruling left it: resumed and moving again,
   * not finished. A ruling does not wait for the work it releases — the step is off doing
   * it before this responds — and pretending otherwise would mean an HTTP request that
   * hangs for as long as an Opus call. What happens next arrives on the event stream,
   * which is what the stream is for.
   */
  const rule = (c: Context, verdict: () => { gate: { runId: string } }) => {
    try {
      return c.json(runView(store, paths, verdict().gate.runId)!)
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  }

  /**
   * Health, and the one question the floor's first tile exists to answer: can this reach a
   * model right now (`mockups/floor.html`, "Claude adapter — Anthropic API · connected").
   *
   * `status` is about this process, and it stays `ok` when the adapter is dead, because it
   * is: the library is mounted, the runner is running, gates rule, everything that is not
   * a model call works. The adapter's state is its own field with its own sentence, which
   * is the only way a screen can render two facts that are genuinely separate.
   */
  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      llm: operating.readiness(),
      library: {
        root: paths.root,
        databaseFile: paths.databaseFile,
        artifactDir: paths.artifactDir,
      },
    }),
  )

  /** Everything the operating page renders: shows, episodes, lifecycle, buttons, spend. */
  app.get('/api/operating', (c) => c.json(operatingView(store, paths, operating.readiness())))

  /**
   * **The floor** (E5-1): what needs Ryan, what is in flight, and what it has cost — one
   * read over gates, findings, riders, runs, locks and `cost_entry`, composed in sentences
   * on this side (`floor.ts`).
   *
   * A GET, so opening the home screen starts nothing, rules nothing and spends nothing
   * (invariant 5). The one thing the floor can DO — start the stage an idle episode is at —
   * goes through `POST /api/run` above, which refuses with the same sentence the disabled
   * button was already showing.
   */
  app.get('/api/floor', (c) => c.json(floorView(store, paths, operating.readiness())))

  /**
   * What the cockpit's rooms are called, what each one is for in Ryan's words, and what
   * each can honestly say about itself today (E5-0). A read, so opening the shell starts
   * nothing — and the reason it is a read at all rather than a constant in the browser is
   * E4-7's rule: no name, no explanation and no "not built yet" is authored in `app/web/`.
   */
  app.get('/api/cockpit', (c) => c.json(cockpitView(store)))

  /**
   * **The episode room** (E5-2): one episode whole — its scene grid, what has been written,
   * what the checks said, what rides it, where it stands on its arcs, and what it has cost.
   *
   * A GET, and it starts nothing. The room is a composition of three reads that were already
   * GETs (`/api/writing`, `/api/checks`, `/api/sweep`) plus the stitching a screen needs
   * (`episode-room.ts`), so opening it spends nothing and rules nothing — invariant 5 at
   * page-load scale, and the same promise the floor and the writing room already keep.
   */
  app.get('/api/episode/:episodeId', (c) => {
    const view = episodeRoomView(store, paths, c.req.param('episodeId'), operating.readiness())
    if (!view) return c.json({ error: `No such episode: ${c.req.param('episodeId')}` }, 404)
    return c.json(view)
  })

  /** One run in full — its steps, its events, its spend, and the gate it is parked on. */
  app.get('/api/run/:id', (c) => {
    const view = runView(store, paths, c.req.param('id'))
    if (!view) return c.json({ error: `No such run: ${c.req.param('id')}` }, 404)
    return c.json(view)
  })

  /** Ryan's click, and the only thing in this app that starts work. */
  app.post('/api/run', async (c) => {
    const body = await json(c.req.raw)
    const episodeId = typeof body['episodeId'] === 'string' ? body['episodeId'] : ''
    const stage = typeof body['stage'] === 'string' ? body['stage'] : ''
    if (!episodeId || !stage) {
      return c.json({ error: 'A run needs an episodeId and a stage.' }, 400)
    }

    // The stage first, because the refusal is now the STAGE's: what it spends decides
    // whether a dead adapter stands in its way, and what it does with the material decides
    // whether D12's wall does (`operating.ts`, `runner/step.ts`). A name this build does not
    // have is a different mistake from a run it will not start, and says so.
    const declared = findStage(paths, stage)
    if (!declared) {
      return c.json(
        {
          error:
            `This build has no stage called “${stage}”. A stage is TypeScript in the ` +
            'catalogue, never a row (the Archon rule) — the ones it has are: ' +
            `${stageNames(paths).join(', ')}.`,
        },
        404,
      )
    }

    const blocked = launchBlockedBecause(store, operating.readiness(), episodeId, declared)
    if (blocked) return c.json({ error: blocked }, 409)

    try {
      const run = operating.runner.enqueueRun({ episodeId, stage })
      return c.json({ runId: run.id }, 201)
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  })

  /**
   * The four verdicts (E5-3). None takes a precondition and none may be refused on the
   * artifact's account — checks argue, they never veto (invariant 3) — so the only errors any
   * of them can return are "no such gate", "that round is already ruled", and, for the two
   * verbs whose object is a note, the missing note. All of them come straight out of
   * `createRulings`, and the last two are the sentences the disabled button was showing.
   */
  app.post('/api/gate/:id/approve', async (c) => {
    const body = await json(c.req.raw)
    const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : ''
    return rule(c, () =>
      operating.rulings.approve(c.req.param('id'), comment === '' ? {} : { comment }),
    )
  })

  /**
   * Approve OVER something, recorded as itself forever (invariant 3).
   *
   * The same verb as `approve` and a different word in the ledger, which is exactly the
   * point: a red finding makes an artifact loud, Ryan may carry on anyway, and what he did
   * has to still be readable a season later. It is also the one thing that takes D12's wall
   * down (`runner/stage-wall.ts`) — an override that left the next stage refused would be a
   * verdict with no consequence, which is a check vetoing him by another route.
   *
   * E3-7's gate room is where the button appears with the findings it is standing over
   * named on it. This route is that verb reachable, so the wall has a door.
   */
  app.post('/api/gate/:id/override', async (c) => {
    const body = await json(c.req.raw)
    const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : ''
    return rule(c, () =>
      operating.rulings.override(c.req.param('id'), comment === '' ? {} : { comment }),
    )
  })

  app.post('/api/gate/:id/reject', async (c) => {
    const body = await json(c.req.raw)
    const notes = notesFrom(body['notes'])
    if (notes.length === 0) {
      // Refused in the sentence the disabled button was already showing, which is what makes
      // "preconditions before the button" true rather than decorative (D15). It is composed
      // by `gate.ts` and it names the subject, so this loads the gate rather than wording a
      // second refusal here — until E4-7 the button, this route and the ruling said three
      // different things about one rule.
      const standing = gateStanding(store, c.req.param('id'))
      if (!standing) return c.json({ error: `No such gate: ${c.req.param('id')}` }, 404)
      return c.json({ error: rejectionNeedsANote(standing.subject) }, 400)
    }
    return rule(c, () => operating.rulings.reject(c.req.param('id'), { notes }))
  })

  /**
   * **Put the draft down** (E5-3, #83) — the fourth verdict, and the exit a presenting gate
   * did not have.
   *
   * It is a sibling of `reject` in every respect that matters here: the notes come off the
   * same shape, the missing-note refusal is the sentence the disabled button was already
   * showing (`closingNeedsANote`), and the ruling resumes the run through the same seam. What
   * differs is what the step does on the way back in, and that is the step's business, not
   * this route's — this file is the wire (`runner/present-step.ts`, `runner/correction-loop.ts`).
   */
  app.post('/api/gate/:id/close', async (c) => {
    const body = await json(c.req.raw)
    const notes = notesFrom(body['notes'])
    if (notes.length === 0) {
      const standing = gateStanding(store, c.req.param('id'))
      if (!standing) return c.json({ error: `No such gate: ${c.req.param('id')}` }, 404)
      return c.json({ error: closingNeedsANote(standing.subject) }, 400)
    }
    return rule(c, () => operating.rulings.close(c.req.param('id'), { notes }))
  })

  /**
   * **The gate room** (E5-3, #83; 5.3, D15): the draft under review rendered full-height with
   * the findings folded in at their anchors, the verdict board, the riders, the round history,
   * and the four verbs in a dock.
   *
   * A GET, and it rules nothing. `/api/gate` is the thin index of what is open — the same
   * question the floor asks, answered as a list of sentences that link — and `/api/gate/:id`
   * is one gate whole. Neither starts anything: opening the room where the ruling is MADE may
   * not itself be a ruling (invariant 5).
   */
  app.get('/api/gate', (c) => c.json(gateIndexView(store, paths)))

  app.get('/api/gate/:gateId', (c) => {
    const view = gateRoomView(store, paths, c.req.param('gateId'), operating.readiness())
    if (!view) return c.json({ error: `No such gate: ${c.req.param('gateId')}` }, 404)
    return c.json(view)
  })

  /**
   * The check bench for one episode (E3-7): what the checks said, at the spans they said it
   * about, with the three remediation buttons behind each finding and D12's wall in words.
   *
   * A GET, and it runs nothing — the whole bench is a read over rows six issues already wrote
   * (`check-bench.ts`). Opening it costs nothing, which is invariant 5 at page-load scale.
   */
  app.get('/api/checks/:episodeId', (c) => {
    const view = checkBenchView(store, paths, c.req.param('episodeId'), operating.readiness())
    if (!view) return c.json({ error: `No such episode: ${c.req.param('episodeId')}` }, 404)
    return c.json(view)
  })

  /**
   * The writing room for one episode (E4-7) — the writing line's three buttons with their
   * declared sentences and costs, the desk behind each one, every gate readable with its loop
   * history and its clustered findings, the edit doors, the arc pin, and the owed sweep.
   *
   * A GET, and it starts nothing: the whole room is a read over rows seven issues already
   * wrote (`writing-room.ts`). Opening it costs nothing and makes no model call, which is
   * invariant 5 said about a page load — and it is what makes the desk a preview of what a
   * click would buy rather than a post-mortem of one.
   */
  app.get('/api/writing/:episodeId', (c) => {
    const view = writingRoomView(store, paths, c.req.param('episodeId'), operating.readiness())
    if (!view) return c.json({ error: `No such episode: ${c.req.param('episodeId')}` }, 404)
    return c.json(view)
  })

  // ── The remediations behind a finding (E3-5) ──────────────────────────────────
  //
  // 4.3's three buttons, reachable. **Every one of them raises, revises, or records** — not
  // one ratifies, and `remediation.ts` is where that is argued. They follow the shape of
  // `/api/gate/:id/override` above: the act, then what the act left behind, and a refusal
  // answered in the exact words its disabled button was already showing.
  //
  // Two of them spend money and say so before the click (`predraft`, `recheck`); two are free.
  // Nothing here runs on a GET, so a page load costs nothing (invariant 5).
  /**
   * A finding that does not exist is a 404; a finding that exists and cannot be remediated
   * that way is a 409 carrying the sentence its disabled button was already showing. Two
   * different answers, because they are two different mistakes.
   */
  const finding = (c: Context, id: string, act: () => unknown) => {
    if (!findFinding(store, id)) return c.json({ error: `No such finding: ${id}` }, 404)
    try {
      return c.json(act() as object)
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  }

  /** What the three buttons say about one finding, and why one of them cannot be pressed. */
  app.get('/api/finding/:id', (c) =>
    finding(c, c.req.param('id'), () =>
      remediationsFor(store, paths, c.req.param('id'), operating.readiness()),
    ),
  )

  /**
   * Pre-draft a replacement for the anchored span. **It spends a call and moves nothing** —
   * the artifact is untouched when this returns, and applying is a separate click (4.3:
   * "rewrite the span (pre-drafted, editable)").
   */
  app.post('/api/finding/:id/predraft', async (c) => {
    if (!findFinding(store, c.req.param('id'))) {
      return c.json({ error: `No such finding: ${c.req.param('id')}` }, 404)
    }
    // Refused with the exact sentence the disabled button was already showing, which is what
    // makes "preconditions before the button" true rather than decorative — one composer
    // (`remediationsFor`), two readers.
    const offered = remediationsFor(store, paths, c.req.param('id'), operating.readiness())
    if (offered.predraft.blockedBecause) {
      return c.json({ error: offered.predraft.blockedBecause }, 409)
    }
    try {
      return c.json(await predraftRewrite(store, operating.llm, paths, c.req.param('id')))
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  })

  /**
   * Apply the rewrite Ryan settled on — **one motion**: revise the artifact, and re-run the
   * free deterministic tier over the new version before this responds. A `replacement` that
   * is absent is a request with nothing in it; one that is EMPTY is a deletion he typed, and
   * the two are different (the `''`-is-a-value rule this schema keeps everywhere).
   */
  app.post('/api/finding/:id/rewrite', async (c) => {
    const body = await json(c.req.raw)
    if (typeof body['replacement'] !== 'string') {
      return c.json(
        {
          error:
            'A rewrite needs the replacement text — what should stand where the span stands. ' +
            'It is applied word for word, so what you send is what lands.',
        },
        400,
      )
    }
    const replacement = body['replacement']
    return finding(c, c.req.param('id'), () =>
      applyRewrite(store, paths, { findingId: c.req.param('id'), replacement }, operating.readiness()),
    )
  })

  /** The five parts, prefilled from the concern — what the propose form opens with. */
  app.get('/api/finding/:id/canon-change', (c) =>
    finding(c, c.req.param('id'), () => canonChangePrefill(store, paths, c.req.param('id'))),
  )

  /**
   * Raise the canon change the finding implies. It lands on the queue riding the episode and
   * **stops there**: ruling it is `/api/proposal/:id/ratify` and it is Ryan's (invariant 1).
   */
  app.post('/api/finding/:id/canon-change', async (c) => {
    const body = await json(c.req.raw)
    const field = text(body['field'])
    return finding(c, c.req.param('id'), () =>
      proposeCanonChange(store, paths, c.req.param('id'), {
        statement: text(body['statement']),
        ...(field !== '' && { field }),
      }),
    )
  })

  /**
   * Put it down with a note (4.4). The note is required by `dismissFinding` in the same
   * sentence the disabled button shows — it rides future runs and it is counted against the
   * check that raised it (D11), so an empty one teaches nothing and still costs credibility.
   */
  app.post('/api/finding/:id/dismiss', async (c) => {
    const note = text((await json(c.req.raw))['note'])
    return finding(c, c.req.param('id'), () => {
      dismissFinding(store, c.req.param('id'), note)
      return remediationsFor(store, paths, c.req.param('id'), operating.readiness())
    })
  })

  /**
   * D14's scene-scoped re-check: re-read one scene with the reviewers that argued with it.
   * The paid half of a rewrite, and its own click because it costs a call (invariant 5).
   */
  app.post('/api/artifact/:id/recheck', async (c) => {
    const sceneId = text((await json(c.req.raw))['sceneId'])
    if (sceneId === '') {
      return c.json(
        {
          error:
            'A re-check needs the scene to re-read. Narrowing to the scene that changed is ' +
            'the whole of D14 — reading the whole draft again is the panel, and it has its ' +
            'own button and its own cost.',
        },
        400,
      )
    }
    try {
      return c.json(
        await recheckScene(store, operating.llm, paths, {
          artifactId: c.req.param('id'),
          sceneId,
        }),
      )
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  })

  // ── Ryan's hand: editing a written artifact directly (E4-5) ───────────────────
  //
  // Two routes, and the GET is what makes the POST usable: an edit is Ryan typing over a
  // draft, so he has to be handed the draft. Both read the path off the artifact ROW —
  // nothing a browser sends chooses which file this process opens (`operating.ts`'s rule).
  //
  // Neither of them calls a model. The edit is E3-5's one motion generalized (`edit.ts`): it
  // revises, re-delineates a script's scenes, and lets the free deterministic tier read the
  // new version before it answers — so "no model call · $0.00" on the button is the whole
  // truth about what pressing it spends.

  /** The draft to type over, with its freshness, what stands against it, and the door. */
  app.get('/api/artifact/:id', (c) => {
    const artifact = findArtifact(store, c.req.param('id'))
    if (!artifact) return c.json({ error: `No such artifact: ${c.req.param('id')}` }, 404)
    return c.json(artifactOnTheWire(store, paths, artifact))
  })

  /**
   * **Land his text as a new version, verbatim** — and refuse in the exact sentence the
   * disabled button was already showing (D15).
   *
   * A `text` that is absent is a request with nothing in it; one that is EMPTY is a deletion
   * he typed, and the two are different — the `''`-is-a-value rule this schema keeps
   * everywhere. The empty one is refused by `editArtifact`, in words, with the reason.
   *
   * **`sceneId` narrows what the text IS, never how it lands** (D14, E5-2). With it, the body
   * is one scene's span and `editScene` splices it into the whole draft; without it, the body
   * is the whole draft. Both go through the one motion (`edit.ts` → `landNewVersion`), and
   * that is deliberately why there is one route rather than two: a second door that wrote
   * artifact bytes would be a second write path, which is the thing E3-5's ledger forbids.
   */
  app.post('/api/artifact/:id/edit', async (c) => {
    const artifact = findArtifact(store, c.req.param('id'))
    if (!artifact) return c.json({ error: `No such artifact: ${c.req.param('id')}` }, 404)

    const body = await json(c.req.raw)
    if (typeof body['text'] !== 'string') {
      return c.json(
        {
          error:
            'An edit needs the text — what should stand where this draft stands. It lands ' +
            'word for word, so what you send is what is on the volume afterwards.',
        },
        400,
      )
    }
    const sceneId = text(body['sceneId'])
    try {
      return c.json(
        sceneId === ''
          ? editArtifact(store, paths, { artifactId: artifact.id, text: body['text'] })
          : editScene(store, paths, { artifactId: artifact.id, sceneId, text: body['text'] }),
      )
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  })

  // ── The canon bench (E2-6) ────────────────────────────────────────────────────
  //
  // Seven routes, and every one of them is Ryan's click. Six RAISE — founding aside, nothing
  // here writes canon — and the seventh is the ruling API, convened from the queue exactly as
  // the gate room convenes it over a script (proposal.ts: a gate says where he was standing,
  // never whether he may rule).
  //
  // **Every one answers with the recomposed bench**, and the browser sends the state of its
  // two controls along with the act, so the canon section re-renders from `canon_ruling`
  // the moment a ruling lands. That is where a bench ruling is read back from and it is
  // ruled (#29, Aug 7): no gate, no run, no event — the Live panel stays runs-and-gates.
  //
  // The show-scoped routes take the show id in the same position `entity` and `fact` take a
  // literal, which cannot collide: ids are prefixed (`show_…`), so no show is called
  // "entity". Nothing here spends a cent, which is why no route consults the LLM readiness.
  const rulings = createProposalRulings(store, events)

  /** Where the bench's controls stand, off the query string the page sent with its act. */
  const standingOf = (c: Context): BenchStanding => {
    const entity = c.req.query('entity')
    const episode = c.req.query('episode')
    const ruling = Number(c.req.query('ruling'))
    const date = c.req.query('date')
    return {
      ...(entity !== undefined && entity !== '' && { entityId: entity }),
      ...(episode !== undefined && episode !== '' && { episodeId: episode }),
      ...(Number.isInteger(ruling) && ruling > 0 && { ruling }),
      ...(date !== undefined && date !== '' && { date }),
    }
  }

  /** The act, then the bench as the act left it. A refusal answers in the words it refused with. */
  const bench = (c: Context, showId: string, act: () => void) => {
    try {
      act()
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
    return c.json(canonBenchView(store, showId, standingOf(c))!)
  }

  /** Entities, one sheet, the queue, the ledger, and the point-in-time control. */
  app.get('/api/canon/:showId', (c) => {
    const view = canonBenchView(store, c.req.param('showId'), standingOf(c))
    if (!view) return c.json({ error: `No such show: ${c.req.param('showId')}` }, 404)
    return c.json(view)
  })

  /**
   * Founding (D25): one deliberate act, one ruling per sheet on the ledger. It rules only
   * what a loader or an import raised — `foundCanon`'s own filter — so a proposal Ryan or a
   * writer raised is never swept into it, and it is not a general bulk-approve.
   */
  app.post('/api/canon/:showId/found', (c) => {
    const showId = c.req.param('showId')
    if (!findShow(store, showId)) return c.json({ error: `No such show: ${showId}` }, 404)
    return bench(c, showId, () => foundCanon(store, showId))
  })

  /** Creating is proposing: the identity is a candidate, the sheet is a proposal. */
  app.post('/api/canon/:showId/entity', async (c) => {
    const showId = c.req.param('showId')
    if (!findShow(store, showId)) return c.json({ error: `No such show: ${showId}` }, 404)

    const body = await json(c.req.raw)
    return bench(c, showId, () =>
      registerAndPropose(
        store,
        showId,
        { categoryKey: text(body['categoryKey']), name: text(body['name']) },
        sheetFrom(body),
      ),
    )
  })

  /** The candidate on the list, put to a ruling with the sheet Ryan typed for it. */
  app.post('/api/canon/entity/:entityId/promote', async (c) => {
    const entity = findEntityById(store, c.req.param('entityId'))
    if (!entity) return c.json({ error: `No such canon entity: ${c.req.param('entityId')}` }, 404)

    const body = await json(c.req.raw)
    return bench(c, entity.showId, () => promoteCandidate(store, entity.id, sheetFrom(body)))
  })

  /**
   * A fact the entity does not have yet (#39) — the same delta with no before, and the twin
   * of the route below. A change form anchors to a fact that exists, so an entity created
   * with its facts box empty was unreachable by every other act on this bench.
   */
  app.post('/api/canon/entity/:entityId/fact', async (c) => {
    const entity = findEntityById(store, c.req.param('entityId'))
    if (!entity) return c.json({ error: `No such canon entity: ${c.req.param('entityId')}` }, 404)

    const body = await json(c.req.raw)
    const field = text(body['field'])
    return bench(c, entity.showId, () =>
      proposeNewFact(store, entity.id, {
        statement: text(body['statement']),
        ...(field !== '' && { field }),
        ...(text(body['usageContext']) !== '' && { usageContext: text(body['usageContext']) }),
      }),
    )
  })

  /** A change to a ratified fact, which is a SECOND proposal carrying the first as its before. */
  app.post('/api/canon/fact/:factId/propose', async (c) => {
    const fact = findFact(store, c.req.param('factId'))
    if (!fact) return c.json({ error: `No such fact: ${c.req.param('factId')}` }, 404)
    const entity = findEntityById(store, fact.entityId)!

    const body = await json(c.req.raw)
    const field = text(body['field'])
    return bench(c, entity.showId, () =>
      proposeFactChange(store, fact.id, {
        statement: text(body['statement']),
        ...(field !== '' && { field }),
        ...(text(body['usageContext']) !== '' && { usageContext: text(body['usageContext']) }),
      }),
    )
  })

  /**
   * **The door E4-4 built** (D8): moving an episode's pin on an arc. Until this route,
   * `declarePosition` had exactly one caller in the whole app — the fixture loader — so a pin
   * could be read everywhere and moved nowhere.
   *
   * It raises nothing and costs nothing. The LANDING proposal that turns a pin into a fact is
   * raised by the script's extraction, because a landing needs the subject entity only the
   * writer can answer for (`canon-bench.ts` states the split, `claim.ts` answers it).
   */
  app.post('/api/canon/episode/:episodeId/position', async (c) => {
    const where = episodeInShow(store, c.req.param('episodeId'))
    if (!where) return c.json({ error: `no such episode: ${c.req.param('episodeId')}` }, 404)

    const body = await json(c.req.raw)
    return bench(c, where.show.id, () =>
      declareEpisodePosition(store, {
        episodeId: where.episode.id,
        arcId: text(body['arcId']),
        waypointId: text(body['waypointId']),
      }),
    )
  })

  /**
   * The one ruling API, from the bench. All three dispositions are kept forever (3.3), and
   * the rejection's missing note is refused by `createProposalRulings` in the same sentence
   * the disabled button was already showing — one string, `REJECTION_NEEDS_A_NOTE`.
   */
  for (const verdict of ['ratify', 'reject', 'defer'] as const) {
    app.post(`/api/proposal/:proposalId/${verdict}`, async (c) => {
      const proposal = findProposal(store, c.req.param('proposalId'))
      if (!proposal) {
        return c.json({ error: `No such proposal: ${c.req.param('proposalId')}` }, 404)
      }
      const note = text((await json(c.req.raw))['note'])
      return bench(c, proposal.showId, () => {
        if (verdict === 'ratify') rulings.ratify(proposal.id, { note })
        else if (verdict === 'defer') rulings.defer(proposal.id, { note })
        else rulings.reject(proposal.id, { note })
      })
    })
  }

  // ── The completion sweep (E4-6) ───────────────────────────────────────────────
  //
  // Two routes, and they convene **the same three verbs the queue above convenes** — the
  // `rulings` object is literally the one built for the bench, because there is one ruling API
  // and a surface is where Ryan was standing, never what a ruling is (proposal.ts). What is
  // different is the scope and the answer: this presents the proposals riding ONE episode, and
  // hands back that episode's pass as the ruling left it.
  //
  // **There is no bulk verb here and there is no route for one.** Each rider is ruled by its
  // own POST, writes its own row on `canon_ruling`, and the pass re-reads afterwards — which is
  // what "ruled one at a time, no bulk approve" means at the wire (1.2, and `sweep.ts`'s header
  // argues why the pass stands owed after the approval rather than inside the gate).

  /** What the episode still owes canon: its riders, its rulings, and the sentence for both. */
  app.get('/api/sweep/:episodeId', (c) => {
    const view = sweepView(store, c.req.param('episodeId'))
    if (!view) return c.json({ error: `No such episode: ${c.req.param('episodeId')}` }, 404)
    return c.json(view)
  })

  for (const verdict of ['ratify', 'reject', 'defer'] as const) {
    app.post(`/api/sweep/proposal/:proposalId/${verdict}`, async (c) => {
      const proposal = findProposal(store, c.req.param('proposalId'))
      if (!proposal) {
        return c.json({ error: `No such proposal: ${c.req.param('proposalId')}` }, 404)
      }
      // A proposal riding nothing is not on any episode's pass, and the refusal says where it
      // IS rulable rather than leaving him to find out (`sweep.ts`).
      const elsewhere = notOnAnEpisodeSweepBecause(proposal)
      if (elsewhere) return c.json({ error: elsewhere }, 409)

      const note = text((await json(c.req.raw))['note'])
      try {
        if (verdict === 'ratify') rulings.ratify(proposal.id, { note })
        else if (verdict === 'defer') rulings.defer(proposal.id, { note })
        else rulings.reject(proposal.id, { note })
      } catch (error) {
        return c.json({ error: messageOf(error) }, 409)
      }
      return c.json(sweepView(store, proposal.episodeId!)!)
    })
  }

  /**
   * The live stream: every event, in sequence order, forever.
   *
   * It opens with the gap and then goes live. A browser sends the last id it saw — as
   * `Last-Event-ID` on a reconnect, which it does on its own, or as `?since=` by hand —
   * and gets everything after it before the live feed resumes. That is why the chunks are
   * persisted: a connection that drops mid-generation comes back to the line it was
   * reading rather than to a blank one, and "run state is always visible" survives a
   * dropped socket.
   *
   * Events that land *during* the replay are held and de-duplicated by `seq`, so the
   * stream has neither a gap nor a repeat at the seam.
   *
   * There is no keep-alive ping and no `?run=` filter. Nothing proxies this — the browser
   * talks to this process — and a dropped connection is already recoverable by the resume
   * path above. One user, one process: a consumer that wants one episode writes an `if`.
   */
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const asked = Number(c.req.header('Last-Event-ID') ?? c.req.query('since') ?? 0)
      const from = Number.isInteger(asked) && asked > 0 ? asked : 0

      const pending: EventRecord[] = []
      let wake: (() => void) | undefined
      let aborted = false

      const unsubscribe = events.subscribe((event) => {
        pending.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        aborted = true
        wake?.()
      })

      const send = (event: EventRecord) =>
        stream.writeSSE({
          id: String(event.seq),
          event: event.kind,
          data: JSON.stringify(event),
        })

      try {
        // Sent before anything is read, so a client knows the socket is open and where it
        // resumed from. A control frame, not a log entry — it has no sequence.
        await stream.writeSSE({ event: 'open', data: JSON.stringify({ since: from }) })

        let last = from
        for (const event of eventsSince(store, from)) {
          await send(event)
          last = event.seq
        }

        while (!aborted && !stream.closed) {
          const next = pending.shift()
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            wake = undefined
            continue
          }
          if (next.seq <= last) continue // already sent in the replay above
          await send(next)
          last = next.seq
        }
      } finally {
        unsubscribe()
      }
    }),
  )

  // An unknown API route says so. It must never fall through to the SPA shell —
  // a 200 with a page in it reads as success to anything calling the API.
  app.all('/api/*', (c) => c.text(`No such endpoint: ${c.req.path}`, 404))

  app.use('/*', serveStatic({ root: WEB_ROOT }))
  app.get('/*', serveStatic({ path: `${WEB_ROOT}/index.html` }))

  app.notFound((c) =>
    c.text(
      'The page has not been built yet. Run `npm run build`, or `npm run dev:web` for the SPA with HMR.',
      404,
    ),
  )

  return app
}

/**
 * What `GET /api/artifact/:id` answers with. Composed here because it is a wire shape rather
 * than a domain one — the sentences it carries are `edit.ts`'s and `routing.ts`'s, which is
 * where they have tests.
 */
function artifactOnTheWire(
  store: Store,
  paths: LibraryPaths,
  artifact: Artifact,
): ArtifactOnTheWire {
  const written = writtenArtifacts(store, paths, artifact.episodeId).find(
    (one) => one.artifact.id === artifact.id,
  )
  const freshness = artifactFreshness(store, artifact.episodeId).find(
    (one) => one.artifact.id === artifact.id,
  )
  const label = `the ${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`

  let text: string | null = null
  let note: string | null = null
  if (artifact.filePath === null) {
    note = 'This artifact has been recorded but not produced yet.'
  } else {
    try {
      text = readFileSync(join(paths.artifactDir, artifact.filePath), 'utf8')
    } catch (error) {
      note =
        `${artifact.filePath} is recorded on the artifact but could not be read from ` +
        `${paths.artifactDir} — ${messageOf(error)}`
    }
  }

  return {
    artifact,
    text,
    note,
    staleBecause:
      freshness?.status === 'stale' ? staleSentence(store, artifact, freshness.reasons) : null,
    standing: notesOwedBy(store, artifact.id).map((one) => ({
      note: one.note,
      sentence: routedNoteSentence([one], label),
    })),
    // The offer is the module's, never re-composed here: one composer, two readers, so the
    // button and the refusal can never tell Ryan different stories (D15).
    edit: written?.edit ?? editOffer(store, paths, artifact.id),
  }
}

/** The stages this build has, for the refusal that names them when a request asks for one it does not. */
const stageNames = (paths: LibraryPaths): string[] => Object.keys(stageCatalogue(paths))

/** A body that is absent, empty, or not JSON is an empty body, not a crash. */
async function json(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Notes as Ryan typed them. A note with no depth is legal — the unrouted default (D21). */
function notesFrom(value: unknown): NoteDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): NoteDraft[] => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ note: entry.trim() }]
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const note = typeof record['note'] === 'string' ? record['note'].trim() : ''
    if (note === '') return []
    return [
      {
        note,
        ...(typeof record['depth'] === 'string' && record['depth'] !== ''
          ? { depth: record['depth'] as NoteDraft['depth'] }
          : {}),
        ...(typeof record['target'] === 'string' && record['target'].trim() !== ''
          ? { target: record['target'].trim() }
          : {}),
      },
    ]
  })
}

/** A string field as it was typed, trimmed. Anything else was not typed at all. */
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The sheet a promotion carries, as the bench form sends it (1.2). Facts arrive as one
 * textarea — one statement per line, blank lines dropped — because that is how a sheet's
 * `## Facts` reads on disk, and the bench is not the place to invent a second shape for it.
 */
function sheetFrom(body: Record<string, unknown>): SheetDraft {
  const lines = (value: unknown): string[] =>
    typeof value === 'string'
      ? value
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : []

  const standing = text(body['standing'])
  const usageContext = text(body['usageContext'])
  const prose = typeof body['body'] === 'string' ? body['body'].trim() : ''
  const aliases = text(body['aliases'])
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '')

  // The vocabulary is the store's (0006 aborts on anything else), so a standing outside it
  // is refused HERE, in words, rather than at the ratification it would abort three screens
  // later. Left out entirely is legal and different: what a sheet does not say is left alone.
  if (standing !== '' && !ENTITY_STANDING.includes(standing as SheetDraft['standing'] & string)) {
    throw new Error(
      `“${standing}” is not a standing. It is one of: ${ENTITY_STANDING.join(', ')} — declared ` +
        'intent, not a count (3.1) — or left out, which says nothing rather than saying one-shot.',
    )
  }

  return {
    ...(standing !== '' && { standing: standing as SheetDraft['standing'] }),
    ...(aliases.length > 0 && { aliases }),
    ...(prose !== '' && { body: prose }),
    facts: lines(body['facts']),
    relations: Array.isArray(body['relations'])
      ? body['relations'].flatMap((entry): { type: string; to: string }[] => {
          if (typeof entry !== 'object' || entry === null) return []
          const record = entry as Record<string, unknown>
          const type = text(record['type'])
          const to = text(record['to'])
          return type === '' || to === '' ? [] : [{ type, to }]
        })
      : [],
    ...(usageContext !== '' && { usageContext }),
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
