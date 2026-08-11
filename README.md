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

**E4 · The writing line and E5 · The cockpit are both code-done, and they share one exit.**
E4 built the writer's desk (canon as *this episode's audience* knows it, the entities left out
with the rule that kept each one out, Ryan's notes with their three origins), the three writing
stages with their gates and their correction loops, scenes derived from the written script, the
extraction that reads an approved draft for what it claims of canon, direct hand editing, the
reject that routes rather than rewinds, and the completion sweep. Ryan began that drill on the
scaffolding page and ruled it off mid-run (Aug 10 2026): four epics of records on one unstyled
page had become a wall of shifting text that failed the HIL contract. Nothing mechanical was
wrong, and **a drill that tests the operator's patience instead of the mechanisms measures
nothing** — so by ruling, E4 stands code-done and E5's exit is both epics'.

E5 built the eight rooms of D24 — six of them, the two the mockups draw for E6 saying so at
their own addresses: the floor, the episode room, the gate room, the canon library, the season
map and the arc page, to the approved mockups, with the friction he named as their acceptance
criteria (regions update in place, every section explains itself, no flow needs find-in-page).
It ruled one new verb on the way — **putting a draft down**, the fourth disposition a presenting
gate had been missing — and it retired the page that started it: `App.tsx` and its four sections
came down only after every door they held stood on a screen with a test at it. **The drill below
is the E4 flow, re-scripted against the cockpit, and operating it closes both epics at once.**

Each epic ends with a drill Ryan operates, not a test suite that passes. **The current epic's
drill lives below; retired drills live in git history**, and their operated-exit records are in
`handoff/docs/concept-and-architecture.md` §6.2.

## Running it

```
cp -n .env.example .env               # once; -n so it never overwrites an existing one
docker compose up                     # the app on http://localhost:4455
```

`.env` is gitignored and read automatically by `docker compose up`, `npm start`, and
`npm run dev` — there is nothing to export, in this shell or any other. Leave
`ANTHROPIC_API_KEY` empty in it to use the other backend, the `claude` CLI, which works
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
as plain files. The directory is gitignored, and compose creates it on first run.

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
outside the container, so nothing GPU-related belongs in compose.

**Which backend it will use**: `SHOWRUNNER_LLM_BACKEND` decides when it is set;
unset, an `ANTHROPIC_API_KEY` means the API and no key means the `claude` CLI. Both are
read from `.env` (or the environment, which wins). Whichever it picks, it checks that the thing is actually there and says so
at boot and on `/api/health` — a container with neither is a legitimate state that
reports itself, not a crash and not a surprise on the first model call.

## Founding Grey Harbor — a fresh library's first click

`npm run fixture:load` does exactly half the job on purpose: it registers the fixture's
entity sheets and raises a promotion proposal per sheet, and **writes no canon at all**
(**loading raises; only founding rules**). On a fresh `./library`, open
<http://localhost:4455/canon> — **the canon library**, from the bar of any room — and press
the one button under **Founding**:

> Found Grey Harbor — ratify its 6 founding sheets, one ruling each on the ledger
> *No model call · $0.00*

One click, six rulings on the ledger, entities `active`, the queue empty and the sidebar's
counts moved. Checks read *ratified* canon, so anything that reads canon — the
drill below included — needs this first. Ruling the seventh sheet, Sefa Doule the deliberate
`candidate`, stays yours to do or not, on her own page.

## The drill — writing an episode from the cockpit, and ruling what it claims

**The exit for E4 and E5 together.** It takes about forty minutes and the buttons project
**about $3.71** of real money — three writing calls and their checks are $3.60 of it, and the
reading past your last gate is the other $0.11. Every button states its cost before you press
it and says whose money it is; the ledger in step 9 is what was really spent.

**Seven of its ten steps cost nothing at all**, and that is the point rather than a saving:
presenting a draft for your ruling, putting one down, typing over one yourself, moving an
episode's pin on an arc, and ruling every proposal it raised are all `$0.00`. **Money is spent
writing and checking. It is never spent ruling.**

The sentence you are about to make true three times: **an approval is the only thing that moves
an episode on.** Not a producer writing. Not a check reading. Not your own hand editing. The
lifecycle names the stage an episode is *at* — the work it still owes — and a gate you approve
is what carries it to the next one.

### The rules of this drill, which are its acceptance criteria

You ruled the last one off for three reasons. They are this one's pass conditions, and they are
about the screens rather than the mechanisms:

1. **If you ever reach for find-in-page, this drill has failed.** Every step below names the
   room it happens in and the region inside it. If you cannot find the thing the step names by
   looking, stop and write it down.
