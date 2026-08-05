# Showrunner

A containerized web app for multi-show episodic video production — writing, canon
keeping, image and audio generation, assembly, and publishing, with the showrunner
ruling at every gate.

**Status: E1 complete, pending Ryan's ruling on the epic.** The spine stands: the domain
schema, the runner with its named locks and crash-resume, the gate primitive, the
append-only event log over SSE, the Claude adapter and cost ledger, the Grey Harbor
fixture, and a bare-bones operating page to drive the whole thing from. **The drill that
ends E1 is below** — it is Ryan's to perform, not a test's to simulate.

## Running it

```
export ANTHROPIC_API_KEY=sk-ant-...   # optional; compose passes it through
docker compose up                     # the app on http://localhost:4400
```

Everything durable lands in `./library` on the host — `showrunner.db` plus artifacts
as plain files (D2). The directory is gitignored; compose creates it on first run.

Working on it without the container:

```
npm install
npm run build              # the SPA
npm run fixture:load       # seed Grey Harbor; spends nothing, safe to run twice
npm start                  # the app process on :4400
npm run dev:web            # the SPA with HMR on :4401, API proxied to :4400
npm test && npm run typecheck   # CI — run both before claiming done
```

Node 24+ is required: the server runs its TypeScript directly, and SQLite comes from
`node:sqlite` rather than a native module. GPU steps will run on a native Mac worker
outside the container (D5) — nothing GPU-related belongs in compose.

**Which backend it will use** (D6): `SHOWRUNNER_LLM_BACKEND` decides when it is set;
unset, an `ANTHROPIC_API_KEY` in the environment means the API and no key means the
`claude` CLI. Whichever it picks, it checks that the thing is actually there and says so
at boot and on `/api/health` — a container with neither is a legitimate state that
reports itself, not a crash and not a surprise on the first model call.

## The E1 drill — operating the spine end to end

The epic exit, as one sitting. It takes about five minutes and costs **one or two cents**
of real money. Nothing below needs the code read.

### Before you start

```
npm install
npm run build
npm run fixture:load
export ANTHROPIC_API_KEY=sk-ant-...    # or leave it unset to use the claude CLI
docker compose up
```

Open <http://localhost:4400>.

> **If the Dead Light console is running, stop it first.** It is also on 4400, and the two
> do not collide the way you would want: the console takes IPv4 and the container takes
> IPv6, both come up healthy, and `localhost:4400` then serves whichever one your browser
> resolves to. If you would rather leave it running, skip compose and use
> `PORT=4455 npm start`, then read <http://localhost:4455> everywhere below.

### 1 · Check the adapter before you spend anything

Top of the page, under **Claude adapter**. It says either

- *Anthropic API — ready* (or *claude CLI — ready*), and a sentence saying a key/binary is
  there and that only a real call can prove it works; or
- *NOT READY*, with what is missing and what to do about it. Every launch button on the
  page will be disabled, each with that reason printed under it.

If it says NOT READY, do what the sentence says, restart, and reload. Nothing on this page
will let you spend money into a backend that cannot answer.

### 2 · Launch the demo run

On **ep02 · Dry Stores**, press the button that reads:

> Write the ep02 demo premise and present it for your ruling — "Dry Stores", one call, one gate
> *1 Opus call, ~$0.01 · your money, spent when you click*

**Write down the run id** it puts on screen (`run_…`). You will want it in step 4.

What you should see, in the **Live** panel at the bottom, in this order: `run-queued`,
`run-started`, `step-started`, a progress line saying it is writing, and then the model's
own sentences arriving one at a time as it writes them. Streams, not spinners.

### 3 · Rule on the gate

The run stops by itself. A **Gate** section appears: *the ep02 premise-brief demo, round 1
· open, waiting on you*, and under it the paragraph it wrote — the artifact itself, in a
box, not a filename.

Optional, and it costs another ~$0.01: type a note ("too tidy", say), pick how deep it
routes, and press **Reject … with notes**. The same step reopens, writes it again against
your note, and presents **round 2**. Round 1 stays in the history, marked *stale — from
before your last rejection*.

**Do not approve yet.** Leave the gate open for the kill.

### 4 · Kill it

In another terminal:

```
docker compose kill -s SIGKILL app      # or, without compose:  pkill -f 'app/server/index.ts'
curl -s http://localhost:4400/api/health    # should refuse the connection
```

### 5 · Restart, and check it resumed rather than started over

```
docker compose up                        # or:  npm start
```

The boot log should say **`Runner: nothing was left in flight.`** That is correct and is
the point: a run parked on a gate is not interrupted work, it is yours, and a reboot
leaves it exactly where it was.

Reload the page. Five things tell you this is the same run and not a new one:

