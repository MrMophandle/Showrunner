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

**E3 · Checks are built, and its drill has not been run yet.** Findings and check passes, the
continuity board and its free deterministic rules, the generic checker and its honest gap, the
D12 wall and the three doors it comes down through, the panel of category, arc and craft
reviewers, the three remediations behind a finding, cried-wolf tracking, and a check bench on
the operating page to run and read all of it from. The E3 drill is below, after E2's — it costs
about $1.60 and it is the epic's exit.

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

## The E3 drill — running the checks, and operating the wall

The checks epic's exit, as one sitting. It takes about twenty minutes and the buttons project
**about $1.60** of real money — the panel is $1.20 of it. Every button states its cost before
you press it and says whose money it is; the ledger afterwards is what was really spent.

Two of the four buttons on this bench cost **nothing at all**, and that is the point rather
than a saving: the deterministic tier reads rows a reading already paid for, so a correction
loop never bills you twice for the same script.

The sentence you are about to make true four times: **checks argue, they never veto.** A red
finding makes an artifact loud. One kind of finding — the deterministic kind, which counts rows
and cannot be wrong about them — blocks *the next stage* and never your gate, and it comes down
three ways, all of them yours.

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

**Found Grey Harbor first if you have not already** — the canon section's button, from step 2
of the E2 drill. It costs nothing and it takes one click. Checks read *ratified* canon
(invariant 2); a show whose sheets are still sitting in the queue has no canon for them to
argue with, and the panel would read a script against nothing and say so honestly.

### 1 · Open the ep01 check bench

On **ep01 · The Long Pier**, press **Open the ep01 check bench below**. It is a read: it starts
nothing and costs nothing.

Scroll to **Checks — ep01 · The Long Pier**. You should see:

- the script itself, whole and readable, not a filename;
- **Verdict board — script v1** above it saying *0 of 10 reviewers have read this draft*. Not
  "clean". Nothing has read it, and a board that rendered an unread panel as a short clean one
  would be the exact lie this epic exists to prevent;
- four buttons under **Read it**, two of them priced and two of them `No model call · $0.00`;
- **The next stage: Not blocked.**

### 2 · Build the continuity board — the deterministic tier (~$0.12)

Press:

> Read the ep01 script into a continuity board and run the rules over it — one reading of the
> whole script
> *1 Opus call, ~$0.12 · your money, spent when you click*

