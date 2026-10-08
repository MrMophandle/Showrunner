# The console

**The console is the showrunner's operating layer over the engine: it shows what every episode is
doing, it opens the gates for an answer, it starts and restarts runs, and it starts a whole show and
interviews its bible — and it does all of that without owning a single run.** A run belongs to the
detached worker process holding its lock, so this server can be restarted, upgraded or killed while
a four-hour render keeps writing, or while a bible file's writer agent is twenty minutes into its
twenty-five.

The console names no show. It holds **every show a registry lists** — one `ShowContext` and one
`RunStore` each, built at startup — and reads each repository's `showrunner.json` for everything it
needs to know about the show it is operating. Which show a request means is a segment of its own
url: `/api/shows/<key>/…`. `--show <path>` still works and is one show keyed by its directory name.

## The surfaces

The shows list and the New-show form, then five pages of one show, each at one altitude — the four
the rewrite design's §7.2 names, plus the Bible view the setup needed. The client routes in the
browser; the server serves the built bundle and answers `/api/*` beneath it. **Every page of a show
lives under `/shows/<key>/`**, because one console holds every show on the machine and there is no
page that can be "the Board" without saying whose.

| Surface | Route | What it shows |
|---|---|---|
| The shows | `/` | One card per registered show: the key, the name, whether it is writable or read-only, its episodes and production directory names, and a link to its Board. A "new show" link points at `/shows/new`. |
| New show | `/shows/new` | The seven fields that make a show, and the one `POST /api/shows` that makes it. The slug, the NAS root and the registry key follow the name until one of them is edited; the grammar the server applies to the key is applied here too, so "that is not a key" is said while it is being typed rather than after the POST. On success it navigates to the new show's Bible view. Absent on a console started with `--show`, which holds one show and writes no registry. |
| The Bible view | `/shows/:show/bible`, `/shows/:show/bible/:key` | The show's fifteen bible files as a rail, one file's panel beside it, and the Finish panel once every gated file is approved. **This is the interview, in the browser:** each file's questions are a form whose answers land on disk the moment they are saved, each file's writing runs in a detached setup worker, and each gate takes the four answers the terminal offers — approve, reject with notes, "I will write this one myself", "import this file". Two routes and one component, so the rail stays mounted across a navigation between files. A read-only show renders every panel's content and none of its buttons. |
| The Board | `/shows/:show` | One row per episode: the id, the title taken from the episode's outline heading, the stage chip with the reasons underneath it, the open gate's step id and attempt, the run's status, the time since the run's last event, and the row's one action. A New-episode form posts a new episode's `premise.md`. A read-only show draws no launch, no continue and no form, and one line saying why. |
| The Run view | `/shows/:show/episodes/:id/runs/:run` | Three altitudes at once: the stage, the step in flight with its elapsed time and progress bar, and the time since the last event; then the step rail, every step of the pipeline in order with its status; then the event feed, the last 2,000 events. The action bar carries the recovery moves, and carries none on a read-only show. |
| The Gate view | `/shows/:show/episodes/:id/runs/:run/gate` | The gate's rendered message as markdown, `attempt N of M`, the notes from previous rejections, the verdict board of what the reviewers found, one pane per artifact the gate is about, and the Approve and Reject buttons — one line instead of the buttons on a read-only show. |
| What happened | `/shows/:show/episodes/:id/runs/:run/what-happened` | Everything a troubleshooter would be handed — the pipeline, the run, the collapsed events, every prompt the run read with its hash then and now, and every file the run wrote — plus a question box that asks a read-only agent about that run (absent on a read-only show: asking appends to the run's troubleshooting log, which is a write). |

**What is deferred, and is deliberately absent.** The console has no authentication, because it is a
home-network tool. It does not rotate its logs. The season map, the desk, discuss, notes and the standalone
step buttons of the rewrite design's §7.2 are not built. Nothing in the console edits a prompt or
a canon file.

## Shows and the registry

**One console holds every show on the machine, and `~/.showrunner/shows.json` is the list.**

    {
      "shows": {
        "the-live-show": { "root": "/Users/me/GitHub/TheLiveShow" },
        "the-old-one":   { "root": "/Users/me/GitHub/TheOldOne", "readOnly": true }
      }
    }

**The key is the operator's and not the show's**, for the reason the engine's `README.md` section
"Shows and the registry" states: two show repositories can carry the same `showName`, the same
`showSlug` and the same `output.nasRoot`, so no field of a `showrunner.json` can key a url. It must
match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`: no dot, so it can never be `..`; no slash, so it is one
url segment; no leading hyphen, so nothing downstream reads it as a flag. It is validated once, in
the show middleware, before it reaches a map or a path.

| What | How the server behaves |
|---|---|
| **Every api route** | Under `/api/shows/:show/`, with one exception: `GET /api/shows` is the list and `GET /api/events` is one channel across every show. One middleware turns the segment into that show's `ShowContext` and `RunStore`, so the fifty-odd functions beneath it still take one show and never ask which. |
| **An unknown key**, or a key the grammar rejects | `404 {"error": "no such show"}`, before any lookup or path join. |
| **`"readOnly": true`** | **Every `POST` beneath that show is `403 {"error": "<key> is read-only"}`** — the launch, the gate answer, the New-episode form, the whole bible route family, and any path under the show that no route registered. The refusal is in the middleware and not in the write routes, so it covers the whole subtree rather than the paths somebody remembered. Reading a read-only show is unrestricted. Why a read-only entry exists at all is the engine `README.md`'s "Shows and the registry" to argue; the short of it is that a retired repository and its successor share a NAS root and a final filename. |
| **The SSE channel** | One stream, and **every message names its show** — `{"type": "run", "show": "<key>", …}`, `{"type": "episodes", "show": "<key>"}`. Two shows holding an episode of the same id are otherwise the same notice twice, and a Board watching one would refetch on the other's every heartbeat. The `hello` carries the whole list: `{"type": "hello", "operator": …, "shows": [{"key", "showName", "readOnly"}]}`. |
| **A show whose repository will not load** | Reported on stderr by key at startup and left out — its routes then answer 404, like any key the console does not hold. One unfinished edit in one `showrunner.json` must not take every other show's Board off the air. |
| **A show whose episode files throw** | Its Board answers one row, `{"id": "", "error": "<key>: its episodes could not be read — …"}`, rather than a 500 that names no show. A malformed `images/prompts.json` or `Canon/refs.json` is a real failure of the show's own files; every other registered show is gathered under its own request and is untouched. |
| **A malformed registry file** | Fatal: the message on stderr and exit 65. A registry read as empty looks exactly like a machine with no shows on it, and the operator's remedy would then be to register every show again. |

**The registry file is the operator's, and the one write the console ever makes outside a show
repository.** `POST /api/shows` appends the new show's entry to it after `initScaffold` has written
and committed the show's own repository, and the two maps the server closes over gain the show
without a restart — which is the whole reason the registry is a file and not argv: a list that lived
in `process.argv` could not be appended to by the surface that creates a show. Nothing else in the
console writes it, nothing in it ever rewrites or removes an entry, and a console started with
`--show` refuses the route outright.

**The routes that are not about one episode.** Everything else is `/api/shows/:show/episodes/…`
and is documented under **Recovery** below.

| Route | What it does |
|---|---|
| `GET /api/shows` | The registered shows, each with its key, name, read-only flag and directory names. |
| `POST /api/shows` | Creates a show: `initScaffold` writes and commits the repository, the entry is appended to the registry, and the show is added to the live maps. Refuses a key the grammar rejects or already held, and a path inside the engine repository or inside or containing a registered show's root — in both directions, on resolved and symlink-resolved spellings alike. 409 on a console started with `--show`. |
| `GET /api/shows/:show/bible` | The fifteen rows: the file, its mode and purpose, its state, its latest run id and gate attempt, and how many of its questions are answered. |
| `GET /api/shows/:show/bible/:key` | One row with its questions and saved answers, its gate message and the file's text, and its latest run. |
| `GET /api/shows/:show/bible/:key/file` | The bible file itself. **The fence:** exactly the one path `BIBLE_FILES` names for that key under the show's canon directory, and nothing else — the key is not a path segment the caller supplies. |
| `POST /api/shows/:show/bible/:key/answers` | Writes `Production/setup/<key>/answers.md`, merged over what is on disk. Refuses a `default` or `scaffold` file, which asks nothing. |
| `POST /api/shows/:show/bible/:key/runs` | Mints a run id, creates its log, spawns the setup worker. Refused unless the file's latest run is finished. |
| `POST /api/shows/:show/bible/:key/runs/:run/gate` | One of the four answers, carrying `expectedAttempt`; the engine appends, then a worker is spawned — with the file written first for "I will write it myself" and for an import. |
| `POST /api/shows/:show/bible/finish` | The end of a setup: the gated files still unapproved, `bible-check`'s report, and the GitHub repository. |

## The archive marker — an episode the engine never ran

**`<episodesDir>/<id>/archive.json` is how an episode finished before this engine existed is shown
as finished: `{"stage": "COMPLETE", "note": "one line about where it is"}`.** `stage` must be a
`Stage` string the engine's `isStage` accepts (`"complete"` is not one) and `note` is optional.
The row then reads at the marker's stage, in that stage's ordinary colour, with an "archived"
status chip carrying the note, no reasons beside it — an archived episode needs nothing, whatever
is or is not on disk — and **no launch button**: what a run over a finished episode should do is
Plan F's question, so the row says "archived; launch is not offered" instead of offering it. **The
marker is read only for an episode with no run logs at all** (`idleEpisodeRow`, `server/episodes.ts`,
which `RunStore.episodeRow` calls only when the episode has no runs), because a run once launched
is the truth and a hand-written file must never be able to hide a gate that is open, a run that
failed or a worker that is alive. A marker that cannot be read — bad JSON, a `stage` that is not a
stage — leaves the derived stage and status exactly as they were and says so on the row as
`archive.json: <reason>`, rather than disappearing and letting a finished season quietly read
NEEDS_IDEA again. The showrunner's first season carries ten of these markers, written by a pull
request on the show repository; Plan F carries those ten files through the Season 1 rename and
decides what the test-bed episodes should show.

## The three processes

| Process | Entry point | What it owns |
|---|---|---|
| The server | `console/dist/server/main.js` (`console/server/`) | The HTTP surface and one `RunStore` watching the show's run logs. It owns **no run**: it reads logs that workers append to, and it reads the lock beside each log to know whether a process is holding that run. |
| The worker | `console/dist/worker/main.js` (`console/worker/`) | **One run segment.** It takes the run's lock, calls the engine's `run()` exactly once, and releases the lock in a `finally`. It is spawned detached and into its own process group, so stopping the server never stops it. |
| The client | `console/dist/client/` (`console/src/`) | The browser bundle. It holds nothing the server did not hand it, and it re-reads what it is missing when the server's one SSE channel says a log has changed. |

The server and the worker are separate processes on purpose (the rewrite design §4.2). The worker
exits with 0 when its segment finished or parked at a gate, 1 when the run failed, 2 when the
segment crashed (a rejected `run()` or a lock another worker holds), 64 for a missing or malformed
flag, and 143 after a `SIGTERM` or `SIGINT`.

**Two different signals are sent in two different places, and they are not the same move.** A
signalled worker shuts down by sending **`SIGKILL`** to the script process groups it is supervising
(`killLiveProcessGroups`): it is on its way out and cannot wait for a renderer to finish. Continue,
on the operator's explicit request, sends **`SIGTERM`** to the groups a dead worker's lock recorded
(`killRecordedGroups`): nothing is supervising those any more, and a replay must not start while
they are still writing.

## Running it

    cd <engine repository> && npm run build
    node console/dist/server/main.js --port 4410                      # every show in ~/.showrunner/shows.json
    node console/dist/server/main.js --show <show repository>          # one show, keyed by its directory name

**The default port is 4410 and the Vite dev server's is 5193, which are deliberately not console
v1's 4400 and 5183.** The two consoles' defaults differ so that both run side by side through the
transition (the showrunner's ruling of 2026-10-02): v1 still serves the Season 1 archive in the
show repository while this console is brought up on the same machine. Plan F retires v1 and frees
4400.

| Flag | Default | What it does |
|---|---|---|
| `--registry <file>` | `~/.showrunner/shows.json` | The registry of shows to hold. A file that does not exist is an empty registry and the server still starts, saying so — the state a machine is in before its first show is registered. A file that exists and is malformed exits **65** with the reason, rather than being read as empty. |
| `--show <path>` | absent | One show repository, keyed by its own directory name, registering nothing and writing nothing. **`--show` and `--registry` together exit 64**: they are two answers to one question, and silently preferring one would be a console holding shows the operator did not ask for. A directory name that is not a show key exits 64 naming it. |
| `--port <n>` | `4410` | The port to listen on (`DEFAULT_PORT`, `server/main.ts`). A value that is not an integer in 1–65535 exits 64. |
| `--host` | absent | A presence, not a value. **Absent, the server binds `127.0.0.1` and is reachable only from the machine it runs on; given, it binds `0.0.0.0` and is on the network.** The console has no authentication of its own and it spawns processes, so `--host` is the operator saying "this is my home network" and must never be given on a network that is not. |
| `--operator <name>` | `console:<username>` | Who the server acts as. The string is stamped on every gate answer as `by`, on every reset, and as the `trigger` of every run it launches. |
| `--worker <path>` | the console's own compiled worker | The **episode** worker entry to spawn. A test points it at a fake worker; an operator has no reason to set it. |
| `--setup-worker <path>` | the console's own compiled setup worker | The **bible interview's** worker entry to spawn (`console/dist/worker/setup.js`), which writes one bible file and opens its gate. A separate flag from `--worker` because the two entries take different argv (`--episode`/`--run` against `--key`/`--run`); pointing it at a fake worker is how the Bible page is driven end to end with no writer model behind it, which costs $2.24 a file. An operator has no reason to set it. |
| `--engine-root <path>` | the repository this server was built in | Where `scripts/` and `render/` live, which the pipeline's script steps need. |
| `--concurrency <n>` | `7` | How many ready agent steps each spawned worker may run at once, passed on as `--concurrency <n>`. Seven is the width of the script pass's review panel. Only agent steps are batched, so a larger number buys nothing elsewhere. |

In development, Vite serves the client on its own port and proxies `/api` to the server:

    cd console && SHOWRUNNER_SHOW_ROOT=<show repository> npm run dev

`npm run dev` starts `tsx watch server/main.ts --show $SHOWRUNNER_SHOW_ROOT` and `vite --port 5193`
together, and the browser goes to the Vite port. The variable has no default, because a default
would have to spell a show's directory name.

**`npm run dev` needs `npm run build -w console` to have been run once**, or `--worker <path>`.
The server spawns the **compiled** worker (`console/dist/worker/main.js`), which the watched
TypeScript server does not produce: under `tsx` the default entry resolves to
`console/worker/main.js`, where only `worker/main.ts` exists. The server refuses to start rather
than spawning it — `the worker is not built: run npm run build -w console, or pass --worker
<path>` — because the failure is otherwise invisible: the spawned process exits at once with
`ERR_MODULE_NOT_FOUND`, the launch route answers 200 with its pid, and the Run page shows a run
that never started.

## What the console writes

**The console writes ten things, and nothing else** (eleven paths, counting the lock's temporary
file, which exists only between a beat's write and its rename). Nine of the ten are inside a show
repository; the tenth is the registry file, which is the one write anywhere else. No file is written
under the engine repository.

The first four rows are written for a bible file's run as well as for an episode's, under
`<productionDir>/setup/<key>/runs/` instead of `<productionDir>/<id>/runs/` — one segment deeper,
because `setup` is a reserved episode id that never matches the episode-id grammar, so a bible run's
log can never be mistaken for an episode's.

**Only one of the nine is written by the server for a run, and it is zero bytes long.** Everything
that follows a launch or a gate answer is written by a detached worker, which is the rule that the
server owns no run (the rewrite design's §4.2) in its most literal form: **the setup worker and not
the server makes the approval commit for a bible file**, so no git process runs in this server for a
run at all. The server's own writes are the premise, the answers file, the registry entry, a new
show's scaffold and its commits, and the empty run log.

| What | Where | Written by |
|---|---|---|
| The run log | `<productionDir>/<id>/runs/<runId>.jsonl` | **Every event, only through the engine's verbs** — `answerGate`, `resumeRun`, `resetSteps` and `withdrawApproval` in the server, and `run()` in the worker. The server appends no event of its own invention, and the `RunStore` that reads every log writes nothing at all. The one write that is not an append is the launch route **creating** the file, empty, with `wx`, before it spawns: that is what makes the minted run the episode's latest run from the moment the route answers, so a second launch in the worker's startup second is refused instead of starting a second worker on one episode. `run()` appends `run_started` when its one read of the log yields no events, which a zero-byte file does. |
| The lock | `<productionDir>/<id>/runs/<runId>.lock` | The worker, which creates it with `O_CREAT\|O_EXCL` and removes it in a `finally`. Each five-second beat is written to `<runId>.lock.tmp` and **renamed over** the lock, so a reader never sees the empty file a truncating rewrite leaves behind for a microsecond — which `readLock` would parse as "no lock", and which is the one path in the protocol where two workers could hold one run. |
| The worker log | `<productionDir>/<id>/runs/<runId>.worker.log` | The worker, one line per segment outcome. The Run view shows its last lines for a run whose status is `crashed`, and links the whole file: for a `run()` that rejected it is the only account there is, since the `finally` took the lock and the run log has no entry for the failure. |
| The worker's output | `<productionDir>/<id>/runs/<runId>.worker.out` | The spawned worker's stdout and stderr, appended by the kernel. The server opens the file; it writes nothing into it. |
| The troubleshooting log | `<productionDir>/<id>/runs/<runId>.troubleshooting.jsonl` | The server, one line per question asked on the What-happened page. |
| An episode's premise | `<episodesDir>/<id>/premise.md` | The server, once, when the New-episode form is submitted. It is written with `wx`, so a second submission for the same id is refused rather than overwriting an idea. |
| A bible file's answers | `<productionDir>/setup/<key>/answers.md` | The server, when the Bible view's question form is saved. The whole file is rewritten — every heading the canon template declares, with `(blank)` under the unanswered ones, because that is the shape the writer agent and `bible-check` both read — so the posted record is **merged over what is on disk**: a heading the request carries wins even when it is empty, and a heading it does not carry keeps the answer it had. A straight write-through would have meant a form posting one field erasing the other eight answers. |
| A bible file, and its commit | `<canonDir>/<BIBLE_FILES[key].file>` | The **setup worker**, never the server. The writer agent writes the file inside the worker's run; for "I will write this one myself" and for an import the server writes it before spawning the worker that records the answer. The commit that carries the file, its answers and its run log is the worker's too, taken when its run ends `completed` and after its lock is released — the log directory it stages holds the lock, and a lock is a process fact that belongs in no history. A commit that cannot be made leaves the file approved, logs the reason to `<runId>.worker.log` and exits 2; `showrunner-init --resume` makes the catch-up commit. |
| A new show's whole repository | the path the New-show form named | The server, through `initScaffold`: the house layout, `showrunner.json`, the prompt set, the entity and outline templates, the two reference indices, the two scaffold bible files, the derived `.gitignore`, the show's README — and `git init` plus the scaffold commit. Every file is written with `wx`, so nothing it touches can overwrite an author's. |
| The registry entry | `~/.showrunner/shows.json` (or `--registry`) | The server, once per show created, appending the key and its root. The one write outside a show repository. No entry is ever rewritten or removed. |

**A read-only visit writes nothing.** Every one of the ten is reached either from a `POST` route or
from a worker, and a worker starts only from a `POST` route. Opening the Board, a Run view, a Gate
view, the Bible view or an artifact issues `GET` requests that read the filesystem and never touch
it — which is what makes it safe to point the console at a finished season and look.

The console does not create `<productionDir>/<id>/` when an episode is created: that directory is a
run's to make, and an empty one would put a row on the Board for an episode with no idea in it.

## The files beside a run log

Four files sit next to `<runId>.jsonl`, each answering a question the log itself cannot.

| File | What it answers |
|---|---|
| `<runId>.lock` | **Is a process running this run right now?** It holds the worker's pid, the time it started, the time of its last beat, and the process-group ids of its live script children. The log cannot state this, because a log is a record of what happened and not of who is at the keyboard. A worker beats it every five seconds; a lock whose pid is dead is a crashed worker's, and the next worker removes and retakes it. |
| `<runId>.worker.log` | **Why did the segment end?** One line per `runOnce`: `waiting at <gate> (attempt N)`, `failed at <step>: <error>`, `completed`, or the stack of a `run()` that rejected. The rejected-`run()` case is the one the run log has no entry for at all. |
| `<runId>.worker.out` | **What did the worker process print?** The spawned process's stdout and stderr, appended across every worker the run has had, so a run resumed three times keeps all three workers' output in one file in order. It is the only record of a worker that died before it could write its own log line. |
| `<runId>.troubleshooting.jsonl` | **What has been asked about this run, and what was answered?** One JSON line per question, with the operator, the answer as the operator read it, and the SDK's cost estimate. It is a separate file rather than part of the run log for three reasons: the run log is a typed `Event` stream and the sole input to `deriveRunState`; the engine reads that same log back for cache decisions; and the store announces every appended log line to every connected client, which a long answer would turn into a flood of notices about a run that did not change. |

## Recovery

Four moves, and the Run view's action bar offers whichever ones the run's state allows. Each one
obeys the same order — **read the lock, append through an engine verb, then spawn a worker** — and
a refusal at any of the three is a 409 carrying the engine's own message, verbatim, because that
message is what the operator reads.

The order matters in both directions. The lock is read first because a worker reads its log exactly
once, at the start of its run, so a line appended while that worker is working is a line its
in-memory copy does not have. The spawn is last because a worker started before the append would
read an unchanged log, park at the same gate, release its lock and exit — and the operator's answer
would then land in a log with no process behind it.

### Resume — `POST /api/shows/:show/episodes/:id/runs/:run/resume`

**Resume reopens a run that failed.** It calls the engine's `resumeRun` and appends one
`run_resumed` event carrying the operator's name. Refused with a 409 while a live worker holds the
run (`run <runId> is held by pid <pid>`), and refused by the engine for a run that is not failed
(`run <runId> is not failed, so there is nothing to resume`) — a completed run has nothing to
continue, and a running one is not finished. The next worker finds the failed step and everything
the failure swept back at pending and continues from there; every completed step keeps its status,
so no agent step is paid for twice. Resume is also what clears the `refs-ready` and
`showrunner-images` guards once the missing file is on disk.

### Continue — `POST /api/shows/:show/episodes/:id/runs/:run/continue`

**Continue puts a worker back on a run that crashed, and is the one action with nothing to append.**
A crash is a log with no terminal event and no live worker, which happens in exactly two ways: a
worker that was killed, leaving its lock behind with a dead pid, or a `run()` that rejected, taking
the lock with it in its `finally`. Either way the engine's replay is the whole remedy — any step
whose status is not terminal is re-executed, and the re-execution is logged as a new `step_started`
following the orphaned one — so there is nothing for the console to decide and nothing to write.

Before the spawn, the stale lock's **recorded process groups are sent `SIGTERM`**: the script
children of a killed worker are in their own groups and outlive it, and a replay beginning while a
dead run's renderer is still writing would put two processes on one file. Only groups a lock
recorded are signalled, and only at this explicit request.

Continue is refused with a 409 for a run with no log at all (`has no log; launch a run instead`),
for a finished run (`resume it or launch a new run`), for a run parked at a gate (`answer the gate
instead`), and while a live worker holds it. It is keyed on the log and the lock rather than on the
status string, so it offers the same move whatever the Board happens to call the run.

### Re-run from here — `POST /api/shows/:show/episodes/:id/runs/:run/reset`

**Re-run from here returns the named steps and everything downstream of them to pending.** It calls
the engine's `resetSteps`, which appends a `run_resumed` first when the run had finished, then one
`step_reset` per affected step carrying the operator's name. The response lists the step ids that
will run again, which is what the operator is really deciding about.

Refused with a 409 while a live worker holds the run, and refused **while any gate is open** —
`gate "<stepId>" is open; answer it or withdraw, not reset` — because the two moves mean different
things and the wrong one is expensive: resetting around an open gate would rebuild the work the
showrunner is in the middle of judging. Gates are never reset; withdrawing is how an approval is
taken back. The next worker re-executes the reset steps in dependency order, and a script step
whose declared inputs and outputs are unchanged on disk is still served from cache.

### Withdraw approval — `POST /api/shows/:show/episodes/:id/runs/:run/withdraw`

**Withdraw takes back an approval the showrunner already gave.** It calls the engine's
`withdrawApproval`, which appends a `run_resumed` when the run had finished, then one `step_reset`
per step downstream of the gate — recorded as `by: withdraw:<gateId>`, so the rail says which
withdrawal reset them — and finally a `gate_answered` with `approved: false` and the notes the
operator wrote.

Refused with a 409 while a live worker holds the run, while **any** gate is open (`gate "<stepId>"
is open; answer it instead`), and for a gate whose last answer is not an approval (`gate "<stepId>"
is not approved on run <runId>`). The next worker then takes the ordinary rejection path, which is
the point of writing the withdrawal as a rejection: the gate's fix agent runs, the gate's own re-run
set and everything downstream of it run again, and the gate reopens at the next attempt.

**A gate downstream of the withdrawn one keeps its approval, and the response names which.** The
engine never resets a gate — a later gate's approval is its own answer (ruling F-26) — so
withdrawing `outline-gate` on a run whose `script-gate` was also approved regenerates the script
and then walks straight past the approval the showrunner gave the old one. The response carries
`survivingGates` beside `reset` for exactly that reason, and the Run page names them in the
confirmation and in the notice. The step rail offers "withdraw approval" **only on the latest
approved gate**, which is the one case that spends no approval the operator cannot see; withdrawing
an earlier gate is still available through the route, deliberately.

## The artifact route's fence

`GET /api/shows/:show/episodes/:id/files/<show-relative path>` serves the episode's own files — the outline a
gate is asking about, the mix, the shot images, the render, the canon patch — and **nothing else on
the machine the console is running on.** The route answers a file with HTTP Range, which is what
lets a browser seek to minute nine of a several-hundred-megabyte render instead of downloading all
of it, and answers a directory with a one-level JSON listing, because three of the eight gates are
about a directory rather than a file.

Three layers refuse a path, and each catches requests the other two let through.

1. **The prefix rule** — the path must begin with `<episodesDir>/<id>/` or `<productionDir>/<id>/`.
   This is not about escape: a shared canon file and another episode's script are both real files
   inside the show root with no `..` in them, and only this rule says they are not this episode's
   business.
2. **The segment rule** — no empty segment, no `..`, no dotfile, no control character. A request
   whose separators are percent-encoded arrives decoded as a traversal with this episode's prefix
   intact, resolving to a path inside the show root; it passes layers 1 and 3, and only this rule
   sees it.
3. **The resolved-path check** — after `path.resolve`, the path must still be inside the show root.
   This layer does not depend on the string rules above being complete: a show whose `episodesDir`
   is configured as `../shared/Episodes` satisfies the prefix rule by construction and lands
   outside the root.

The run log is served from **outside** the fence, by a route of its own, so that its address is
built by the same `EventLog.logPath` call the store and the worker use and its run id is validated
by the engine. The troubleshooting agent on the What-happened page is fenced differently and more
simply: it is given `Read`, `Glob` and `Grep` and no other tool, so an account of a failure can
never become an edit to the show it is accounting for.

## Alerting: the browser tab

**The tab's own title is the whole alerting story, and that is a ruling rather than an omission.**
The console is served over plain HTTP on a home network, which is not a secure context, so a
browser will not grant web notifications to it — and the console is silent by ruling, so it plays
no sound. What is left is the string in the tab, which an operator can see across a room with the
window behind something else.

The title is set once at the top of the app rather than per page, so a Run view open on one episode
still says that a different episode has started waiting. It takes four forms, read in the order of
what the person at the tab can do about them:

| Form | When |
|---|---|
| `⏸ <id> NEEDS YOU — <show> · <key>` | An episode is parked at a gate. This wins everything: it is the only form that is a question addressed to the reader. |
| `⚠ <id> FAILED — <show> · <key>` / `⚠ <id> CRASHED — <show> · <key>` | A run has stopped and will not restart itself. Second, because it is a job waiting on the operator rather than a question. |
| `● <id> <stage> · <N>m — <show> · <key>` | A run is working, where `N` is the whole minutes since that run's last event. |
| `<show> · <key> console` | Nothing wants attention. |
| `console` | The page is not inside a show — the shows list, or the New-show page. |

Each form names the first row in Board order that matches, so two waiting episodes name the earlier
one and the title does not flicker between them. **The key is in every form beside the name** because
two registered shows can declare the same `showName` — the two this console was measured against do —
and a tab asking for the showrunner without saying which show was asking would be the alerting story
failing at the one moment it matters. Before `GET /api/shows/:show` has answered there is no show name
to use and the title is the neutral `console`: this repository names no show, and a placeholder would
be a name invented in code.

## Develop

    npm install                 # at the repository root; the console is one of its workspaces
    npm run build -w console    # tsc for the server and the worker, then vite build for the client
    npm test -w console         # the vitest suite
    npm run typecheck -w console

`npm run build` writes `console/dist/server/`, `console/dist/worker/` and `console/dist/client/`.
The server mounts `dist/client/` as static files when that directory exists and falls through to its
`index.html` for any path that is not under `/api/`, so the client can route in the browser; in
development that directory does not exist and Vite serves the client instead.

`console/test/fixtures/seed-show.mjs` writes a complete invented show — episodes parked at a gate,
failed, crashed mid-loop, and with no premise at all — into a temporary directory, and
`console/test/fixtures/fake-worker.mjs` and `fake-setup-worker.mjs` stand in for the episode worker
and the setup worker. Together they are how the console is exercised end to end without a model, a
render, or a real show — which for the bible interview is the difference between a test suite and
$2.24 a file.

**No show's name may appear anywhere under `console/`.** The rule and the grep that checks it are in
the repository root's `README.md`, under **Develop**; `console/` has no exemption from it.
