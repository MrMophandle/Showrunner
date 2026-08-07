# Showrunner

A containerized web app for multi-show episodic video production — writing, canon
keeping, image and audio generation, assembly, and publishing, with the showrunner
ruling at every gate.

**Status: E1 complete and operated.** The spine stands: the domain schema, the runner with
its named locks and crash-resume, the gate primitive, the append-only event log over SSE,
the Claude adapter and cost ledger, the Grey Harbor fixture, and a bare-bones operating
page to drive the whole thing from.

**The E1 drill below was run for real on Aug 5 2026 and passed.** A run called the model
once, opened a gate, and parked; the process was `SIGKILL`ed; on restart the gate was still
open at the same round with the same paragraph and the same run id; approving it carried the
run to done **without a second call**. One call in, one call out, across a kill — which is the
whole thing E1 exists to prove.

**E2 · Canon is built, and its drill has not been run yet.** Categories, entities, facts with
validity ranges, typed relations, proposals and the one ruling API, what episodes do to canon,
the founding flow, the schema document, and a canon bench on the operating page to work all of
it from. The E2 drill is below and it is the epic's exit: it costs nothing, it is Ryan's, and
until he has run it E2 is finished code rather than a finished epic.

## Running it

```
cp -n .env.example .env               # once; -n so it never overwrites an existing one
docker compose up                     # the app on http://localhost:4455
```

`.env` is gitignored and read automatically by `docker compose up`, `npm start`, and
`npm run dev` — there is nothing to export, in this shell or any other. Leave
`ANTHROPIC_API_KEY` empty in it to use D6's other backend, the `claude` CLI, which works
outside the container where you are signed in.

> **A running container serves the past.** It keeps the image it was *born* from and the
> environment it was *created* with — merging PRs, editing `.env`, and plain
> `docker compose up` over a live container change nothing it serves. Whenever code or
> `.env` has changed since the container started:
> `docker compose down && docker compose up --build`. Both real incidents so far — a
> rotated key the container didn't have, and a drill against a two-day-old page — were
> this, and every drill below assumes a fresh container.

Everything durable lands in `./library` on the host — `showrunner.db` plus artifacts
as plain files (D2). The directory is gitignored; compose creates it on first run.

Working on it without the container:

```
npm install
npm run build              # the SPA
npm run fixture:load       # seed Grey Harbor; spends nothing, safe to run twice
npm start                  # the app process on :4455
npm run dev:web            # the SPA with HMR on :4456, API proxied to :4455
npm test && npm run typecheck   # CI — run both before claiming done
```

Node 24+ is required: the server runs its TypeScript directly, and SQLite comes from
`node:sqlite` rather than a native module. GPU steps will run on a native Mac worker
outside the container (D5) — nothing GPU-related belongs in compose.

**Which backend it will use** (D6): `SHOWRUNNER_LLM_BACKEND` decides when it is set;
unset, an `ANTHROPIC_API_KEY` means the API and no key means the `claude` CLI. Both are
read from `.env` (or the environment, which wins). Whichever it picks, it checks that the thing is actually there and says so
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
cp -n .env.example .env                # -n: never overwrites a .env you already have
docker compose down && docker compose up --build   # always a FRESH container — see below
```

Put your `ANTHROPIC_API_KEY` in `.env`, or leave it empty to use the `claude` CLI instead.
Nothing to export, in this shell or any other.

Open <http://localhost:4455>.

> **Leave the Dead Light console running if you like.** Showrunner is on 4455 precisely so
> it doesn't fight the console on 4400. They used to collide in a way that was worse than
> a clean failure — the console took IPv4, the container took IPv6, both reported healthy,
> and `localhost:4400` served whichever one your browser resolved to. Nothing to stop, and
> nothing to work around.

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
curl -s http://localhost:4455/api/health    # should refuse the connection
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
ANTHROPIC_API_KEY= docker compose up   # empties it for this run only; .env is untouched
```

