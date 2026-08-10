# Showrunner

A containerized web app for multi-show episodic video production — writing, canon
keeping, image and audio generation, assembly, and publishing, with the showrunner
ruling at every gate.

**Status: E1–E3 complete, each exit operated for real.** The spine (domain schema, runner
with named locks and crash-resume, gates, the append-only event log over SSE, the Claude
adapter and cost ledger) survived a `SIGKILL` mid-run on Aug 5 2026 — one call in, one call
out, across a kill. Canon (categories, entities, facts with validity ranges, typed
relations, proposals and the one ruling API, founding) was founded and moved by ruling at
the bench on Aug 7. Checks (findings and passes, the continuity board's free deterministic
rules, the generic checker and its honest gap, the D12 wall and its doors, panels with
mandatory story-craft, the three remediations, cried-wolf tracking) ran on real money on
Aug 9 — $1.32 against ~$1.60 projected, both planted contradictions surfaced, and the wall
came down through both doors.

**E4 · The writing line is built, and its exit is the drill below, not yet operated.** The
writer's desk (canon as *this episode's audience* knows it, the entities left out with the rule
that kept each one out, Ryan's notes with their three origins), the three writing stages with
their gates and their correction loops, scenes derived from the written script, the extraction
that reads an approved draft for what it claims of canon, direct hand editing, the reject that
routes rather than rewinds, and the completion sweep — all of it on fakes, in 963 tests. The
drill below is what turns that into an operated exit. Writing it exposed one wall — an episode
holding an artifact no writing gate ever saw could not leave its lifecycle stop — and step 1
walks through where that wall was: **[issue #76](https://github.com/MrMophandle/Showrunner/issues/76)**,
filed from the drill and closed before it was operated.

Each epic ends with a drill Ryan operates, not a test suite that passes. **The current
epic's drill lives below; retired drills live in git history**, and their operated-exit
records are in `handoff/docs/concept-and-architecture.md` §6.2.

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
> `docker compose up` over a live container change nothing it serves. And compose builds
> the **local tree**, not GitHub — `git pull` first. Whenever code or
> `.env` has changed since the container started:
> `git pull && docker compose down && docker compose up --build`. Both real incidents so
> far — a rotated key the container didn't have, and a drill against a two-day-old
> page — were this, and every drill assumes a fresh container.

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

## Founding Grey Harbor — a fresh library's first click

`npm run fixture:load` does exactly half the job on purpose: it registers the fixture's
entity sheets and raises a promotion proposal per sheet, and **writes no canon at all**
(**loading raises; only founding rules** — D25). On a fresh `./library`, open the page,
scroll to **Canon — Grey Harbor**, and press:

> Found Grey Harbor — ratify its 6 founding sheets, one ruling each on the ledger
> *No model call · $0.00*

One click, six rulings on the ledger, entities `active`. Checks read *ratified* canon
(invariant 2), so anything that reads canon — the drill below included — needs this
first. Ruling the seventh sheet, Sefa Doule the deliberate `candidate`, stays yours to
do or not at the bench.

## The E4 drill — writing an episode, and ruling what it claims

The writing line's exit, as one sitting. It takes about forty minutes and the buttons project
**about $3.85** of real money — the three panels are $3.24 of it. Every button states its cost
before you press it and says whose money it is; the ledger afterwards is what was really spent.

**Five of its eight steps cost nothing at all**, and that is the point rather than a saving:
presenting a draft for your ruling, typing over one yourself, moving an episode's pin on an arc,
and ruling every proposal it raised are all `$0.00`. **Money is spent writing and checking. It
is never spent ruling.**

The sentence you are about to make true four times: **an approval is the only thing that moves
an episode on.** Not a producer writing. Not a check reading. Not your own hand editing. The
lifecycle names the stage an episode is *at* — the work it still owes — and a gate you approve
is what carries it to the next one.

And the one step 1 is there to prove: **a rejection at a gate with no writer behind it still has
somewhere to go.** Your note reopens the stage that could answer it, and ruling again at that
same gate moves the episode on — [issue #76](https://github.com/MrMophandle/Showrunner/issues/76),
found while writing this drill and closed before it was operated.

### Before you start

```
git pull                                           # compose builds the LOCAL tree
docker compose down && docker compose up --build    # always a FRESH container — see above
```

Then, in another terminal:

```
npm run fixture:load           # spends nothing, safe to run twice
```

Open <http://localhost:4455>.

**Found Grey Harbor first if you have not already** — the canon section's button, per
**Founding Grey Harbor** above. It costs nothing and it takes one click. A writer is handed
*ratified* canon and nothing else (invariant 2); on a show whose sheets are still in the queue,
the desk in step 1 says so honestly — *0 canon entities in scope and 7 left out* — and every
draft below would be written against an empty world.

### 1 · The other door, and the note that gets read back ($0.00)

**This is the step your own library's history is for.** On **ep02 · Dry Stores**, read the
launch button. It is disabled, and it says why:

> ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it
> directly (E4-5).

That brief was written by E1's `demo` stage, which E4-1 retired, and approved at a gate that
predates the lifecycle seam. **A sentence in this app may not name a door you cannot open**, so
both doors it names are on the card. Press **Open the ep02 writing room below** and use the
first one:

> Present the ep02 premise-brief v1 for your ruling — what the panel found is under it, and
> nothing deterministic stands
> *No model call · $0.00*

The run parks. Under **The gates**, the brief is on screen — readable, not a filename — with
its **Loop history** (round 1, open) and three verbs, none of them disabled.

**Now reject it, with a real note.** Type something you actually mean — *say what it costs her,
not what it costs the harbour* — leave the depth **unrouted**, and press:

> Reject the ep02 premise-brief with notes — …
> *No model call · $0.00*

Try it with the box empty first. The button is disabled, with the reason in words:

> Rejecting the ep02 premise-brief needs at least one note — “reject with notes” is the verb,
> and the notes are what the step reopens with. A rejection that said nothing would reopen the
> round with nothing to write against, and later runs read your notes back off the desk (4.4).

That is the same string the API refuses with, byte for byte.

**Then look at the desk.** Under **The writing line**, on the `premise` card, press *What the
premise writer would be handed*. Scroll to **What you have already said, and where you said
it**:

> **gate-rejection** · your round 1 rejection of the ep02 premise-brief: “…”
> *Your own rejection of this draft, at its gate — round 1, unrouted, which is the legal
> default. It is your opinion of the thing being rewritten.*

And below it, in **The prompt this would send**, your words are in the call itself, under
`── WHAT THE SHOWRUNNER HAS ALREADY SAID ──`, verbatim, with where you gave them.

**That is the exit's "a re-run provably reads the notes back", and you can see it before you
spend a cent.** The desk is composed by the same function the writing step calls — not a
reconstruction of it — so what is on this screen is what the next call gets.

#### And now read the premise button again

It has changed, and your own words are on it:

> Write the ep02 premise-brief again from the writer’s desk — the ep02 premise-brief has your
> note from the premise-brief gate standing against it — rewriting reads it: “…”

**A note standing against an artifact reopens the stage that could answer it** (D21) — that is
what "reject is routed, not rewound" buys you, and it is the same mechanism whether you wrote
the note at this artifact's gate or at a later one. It is still disabled for one round longer,
and the reason is a different sentence and a true one: *"ep02 already has a premise-gate run,
and it is waiting on your ruling… One run per episode (D7)."*

So rule. Press **Approve** on the round-2 presentation, and watch the lifecycle column:

> ep02 moves from premise to outline — you approved its premise gate.

**A ruling is a ruling, whichever door convened it** ([#76](https://github.com/MrMophandle/Showrunner/issues/76)).
That brief was written by a retired stage and approved at a gate that predates the lifecycle
seam; nothing was replayed and nothing is retroactive — the episode moved because you ruled
again, now, at a live door. Approving there moves it on only when the episode is standing *at*
the stage that produces what you ruled on, which is why the same click on ep01's script (at
`script`) takes it to `assets` and the same click on a brief of an episode already past
`premise` moves nothing at all.

**Leave the note standing.** It is what step 3's button is offering to answer, and a note is
answered by a new version and by nothing else — so typing over the brief yourself here would
close that button before you get to it. Step 4 is where your own hands go on a draft. Steps 2
through 8 run from here.

### 2 · Declare the waypoint, before a word is written ($0.00)

In the writing room, scroll to **Where ep02 stands on its arcs**. It reads:

> ep02 declares no position on any arc — it is **vanilla**, which is legal, tracked and never a
> failure state (1.1). Declaring one is a choice, not a repair.

Press:

> Declare ep02 at waypoint 2 “The harbor is worth spending on” of “What the harbor is for” —
> the pin moves, and the landing proposal is raised when the script is read
> *No model call · $0.00*

The sentence changes to *"A pin is not a fact: the landing proposal is raised when the script is
read, with the subject the writer answers (D8)."* **Nothing was raised and nothing became
canon.** Declaring is a production decision — you saying which waypoint this episode is written
to land. The *landing* is a claim about the world, so it needs a subject entity, and that is a
writing judgement only the writer can make out of the written episode. Step 5 is where it
arrives.

Do it now rather than later, and watch what it costs you: every writing button below gains one
reviewer, because an arc position is a check. The premise goes from *up to 7 reviewers* to
*up to 8*.

### 3 · The premise, written from your note (~$1.03)

Press the premise button. It is the reopened one from step 1 — *"write the ep02 premise-brief
again… rewriting reads it"* — and **its cost line is the thing to read before you click**, and
it is exact:

> *1 Opus call, ~$0.07 + up to 8 Opus calls, ~$0.96 to check it, per draft — and the loop stops
> at 3 drafts (invariant 5) · your money, spent when you click*

Eight, not seven, because you declared the pin in step 2 and an arc position is a reviewer.

Watch the **Live** panel. The first progress line is the desk describing itself:

> The ep02 premise desk — writing from canon alone, 6 canon entities in scope and 1 left out,
> canon as the audience knows it at ep02, 1 arc (1 declared), 1 note standing.

Six in scope, one left out — that one is **Sefa Doule**, the fixture's deliberate candidate, and
the desk says why in words: a sheet nobody has ruled is on nobody's desk. One note standing is
the one you wrote in step 1. Then the draft streams, then the panel reads it.

When it parks, **read the brief against your note.** It should have answered it. If it has not,
reject it again — that is what the loop is for, and it stops at three drafts whatever happens.

Approve it. Then watch two things:

1. The lifecycle track moves: `premise → **[outline]** → script → …`. **Your ruling did that**,
   and nothing else can.
2. The outline button stops being refused. Its sentence was *"ep02 is at premise and has not
   reached outline yet"*; the column that answers is the lifecycle, because an approval is the
   only thing that writes it.

### 4 · The outline, and then your own hands on it (~$1.19, then $0.00)

Press:

> Write the ep02 outline from the writer’s desk and present it for your ruling — “Dry Stores”,
> one call, then up to 9 reviewers read it
> *1 Opus call, ~$0.11 + up to 9 Opus calls, ~$1.08 to check it, per draft — …*

What comes back is **prose about the movement of the story** — what turns, in what order, and
what the audience knows after each turn. Check the one thing this artifact exists to not be:
**there is no scene list in it, no numbering, and no count anywhere.** That restraint is spent
in step 5, and it was expensive to keep.

Approve it. The lifecycle moves to `script`.

**Now take it over.** Under **What is written**, on the outline, press:

> Edit the ep02 outline yourself — what you type lands word for word as v2, and the free checks
> read it before the button comes back
> *No model call · $0.00*

Change something you actually want changed — a movement's name, an order, a withholding. Press
it. What lands is what is in the box, character for character: **a hand-made asset always wins**,
and nothing tidied your wording on the way in. `outline-v2.md` is on the volume beside
`outline.md`; nothing is ever written over.

Read the sentence it answers with:

> Your ep02 outline is on the volume as v2, word for word. … **ep02 is still at script — an
> approval is the only thing that moves an episode on.**

Then open the **script** desk (*What the script writer would be handed*) and look at **What it
writes from**. It is your v2, whole. **The script below is built from your words, not the
model's** — and that is visible before you spend anything on it.

### 5 · The script, where the scenes fall (~$1.50, then ~$0.11)

Press:

> Write the ep02 script from the writer’s desk and present it for your ruling — “Dry Stores”,
> one call, then up to 10 reviewers read it
> *1 Opus call, ~$0.30 + up to 10 Opus calls, ~$1.20 to check it, per draft — and the loop stops
> at 3 drafts (invariant 5), **then 1 Opus call, ~$0.11 after you approve it, to read what the
> script claims of canon into proposals for your ruling** · your money, spent when you click*

Read that last clause before you click it. **One click buys the whole run**, including the step
that lands on the far side of your ruling — so the button covers the whole run or it lies
cheaply.

In the **Live** panel, after the draft streams, this line:

> The ep02 script draft breaks into **N** scenes — derived from the draft, never asked for

**`N` is an output.** Nothing upstream chose it: the outline carries no grid on purpose, the ask
tells the writer the count is theirs and refuses the pairing-off in as many words, and nothing
in this app reads the outline's headings. If `N` happens to equal the number of movements in
your outline, that is a coincidence and not a mechanism.

Approve it at its gate. Then watch the run keep going — **the extraction is a paid step past
your ruling**, and it reads the draft you approved rather than a round the loop replaced:

> Reading the ep02 script for what it claims of canon…

### 6 · The sweep, ruled one at a time ($0.00)

Back on the ep02 card, a sentence has appeared that was not there before:

> ep02 carries N proposals to rule — … They ride ep02 until you rule them, one at a time —
> approving the script was not a ruling on any of them.

**Approving the script was not a ruling on any of them.** It never is: only ratification writes
canon, and it is one proposal, one ruling, one row on the ledger. Press:

> Rule the N proposals riding ep02 — the completion sweep, one at a time, each on its own row of
> the ledger
> *No model call · $0.00*

Each rider carries its five parts: the change, the usage context (the passage from the script
that made it necessary), the **implications** — computed at read time, so they are about canon
as it stands now — and the three verbs.

Do all three of these, on three different riders:

1. **Ratify one fact delta.** Something the episode established that you want to be true.
2. **Reject one with a note.** Something the writer invented that you do not want in the bible.
   The note is required, in the same sentence the API refuses with, and it is read back by later
   writer runs — the rejection is not a delete, it is a record.
3. **Rule the landing on its merits.** The `landing` rider is *"arc1 reached waypoint 2 in
   ep02"*, with the subject entity the writer answered for. Read the quote it cites against the
   waypoint's own **landing criteria**, which are on the arc in step 2. If the script really did
   it, ratify. If it overshot into waypoint 3, reject with a note saying so. **The pin does not
   move either way** — what your ruling changes is whether landing it is canon.

**There is no fourth button.** Three riders take three rulings. `POST /api/sweep/:id/ratify-all`
is a 404 because it does not exist, not because something refuses it.

When the last one is ruled, the sentence on the card goes. Nothing was marked: "swept" is a
question asked again every time, off the queue, and there is no `swept_at` column to go and look
at.

Then go to the canon bench, open the entity whose delta you ratified, and read its lineage line:

> established in ep02 · ratified at ruling **N** · 2026-08-…

That is what an episode does to canon, with the whole chain on one line.

### 7 · Read the projection against the ledger

Scroll to the ep02 card and read **Spend on this episode**. Compare it with what the buttons
projected before you pressed them: **about $3.85**.

It will be lower, and the difference is the projections deliberately over-stating in three
places, all of them named on the buttons: the reviewer counts are **upper bounds** (how many
categories *declare* this artifact kind, not how many convene — a category with no entity in
provenance correctly stays home), the prompt-token figures are generous against what is really
sent, and the loop is priced at three drafts when it usually stops at one.

**A button that under-states is a button that lies cheaply.** If any projection surprised you in
the other direction, that is a finding about a button — write it down.

### 8 · ep01, untouched

Last, prove the drill kept to its own episode. In a terminal:

```
for f in premise outline script; do
  diff -q fixtures/greyharbor/episode/01-the-long-pier/$f.md \
          library/artifact/greyharbor/s01e01/$f.md
done
```

Silence is the result. The three files ep01 was seeded with are byte-identical to the fixture,
and nothing this drill did touched them. (If your library carries `script-v2.md` beside
`script.md`, that is the E3 drill's rewrite — still there, still beside the original, because
nothing in this app is ever written over.)

### What this drill deliberately does not do

**It does not check ep02.** The panel ran inside every correction loop and its findings are on
the gates, but the continuity board, the D12 wall and the cried-wolf record are E3's drill, and
they read the script. Open the ep02 check bench afterwards if you want them.

**It does not abandon anything.** `abandoned_at` is a column beside the lifecycle enum and
abandoning raises a revert per ratified fact, one ruling at a time — none of it is built, and
none of it is here.

**And it is not the episode room.** The screen you actually want — the lifecycle rail, the desk
folded beside the draft, the gate with its findings at their anchors and a decision dock — is
E5's, drawn in `mockups/episode-room.html` and `mockups/gate-room.html`. None of it was built
here. What was built is every record those screens render and every act they convene.

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