2. **If a section name means nothing to you, this drill has failed.** Every heading on every
   screen carries a line of plain words beside it, and the component refuses to render one
   without. If a name still needs explaining, that line is the wrong line.
3. **If the page moves under your reading eye, this drill has failed.** Runs talk, checks land
   and rulings arrive while you are reading. Nothing the *system* does may change the height of
   anything. Your own click may — that is the one movement allowed, and it happens where your
   hand is.

**A failure of any of the three is a finding against E5, filed as its own issue, and then you
carry on.** Six have been filed that way already ([#39](https://github.com/MrMophandle/Showrunner/issues/39),
[#76](https://github.com/MrMophandle/Showrunner/issues/76),
[#88](https://github.com/MrMophandle/Showrunner/issues/88),
[#92](https://github.com/MrMophandle/Showrunner/issues/92),
[#93](https://github.com/MrMophandle/Showrunner/issues/93),
[#97](https://github.com/MrMophandle/Showrunner/issues/97)); a seventh is not a failed exit, it
is the exit working. What ends the drill early is a *mechanism* that does not do what the step
says it will.

### Before you start

```
git pull                                            # compose builds the LOCAL tree
docker compose down && docker compose up --build     # always a FRESH container — see above
```

Then, in another terminal:

```
npm run fixture:load           # spends nothing, safe to run twice
```

Open <http://localhost:4455>. That is **the floor** now — the home screen, not the old page.
The bar across the top carries the eight rooms; `/operating` is gone, and typing it lands you
back here.

**Found Grey Harbor first if you have not already** — the canon library's own button, per
**Founding Grey Harbor** above. It costs nothing and it takes one click. A writer is handed
*ratified* canon and nothing else; on a show whose sheets are still in the queue,
the desk in step 2 says so honestly — *0 canon entities in scope*, and every one of them left out
with the rule that kept it out — and every draft below would be written against an empty world.

### 1 · The half-door, and the verb that was missing ($0.00)

**This is the step your own library's history is for.** On the floor, find the **ep02 · Dry
Stores** row. Its button is disabled, and it says why:

> ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it
> directly.

That brief was written by E1's `demo` stage, which E4-1 retired, and approved at a gate that
predates the lifecycle seam. **A sentence in this app may not name a door you cannot open**, so
both doors it names are real — and both are in the same room. Click the row to open **the
episode room**, and go to **Artifacts**. The brief is there with its freshness beside it and two
doors under it. Press the first:

> Present the ep02 premise-brief v1 for your ruling — what the panel found is under it, and
> nothing deterministic stands
> *No model call · $0.00*

Watch the floor's **Needs you** region while it runs, if you have a second window: a card for
this gate arrives in space that was already reserved for it, and nothing under it moves an inch.
Follow the card — or the **Gates** panel in the room — into **the gate room**.

The brief is on screen as a document, readable, with any findings folded into it at their
anchors rather than listed beside it. At the bottom, pinned and out of the page's flow, is the
**decision dock**: four verbs, each a full sentence with its cost. Read all four before you
press one.

**Now close it.** Press:

> Close the ep02 premise-brief with your note — present-the-premise-brief-for-your-ruling ends
> here, ep02 is free the moment you click, and your note stands against the draft until something
> answers it
> *No model call · $0.00*

The composer expands **in place**, inside the dock — not a modal, and the document behind it
does not move. Try confirming with the box empty first. The button is disabled, with the reason
in words:

> Closing the ep02 premise-brief needs at least one note — closing says why, the same as
> a rejection does. Nothing reopens on this verb, so the note is the whole record…

That is the same string the API refuses with, byte for byte. Press **Esc**: the composer
collapses, nothing is filed, and what you typed is still there when you open it again.

Now write something you actually mean — *say what it costs her, not what it costs the harbour* —
leave the depth **unrouted**, and confirm.

**This verb is E5's one new ruling, and this is its first real outing.** Until E5-3 a presenting
gate had one exit and it was *approve*: a rejection there re-presented the same bytes as round 2,
because there is no writer behind a presenting gate to redo them — and D7 held the episode open
while it did, so the rewrite your note asked for could not happen until you approved the draft
you had just rejected. That was a real quirk with a real cost, recorded in the E4 ledger and
answered here. **The run ends, the episode is free, and the note stands.** Nothing was rewritten
and nothing was replayed.

#### Now read the premise button again

Back in the episode room, on the **Stage rail**. It has changed, and your own words are on it:

> Write the ep02 premise-brief again from the writer’s desk — the ep02 premise-brief has the note
> you closed it with at the premise-brief gate standing against it — rewriting reads it: “…”

And it is **pressable now**, immediately, because the run ended when you put the draft down.
Look at **Artifacts** too: your note is on the brief itself, standing against it. **A note
standing against an artifact reopens the stage that could answer it** — and a note is
answered by a new version and by nothing else.

### 2 · The desk, before you spend a cent ($0.00)

In the episode room, open **The writer's desk** and fold open the `premise` one. It is a read
the server already composed — opening it is free and starts nothing.

Read three things:

- **What it was handed**, with the door each entity came through in words — *standing core* —
  and each fact with the door in TIME it came through.
- **What it was NOT handed, and the rule that kept each one out.** Sefa Doule is there: a sheet
  nobody has ruled is on nobody's desk. This is the half you cannot infer from a list of what
  was included, and it is the half that tells you why a draft came out the way it did.
- **What you have already said.** Your note from step 1, verbatim, with where you said it:
    *the note you closed the ep02 premise-brief with at round 1* — and the sentence names the
    verb, because closing and rejecting are the same authority doing two different things.

Then read **the prompt this would send**. Your words are in the call itself, under
`── WHAT THE SHOWRUNNER HAS ALREADY SAID ──`. **That is "a re-run provably reads the notes
back", and you can see it before you spend anything.** The desk is composed by the same
function the writing step calls — not a reconstruction of it.

### 3 · The premise, written from your note (~$0.91)

Press the reopened button. Its cost line is exact and it is the thing to read before you click:

> *1 Opus call, ~$0.07 + up to 7 Opus calls, ~$0.84 to check it, per draft — and the loop stops
> at 3 drafts · your money, spent when you click*

Watch the **live region** in the rail. It is a box with a height, and it had that height before
anything arrived. The first line is the desk describing itself:

> The ep02 premise desk — writing from canon alone, N canon entities in scope and M left out,
> canon as the audience knows it at ep02, 1 arc (vanilla), **1 note standing**.

The counts are your library's, not a fixture's — what matters is that one of the left-out ones is
Sefa Doule and the desk said why, and that the note standing is the one you wrote in step 1.
Then the draft streams into the line under it, and the transitions land in the log under that.
**Keep your hand on something while it does** — the rail's buttons, the artifact you were
reading. Nothing below the region moves.

When it parks, go to the gate room and **read the brief against your note.** It should have
answered it. If it has not, close it again with a sharper one — that is what the loop is for,
and it stops at three drafts whatever happens.

**Approve it.** Then watch two things:

1. The lifecycle track moves: `premise → **outline** → script → … `, and the amber pip — *your
   hand* — is on `outline` now. Go back to the floor if you want to see it there too. **Your
   ruling did that**, and nothing else can.
2. The outline button stops being refused. Its sentence was *"ep02 is at premise and has not
   reached outline yet"*; the column that answers is the lifecycle, because an approval is the
   only thing that writes it.

### 4 · Declare the waypoint, before a word of it is written ($0.00)

In the episode room, the line under the title reads:

> ep02 declares no position on any arc, so it is **vanilla**. Not every episode advances an
> arc, and declaring one is a choice rather than a repair.

and **Arc positions** carries the arc anyway, with its own version of the same news: *nothing is
owed here*. Every waypoint on it has a door. Press the second:

> Declare ep02 at waypoint 2 “The harbor is worth spending on” of “What the harbor is for” —
> the pin moves, and the landing proposal is raised when the script is read
> *No model call · $0.00*

**Nothing was raised and nothing became canon.** Declaring is a production decision — you saying
which waypoint this episode is written to land. The *landing* is a claim about the world, so it
needs a subject entity, and that is a writing judgement only the writer can make out of the
written episode. Step 7 is where it arrives.

Do it now rather than later, and watch what it costs you: every writing button below gains one
check, because an arc position is one. The outline goes from *up to 8 checks* to
*up to 9*, and the cost line under it from *~$0.96* to *~$1.08*.

### 5 · The outline, and then your own hands on it (~$1.19, then $0.00)

Press:

> Write the ep02 outline from the writer’s desk and present it for your ruling — “Dry Stores”,
> one call, then up to 9 checks read it
> *1 Opus call, ~$0.11 + up to 9 Opus calls, ~$1.08 to check it, per draft — and the loop stops
> at 3 drafts · your money, spent when you click*

What comes back is **prose about the movement of the story** — what turns, in what order, and
what the audience knows after each turn. Check the one thing this artifact exists to not be:
**there is no scene list in it, no numbering, and no count anywhere.** That restraint is spent
in step 6, and it was expensive to keep.

Approve it at the gate room. The lifecycle moves to `script`.

**Now take it over.** Back in the episode room, on **Artifacts**, the outline's second door:

> Edit the ep02 outline yourself — what you type lands word for word as v2, and the free checks
> read it before the button comes back
> *No model call · $0.00*

The box opens **in the panel**, under the artifact it is about. Change something you actually
want changed — a movement's name, an order, a withholding — and land it. What lands is what is
in the box, character for character: **a hand-made asset always wins**, and nothing tidied your
wording on the way in. `outline-v2.md` is on the volume beside `outline.md`; nothing is ever
written over.

Now watch three regions, each of which should do exactly one thing:

- **The outline's own line changes**, and says whose hand did it: *The outline stands at v2 —
  **you edited it by hand.** Nothing it was built from has moved since.*
- **Nothing went stale, and that is the staleness rule answering rather than sleeping.** There
  is no script yet, so there is nothing built on the outline to go stale — and the room says
    that instead of a flag, because every version is compared each time you look (there is no
  `is_stale` column to have got this wrong). Edit the outline again after step 6 and the script
  goes stale on the spot, from the same query.
- **The scene grid does not move at all.** Scenes are derived from the *script*, and there
  isn't one — an outline edit has nothing to say to it, and the honest empty state it is
  showing does not flinch.

Then fold open **the `script` desk**. It shows **your v2, whole**, under what it writes from.
**The script below will be built from your words, not the model's**, and that is visible before
you spend anything on it.

### 6 · The script, where the scenes fall (~$1.50, then ~$0.11)

Press:

> Write the ep02 script from the writer’s desk and present it for your ruling — “Dry Stores”,
> one call, then up to 10 checks read it
> *1 Opus call, ~$0.30 + up to 10 Opus calls, ~$1.20 to check it, per draft — and the loop stops
> at 3 drafts, **then 1 Opus call, ~$0.11 after you approve it**, to read what the
> script claims of canon into proposals for your ruling · your money, spent when you click*

Read that last clause before you click it. **One click buys the whole run**, including the step
that lands on the far side of your ruling — so the button covers the whole run or it lies
cheaply.

In the live region, after the draft streams:

> The ep02 script draft breaks into **N** scenes — derived from the draft, never asked for

**`N` is an output.** Nothing upstream chose it: the outline carries no grid on purpose, the ask
tells the model the count is its own and refuses the pairing-off in as many words, and nothing
in this app reads the outline's headings. If `N` happens to equal the number of movements in
your outline, that is a coincidence and not a mechanism.

And **the scene grid fills** — one row per scene, with the continuity board's own readings
across it: who is present, the environment, ship position, the clock. It was an honest empty
state with a priced button in it a moment ago; now it is the room's face.

Approve it at the gate room. Then watch the run **keep going** — the extraction is a paid step
past your ruling, and it reads the draft you approved rather than a round the loop replaced:

> Reading the ep02 script for what it claims of canon…

### 7 · The sweep, ruled one at a time ($0.00)

In the episode room, **Riding this episode** has filled:

> ep02 carries N proposals to rule — … They ride ep02 until you rule them, one at a time.
> Approving the script was not a ruling on any of them.

**Approving the script was not a ruling on any of them.** It never is: only ratification writes
canon, and it is one proposal, one ruling, one row on the ledger. Each rider carries its five
parts — the change, the usage context (the passage from the script that made it necessary), the
**implications** (computed at read time, so they are about canon as it stands *now*), the
alternatives — and three verbs.

Do all three of these, on three different riders:

1. **Ratify one fact delta.** Something the episode established that you want to be true.
2. **Reject one with a note.** Something the model invented that you do not want in the bible.
   The note is required, in the same sentence the API refuses with, and it is read back by later
     writing runs — the rejection is not a delete, it is a record.
3. **Rule the landing on its merits.** It is the card that says *waypoint landing · “Ilse
      Renn” — raised by a writing run, riding ep02*, and the fact under it reads *“What the harbor
      is for” reached waypoint 2 “The harbor is worth spending on” in ep02.* **The subject is the
      model's answer**, not a lookup: a landing is a claim about somebody, and which somebody is a
   writing judgement made out of the written episode. Read the quote it cites against waypoint
   2's own **landing criteria** — on the waypoint in the arcs panel, and in full on the arc
   page. *Somebody identifiable is worse off, and neither she nor they say so
   out loud. If she justifies the diversion, or writes it down, the episode has landed waypoint
   3 by accident.* If the script really did it, ratify. If it overshot, reject with a note
   saying so. **The pin does not move either way** — what your ruling changes is whether landing
   it is canon.

**There is no fourth button.** Three riders take three rulings.
`POST /api/sweep/:id/ratify-all` is a 404 because it does not exist, not because something
refuses it.

Watch the card you rule leave, and **watch the one you were not looking at stay exactly where it
was.** That is the one movement this cockpit allows: the thing your own hand did.

### 8 · The season seen whole, and the arc that moved ($0.00)

Two rooms you have not been in yet, and this is the moment they are worth reading.

**The season map** (`/season` in the bar). Episodes are columns, arcs are rows. ep02's cell on
*What the harbor is for* is in the ink that means **landed** if you ratified it — a different
ink from ep01's, which is a **pin** and has never been ruled — and the lineage is inside the
cell: established in ep02, ratified at ruling N. If you rejected the landing instead, the cell
says that, and it says it differently again.

**The arc page** (the arc's name, from the map or from the room). Under **Waypoints**, three of
them in order, wearing different standings: waypoint 1 **ahead**, waypoint 2 with ep01's pin and
your ep02 ruling on it, waypoint 3 **ahead**. Only the landed one carries a lineage line, and
that is the whole point — a pin is a production decision, a landing is a fact with a ruling
behind it, and the page draws them as the two different things they are. The chip at the top
counts it for you: *declared to waypoint 2 of 3*, and what has landed.

**How this arc is checked** is the section worth the trip. It carries the `waypoint-drift`
check's real instructions and its worked example, byte for byte as the sheet wrote them, and it
says which episode's declaration the text was composed for. **That is what the ninth check
was reading in steps 5 and 6** — you can now see exactly what it was told, rather than inferring
it from what it said.

### 9 · Reviewing the reviewers, and the projection against the ledger ($0.00)

Back in the episode room, two panels at the bottom.

**Reviewing the reviewers** — how each check has behaved lately, one sentence per check rather than a row
of unlabelled numbers. It is a *question*, and nothing in this app acts on it: there is no button
in that panel. A check that keeps raising findings you keep dismissing has earned a look at its
instructions; one that has never been cited has earned a look at whether it should run at all.

**Cost ledger** — what each button projected, against what the rows recorded. Compare it with
the **$3.71** the buttons promised.

It will be lower, and the difference is the projections deliberately over-stating in three
places, all of them named on the buttons: the check counts are **upper bounds** (how many
categories *declare* this artifact kind, not how many run — a category with no entity in
provenance correctly stays home), the prompt-token figures are generous against what is really
sent, and the loop is priced at three drafts when it usually stops at one. A failed call is a
line on it too, because a call that came back wrong still spent.

**A button that under-states is a button that lies cheaply.** If any projection surprised you in
the other direction, that is a finding about a button — write it down.

### 10 · ep01, untouched

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

**It does not check ep02 deterministically.** The text panel ran inside every correction loop
and its findings are folded into the drafts at the gate room, but the continuity board's free
rules, the findings that refuse a stage and both doors down from them are E3's drill, and they read ep01's planted
contradictions. The episode room's scene grid shows you where they would appear.

**It does not abandon anything.** An episode can be abandoned at any stage and keeps the one it reached, and
abandoning raises a revert per ratified fact, one ruling at a time — none of it is built, and
none of it is here.

**And it does not touch two rooms, because there are two.** The review desk and the screening
room say so at their own addresses: E6 builds them, when there is an image to review and a cut
to watch. Nothing generates one yet, so there is nothing there to be missing.

### Nothing above may surprise you

Every expectation this drill states is backed by a test that runs on fakes, with no key and no
network — the words on the buttons, the refusals on the disabled ones, what a close does and
does not do, where the scenes come from, which panel each door is in, and the three inks on the
map. The costs are the only numbers read off the real world, and they are read *before* you
click rather than after.

So the honest reading of a surprise is: **a mechanism did something no test covers.** That is
worth stopping for, and it is the only thing that is. A screen that is ugly, a sentence that is
too long, a section in the wrong order — those are findings, filed as they come, and the drill
carries on to the end.

## Where things are

| Path | What |
|---|---|
| `handoff/docs/README.md` | **Start here.** Index of the design docs, what's authoritative, and how to write an epic's issue file. |
| `handoff/docs/concept-and-architecture.md` | The ruled design — domain, orchestration, canon, checks, screens, build plan. Decisions D1–D19 in-section, D20–D25 in the addendum. |
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