One call reads the script into a grid; then four rules read the grid **for nothing**. Watch the
**Live** panel: the extraction's progress line, then `Checking the ep01 continuity board — 4
deterministic rules, free`.

When it finishes, four things are true and every one of them is exact — this tier counts rows,
so it says the same thing every time:

1. **Scenes 5–6, the dual presence.** A card anchored at scene 6, marked **STAGE-BLOCKING**:
   *Ilse Renn is in two places at one time.* Severity **high**, confidence **certain** — two
   values, never one — and *deterministic, from the rows*.
2. **Scene 4, the vacuum violation.** The board's own rule, also blocking: *Tobin Wick is
   outside the pressure hull in scene 4 with nothing between them and the void.*
3. **The next stage** now reads **Blocked**, with the whole sentence:

   > ep01 is blocked — the vacuum-without-protection finding at scene 4 of the ep01 script
   > stands unresolved: “…”. 1 more deterministic finding stands with it. Deterministic
   > findings block the next stage and never your gate (D12): rule on it at the gate as a
   > recorded override, put it down with a note, or fix it and re-run the checks — the
   > deterministic ones cost nothing.

   Scroll **up** to the ep01 card. The demo launch button is disabled with that same sentence
   under it, word for word. One composer, two readers: a precondition can never become a
   failure after the click.
4. **The two obeyed rules are on the board, green.** `impossible-adjacency` and
   `duplicate-arrival` each read the grid and found nothing, and each has a row saying so.
   That is a **measurement**, not an absence — and it is the denominator the cried-wolf record
   at the bottom of the bench counts against.

Note what is *not* blocked: all four **Read it** buttons are still live. The wall's own sentence
tells you to re-run the checks, and a wall that then refused that button would be a dead end
built out of its own advice.

### 3 · Convene the panel — the semantic tier (~$1.20)

Press:

> Check the ep01 script v1 — 5 category checks, 1 arc position and 4 craft reviewers read it,
> 10 reviewers · 10 Opus calls, ~$1.20
> *10 Opus calls, ~$1.20 · your money, spent when you click*

Ten reviewers, ten calls, one progress line each — *3 of 10 · Species — 4 facts in scope*. The
craft reviewers say something different on purpose: *reading it as craft, with no canon in
front of it* (D13).

This tier is a model reading a script, so unlike step 2 its exact words are its own. What the
drill expects is the **shape**, and it should hold:

- **The world-rules check fires on scene 4**, semantic, severity high — the same moment the
  board's rule caught from the other side. Its card **quotes the Halvani fact it argues with**,
  with its lineage: *a Halvani in unprotected vacuum loses consciousness in about nine
  seconds…* That fact is only in scope because Tobin's sheet declares `species: Halvani` and
  facts travel that edge (D22). Two reviewers, two readings, one scene — that is a panel, not
  a duplicate.
- **The two are separate cards, in the same scene.** The board's rule anchors at the scene
  heading; the reading anchors at the line it argues with. Cards merge only where the quoted
  spans *overlap*, which is what puts two reviewers who read the same sentence on one card.
- **Hull rules 2 and 3 stay silent, and you can see that the silence was measured.** On the
  verdict board, under the `world-rules` row, every fact it was handed is listed with what it
  did about it. Rule 1 reads `cited`. The other two read **`loaded, and not cited`** —
  the rules the script obeys. Loaded and left
  alone is a measurement; absent is not, and only the pass row can tell them apart.
  (Rule 2 begins *Sound does not carry outside the hull*; rule 3, *The harbour language is
  idiom, not physics.* Both are obeyed by that script on purpose — they are the controls.)
- **What could not be checked at all** should say *Nothing.* — every reviewer reached
  everything it was handed. That is the third kind of nothing, and it is kept out of both of
  the others.

The wall has not moved. Ten semantic findings would not move it either: **checks argue, they
never veto**, and only the deterministic tier is allowed to block anything at all.

### 4 · Door one — the gate, and the override ($0.00)

Press:

> Present the ep01 script v1 for your ruling — 2 deterministic findings stand on it, and
> approving over them is recorded as your override
> *No model call · $0.00*

The run parks. A **Gate** section appears with the script in it and **three** verbs, not two:

> Approve the ep01 script — round 1, and present-the-script-for-your-ruling carries the run on
>
> Approve the ep01 script OVER the vacuum-without-protection finding at scene 4 and 1 more
> deterministic finding — round 1, recorded as your override forever, and the next stage stops
> being refused on it
>
> Reject the ep01 script with notes — … presents it again with them recorded against it; there
> is no writer behind this gate to route them to yet, so the notes land and ride (D21)

**None of the three is disabled.** That is D12 said out loud: a deterministic finding blocks the
next stage and never your ruling.

Press the **OVER** button. Back on the check bench:

- **The next stage: Not blocked.**
- Both findings are **still open**, still exactly what the checks said. Nothing wrote an
  unblock, because there is nothing to write: "blocked" is a question asked again every time,
  and one of its conditions stopped being true.

### 5 · The rewrite, and what an override is *not* (~$0.04, then $0.00)

Find the **world-rules** card at scene 4. Press:

> Pre-draft a rewrite of the world-rules span in scene 4 of the ep01 script — one span,
> editable before anything is applied
> *1 Opus call, ~$0.04 · your money, spent when you click*

One span, one scene, one call — that is why this is four cents and not a dollar (D14). It comes
back into the box with a sentence saying what it changed, and **nothing has moved**.

**Now edit it.** Change a word, any word — put the collar on him in your own phrasing. Then
press **Apply the rewrite…** (`$0.00`). What lands is what is in the box, character for
character: your edit is a hand-made asset and it wins.

Four things happen in one motion, and the fourth is the one worth waiting for:

1. `script-v2.md` is on the volume, **beside** `script.md`. Nothing is ever written over.
2. The world-rules finding is gone from the cards. It argued with a draft that no longer
   exists, and nothing was written to it — its row is still what that check said at v1, forever.
3. The deterministic rules **re-ran for free before the motion returned**, so there is never a
   moment where v2 exists and nothing has read it.
4. **The next stage is blocked again.** Your override was your opinion of the draft in front of
   you at v1; the twins now stand at v2, and it does not reach them. An override that licensed
   every future draft would be a permanent pass on work you had not seen.

The deterministic rows on the verdict board now read **stale**, with what answers them:
*built from … a draft the script has moved past.* They are not green and they are not silent —
they are a reading of a grid that is now behind the script.

### 6 · The scene-scoped re-check, and the board back to fresh (~$0.13, then ~$0.12)

Under **Scenes still owed a reading**:

> Re-read scene 4 of the script with the 2 reviewers that argued with it — 2 reviewers · 2 Opus
> calls, ~$0.13
> *… your money, spent when you click*

Two of the ten, not ten of the ten. That narrowing is the whole of D14, and it is on the button
rather than in the code's opinion of itself.

Afterwards those reviewers' rows read **partial** — *read scene 4 of this draft and found
nothing there — the rest of this draft it has not read.* Not clean. A reviewer that read a
paragraph has not read the episode, and rendering it green would be the collapse invariant 4
forbids.

Then press **Read the ep01 script into a continuity board…** again (~$0.12). It re-extracts,
because the script has moved past the board it built, and the deterministic rows go from
**stale** back to a fresh reading of v2.

### 7 · Door two — dismiss with a note ($0.00)

Two deterministic findings still stand at v2. Take them down the other way. On each card, type
a note — *scene 6 is a flash-forward; leave it*, *he is suited in the pickup* — and press:

> Put the … finding down with your note — the note is read back by later runs (4.4) and counted
> against the check that raised it (D11)
> *No model call · $0.00*

Try it with the box empty first. The button is disabled, with the reason in words:

> Dismissing a finding takes a note. It is read back by later runs (4.4) and counted against the
> check that raised it (D11) — an empty one teaches nothing and still spends the check's
> credibility.

That is the same string the API refuses with. After the second note lands, **the next stage is
not blocked** — and again, nothing wrote an unblock: two disposition rows, and not one finding
row touched.

### 8 · The moment your own ruling does the work ($0.00)

Press the free one:

> Re-run the 4 deterministic rules over the ep01 continuity board — they read the rows an
> extraction already wrote, and read no script
> *No model call · $0.00*

The rules read the same unchanged rows and raise **identical twins** of both concerns. They are
**open**. They are counted. And:

**The next stage is still not blocked.**

Read the line on each card:

> **Your standing ruling reaches this one.** You put this exact concern down at v… — “scene 6 is
> a flash-forward; leave it”. This is a later firing of it, raised by a check re-reading rows
> nobody touched. It is open, and it counts in the cried-wolf record below; what it does not do
> is put the wall back up, because your ruling reaches it.

That is the whole of it. Every rewrite you apply anywhere in this episode re-runs this tier for
free — so without that line, a check you had already answered could put the wall back up
indefinitely, at no cost, for as long as you kept fixing other things. **A veto on a slow
clock is still a veto**, and the identity that prevents it is exact: same check, same span, same
scene, same canon, same words. A genuinely new contradiction raises the wall exactly as before.

### 9 · Read the reviewers, and check the projection against the ledger

At the bottom of the bench, **Cried-wolf record**. Every check that has read anything for this
show lately is on it, including the ones that never fired — `impossible-adjacency` with its
readings and its silences is as much a part of the record as the ones that complained.

The two you just dismissed now carry those dismissals. Neither has earned a maintenance
question yet: the floor is three ruled concerns, because two is a coincidence and one is an
anecdote. When one does, the line appears, ends in a question mark, and **nothing acts on it** —
no check is ever disabled, demoted or re-weighted by any number on this page.

Last, scroll up to the ep01 card and read **Spend on this episode**. Compare it with what the
buttons projected before you pressed them: about $1.60. It will be lower, and the difference is
the projections deliberately over-stating — a button that under-states is a button that lies
cheaply.

### What this drill deliberately does not do

Nothing ratified anything. The **Propose the canon change** button on each card raises a fact
delta onto the queue and stops; ruling it is yours, at the canon bench, through the same one
ruling API the gate uses. And the **gate room** — the screen you actually want, with the script
laid out, the findings folded to their anchors and the decision dock at the bottom — is E5's,
drawn in `mockups/gate-room.html`. None of it was built here. What was built is every record
that screen renders and every act it convenes.

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