1. **The gate is still open**, same round, same paragraph. Nothing asked you to launch again.
2. **The run id is the same string** you wrote down in step 2.
3. **The Live panel replays everything from before the kill** — the `run-queued`,
   `step-chunk`, `gate-opened` lines the dead process wrote, with their original sequence
   numbers. A fresh start would begin its numbering after them, not among them.
4. **"What this run spent" still says 1 call** (2 if you rejected once). This is the
   decisive one — see below.
5. On disk, `library/artifact/greyharbor/s01e02/demo/premise-round-1.md` is still there
   with the same words in it.

### 6 · Approve, and watch the call count *not* move

Press **Approve the ep02 premise-brief demo**. The run carries on into its second step and
finishes: *demo on ep02 — finished*, both steps `done`.

Now look at **What this run spent** one last time. It says the same number of calls it said
before the kill.

**That number is the whole drill.** Resuming means the run re-entered the step that had
already written, found your ruling on its gate, and returned without calling the model
again. A restart-from-scratch would have written a second draft and put a second row in the
ledger. One call in, one call out, across a `kill -9` — that is the spine holding.

### Optional · Drill B, killed mid-call (costs one more ~$0.01)

Same as above, but kill the process **while the model is still writing** — while sentences
are still arriving in the Live panel. On restart the boot log says
`Runner: resumed 1 interrupted run(s) — demo`, and the Live panel carries a `run-reclaimed`
line naming the step that died in flight. The run picks itself back up on its own, because
you already clicked once and a crash does not un-click it. It will call the model again,
because nothing had been written yet — unless the draft file had already landed, in which
case it keeps that file and does not pay twice.

### Optional · What no usable backend looks like

```
docker compose down
unset ANTHROPIC_API_KEY
docker compose up
```

The boot log prints `!! LLM backend: claude-cli — NOT READY`, `/api/health` returns
`"ready": false` with the reason, and every launch button on the page is disabled with that
reason beside it. The app is otherwise entirely up: the library is mounted, the fixture
lists, past runs and gates all render. Nothing fails at the first model call, because
nothing gets that far.

## Where things are

| Path | What |
|---|---|
| `handoff/docs/README.md` | **Start here.** Index of the design docs, what's authoritative, and how to write an epic's issue file. |
| `handoff/docs/concept-and-architecture.md` | The ruled design — domain, orchestration, canon, checks, screens, build plan. Decisions D1–D24. |
| `handoff/docs/D20-image-backends.md` | Image generation in detail, carried forward from the Dead Light console. |
| `mockups/` | Eight approved screen mockups + their README. Serve that directory and open the floor screen — instructions in `mockups/README.md`. |

Work is tracked in [GitHub Issues](https://github.com/MrMophandle/Showrunner/issues),
one milestone per epic. **E1 · The spine** is issues #1–#9.

## The data layer

`app/server/db/` is the schema and the one seam onto SQLite; `app/server/domain/` is the
typed layer over it. Four rules hold it together:

- **`node:sqlite` is imported in `db/store.ts` and nowhere else.** Everything else takes a
  `Store` and never sees a database handle, so a driver swap is a one-module change.
- **Migrations are plain numbered SQL files** in `db/migrations/`, applied in order inside a
  transaction and recorded in `schema_migration`. Change the schema by adding the next
  number; never edit an applied file. No ORM, no query builder, no schema DSL.
- **Staleness is computed, never remembered.** There is no `is_stale` column. An artifact
  records what it consumed and at which version — optionally scoped to one scene — and
  "which artifacts are stale and why" is a query over those edges.
- **Scenes are derived, never prescribed.** There is no `num_scenes` anywhere: the count
  is `SELECT COUNT(*)` off the episode the writer actually wrote.

The same computed-not-remembered rule covers arcs: an episode records the waypoint
*ordinal* it declared against, so inserting a waypoint mid-sequence makes the ordinal
drift, and "which episodes need re-checking" falls out of the drift rather than a flag.

## The shape of it

Show → Season → Episode → Scene. A show owns its **canon** — an approval-gated store
of what is true. Episodes move premise → outline → script → assets → assembled →
published. **Checks** compare artifacts against canon at artifact boundaries and raise
findings; findings argue, they never veto. Only **ratification** — the showrunner's
ruling at a gate — writes canon.

Two rules worth knowing before you touch the code:

- **The Archon rule.** No workflow DSL, no configurable workflow engine. Pipeline
  stages are TypeScript functions. If you find yourself building a generic workflow
  system, stop — that's the failure mode this project exists to escape.
- **No generic buttons.** Every action states verb + object + scope + cost: "Write the
  ep07 outline — 1 Opus call, ~$0.85". Never "Launch", "Run", or "Do".

## Epics

E1 spine · E2 canon · E3 checks · E4 the writing line · E5 the cockpit ·
E6 the media line · E7 Dead Light migrates in · E8 someone-who-isn't-Ryan can run it.

Each epic ends with something Ryan *operates*, not reads about.