The boot log prints `!! LLM backend: claude-cli — NOT READY`, `/api/health` returns
`"ready": false` with the reason, and every launch button on the page is disabled with that
reason beside it. The app is otherwise entirely up: the library is mounted, the fixture
lists, past runs and gates all render. Nothing fails at the first model call, because
nothing gets that far.

## The E2 drill — founding a show, and moving its canon by proposal

The canon epic's exit, as one sitting. It takes about ten minutes and costs **nothing at
all**: every button on the canon bench says `No model call · $0.00`, and it means it.

The whole epic is one sentence you are about to make true five times: **only ratification
writes canon.** A loader raises. A form raises. A change to something already ratified
raises. None of them writes a row. Your click at the bench does.

### Before you start

Your library is at migration 5 — the schema E1 left. **Booting migrates it 5 → 9 by
itself**, in order, inside a transaction, and records what it applied; there is no migrate
command to run and nothing to back up by hand that `library/` isn't already.

```
npm install
npm run build
docker compose down            # a running container keeps the image it was BORN from —
docker compose up --build      # merging PRs changes nothing it serves until you do this
```

Or, without the container: `npm start` (it reads the current code directly). Either way
migrates on the way up.

Then, in another terminal:

```
npm run fixture:load           # spends nothing, safe to run twice
```

Read what it prints. It ends:

> Nothing here was ratified and nothing generated. The sheets are on the queue as promotion
> proposals; canon moves when Ryan rules them, and by no other route (D25).

That is the load doing exactly half the job on purpose. **Loading raises; only founding
rules.** Six sheets are now standing in a queue and Grey Harbor still has no canon in it.

Open <http://localhost:4455> and scroll past the episodes to **Canon — Grey Harbor**.

### 1 · Look at a show with no canon in it

Under **Entities**, all seven are `candidate`, each with the same sentence under it:

> “Ilse Renn” is a candidate — an identity registered, and a sheet nobody has ruled on. Not
> canon, and no check reads it.

Every one says **0 facts standing**. Under **The ledger**: *No ruling has been made on this
show's canon yet.* Under **Proposal queue**: six promotions, each with its change, its usage
context, its implications and its alternatives — the five parts of a proposal, on screen.

Note the third verb on each. **Reject** is disabled, with the reason in words:

> Blocked: Rejecting a proposal needs the reason — "reject with note" is the verb, and the
> note is what the next writer run reads (3.3).

Type a note into that proposal's box and watch the button come alive. That sentence is not
decoration: it is the same string the API refuses with, so a precondition can never become a
failure after the click.

### 2 · Found the show

Press:

> Found Grey Harbor — ratify its 6 founding sheets, one ruling each on the ledger
> *No model call · $0.00*

Three things change at once, and the third is the point:

1. The entities are `active`, each with its standing and a count of facts standing.
2. The queue is empty, and the founding button is disabled: *Grey Harbor has no founding
   sheets left to rule. Canon moves by proposal from here.*
3. **The ledger has six rows** — one per sheet, newest first, each ending *convened at the
   bench, no gate*.

Six rows, not one. Founding is a deliberate act over documents you have already read, and it
still rules them **one at a time** through the same API the queue uses. There is no bulk
write in this app and this is the closest thing to one.

Now look at the **Live** panel at the bottom. It has not moved, and that is correct: a bench
ruling convenes no gate and no run, so it lands on `canon_ruling` — the append-only ledger
canon is read by — rather than on the event stream. That was ruled on Aug 7 2026 (issue #29),
and the ledger section above is where you read it back.

### 3 · Promote the candidate

**Sefa Doule is still a candidate**, alone among the seven, and visibly so. The fixture put
him there for exactly this: `status: candidate` on his sheet told the loader to register the
identity and raise nothing.

Press **Open “Sefa Doule” below**. His sheet has no facts, no edges, no standing — a
candidate is allowed to be that ragged, and canon is not.

Under **Promote this candidate**, fill in what you want him to be:

- standing: `recurring`
- species: leave it on **`unknown` — declared, and a real answer**. Sefa came in on a tender
  and nobody has asked. That is different from a blank, it satisfies the required `species`
  at ratification, and it is tracked (D22).
- facts: type one, e.g. *Sefa Doule files against the line office's ledger, not the
  harbour's.*

Press **Promote Sefa Doule — raise the sheet below as a promotion proposal, for your own
ruling in the queue**. He is *still* a candidate; the sheet is now a proposal in the queue,
raised by you. Scroll down and **Ratify** it. He is canon, `active`, standing recurring,
with `species → unknown` on his edges and one fact standing.

> Want to see the requirement bite? Promote him with the species left off — there is no way
> to do that from the form, which always answers `unknown` — or ratify a promotion that has
> no species and read the refusal: *cannot become canon without a `species` … `unknown` is a
> real answer and satisfies this. A candidate may be half-written; canon may not.*

### 4 · Create an entity, and rule its promotion

Under **Create an entity**: category `character`, name `Ottilie Bray`, standing `recurring`,
species `unknown`, and a fact — *Ottilie Bray keeps the harbour's only working lathe.*

Press **Register a new character in Grey Harbor and raise its promotion — creating is
proposing, and it stays a candidate until you rule it in the queue**.

She appears in the entities list **immediately, as a candidate with 0 facts standing**, and
a promotion appears in the queue *raised by you, at the bench*. That gap between the two is
the whole invariant made visible: the identity exists, the sheet does not. **Ratify** it.

### 5 · Change one ratified fact — a second proposal

Press **Open “Ilse Renn” below**. Her facts each carry status and lineage:

> established with no episode — a founding sheet … · ratified at ruling 1 · 2026-08-07T…

Find *“Ilse has held the harbourmaster's post at Grey Harbor for eleven years.”* In the box
under it, type what canon should say instead — *… for twelve years.* — and press

> Propose a change to “…” — a second proposal, carrying this fact as its before, for your
> ruling in the queue

Before you rule it, read it in the queue. Its **Implications** line says *touches 1 ratified
fact*, and it names which. That blast radius is computed the moment you look at it and never
stored, so it cannot be stale.

**Ratify** it. Now her sheet says twelve years, and under **Not standing here** the eleven
year fact is present and `superseded`, with the ruling that closed it on its lineage.
Nothing was deleted. Canon is append-only; a change is a new row and a closure row.

### 6 · Read canon on the other side of that ruling

At the top of the canon section, **Canon as of**. Pick the ruling immediately *before* the
one you just made — the second entry in the list.

Ilse's facts re-render, and the fact says **eleven years** again.

Flip back to *now*: twelve. Flip to a date instead: it resolves to the last ruling made at or
before that day and says so — *a date maps onto a ruling, never the reverse*.

**That flip is the whole drill.** "Canon as of episode 4" is answerable because a fact is
valid over a range of rulings rather than being edited in place, because the ledger is a
monotonic clock rather than a timestamp, and because the only thing that moves it is you
ruling a proposal. Founding, promoting, creating, changing — four different-looking acts, one
ruling API, one ledger, one invariant.

### What this drill deliberately does not do

No model was called and no dollar was spent: the canon bench cannot spend. The **canon
library** screen — the one you actually want, with the point-in-time chip and the sheet
layout — is E5's, drawn in `mockups/canon-library.html`, and none of it was built here. What
was built is every fact that screen renders and every act it convenes.

## Where things are

| Path | What |
|---|---|
| `handoff/docs/README.md` | **Start here.** Index of the design docs, what's authoritative, and how to write an epic's issue file. |
| `handoff/docs/concept-and-architecture.md` | The ruled design — domain, orchestration, canon, checks, screens, build plan. Decisions D1–D24. |
| `handoff/docs/D20-image-backends.md` | Image generation in detail, carried forward from the Dead Light console. |
| `mockups/` | Eight approved screen mockups + their README. Serve that directory and open the floor screen — instructions in `mockups/README.md`. |

Work is tracked in [GitHub Issues](https://github.com/MrMophandle/Showrunner/issues),
one milestone per epic. **E1 · The spine** is issues #1–#9; **E2 · Canon** is issues #23–#29.
The shipped product documents are in `docs/` — `canon-schema.md` is what an empty show is
founded from (3.5), and it is tested like code.

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
