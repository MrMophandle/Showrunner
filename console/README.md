# The console

**The console is the showrunner's operating layer over the engine: it shows what every episode is
doing, it opens the gates for an answer, and it starts and restarts runs — and it does all of that
without owning a single one of them.** A run belongs to the detached worker process holding its
lock, so this server can be restarted, upgraded or killed while a four-hour render keeps writing.

The console names no show. It is pointed at a show repository with `--show <path>` and reads that
repository's `showrunner.json` for everything it needs to know about which show it is operating.

## The four surfaces

Four pages, each at one altitude. The client routes in the browser; the server serves the built
bundle and answers `/api/*` beneath it.

| Surface | Route | What it shows |
|---|---|---|
| The Board | `/` | One row per episode: the id, the title taken from the episode's outline heading, the stage chip with the reasons underneath it, the open gate's step id and attempt, the run's status, the time since the run's last event, and the row's one action. A New-episode form posts a new episode's `premise.md`. |
| The Run view | `/episodes/:id/runs/:run` | Three altitudes at once: the stage, the step in flight with its elapsed time and progress bar, and the time since the last event; then the step rail, every step of the pipeline in order with its status; then the event feed, the last 2,000 events. The action bar carries the recovery moves. |
| The Gate view | `/episodes/:id/runs/:run/gate` | The gate's rendered message as markdown, `attempt N of M`, the notes from previous rejections, the verdict board of what the reviewers found, one pane per artifact the gate is about, and the Approve and Reject buttons. |
| What happened | `/episodes/:id/runs/:run/what-happened` | Everything a troubleshooter would be handed — the pipeline, the run, the collapsed events, every prompt the run read with its hash then and now, and every file the run wrote — plus a question box that asks a read-only agent about that run. |

**What is deferred, and is deliberately absent.** One server answers for one show: a show registry
over `--show` is a later plan's. The console has no authentication, because it is a home-network
tool. It does not rotate its logs. The season map, the desk, discuss, notes and the standalone
step buttons of the rewrite design's §7.2 are not built. Nothing in the console edits a prompt or
a canon file.

## The three processes

| Process | Entry point | What it owns |
|---|---|---|
| The server | `console/dist/server/main.js` (`console/server/`) | The HTTP surface and one `RunStore` watching the show's run logs. It owns **no run**: it reads logs that workers append to, and it reads the lock beside each log to know whether a process is holding that run. |
| The worker | `console/dist/worker/main.js` (`console/worker/`) | **One run segment.** It takes the run's lock, calls the engine's `run()` exactly once, and releases the lock in a `finally`. It is spawned detached and into its own process group, so stopping the server never stops it. |
| The client | `console/dist/client/` (`console/src/`) | The browser bundle. It holds nothing the server did not hand it, and it re-reads what it is missing when the server's one SSE channel says a log has changed. |

The server and the worker are separate processes on purpose (the rewrite design §4.2). The worker
exits with 0 when its segment finished or parked at a gate, 1 when the run failed, 2 when the
segment crashed (a rejected `run()` or a lock another worker holds), 64 for a missing flag, and 143
after a `SIGTERM` or `SIGINT`, which first signals the live script process groups.

## Running it

    cd <engine repository> && npm run build
    node console/dist/server/main.js --show <show repository> --port 4400

| Flag | Default | What it does |
|---|---|---|
| `--show <path>` | **required** | The show repository the server reads and the only tree it writes into. Without it the server prints its usage line and exits 64. |
| `--port <n>` | `4400` | The port to listen on. A value that is not an integer in 1–65535 exits 64. |
| `--host` | absent | A presence, not a value. **Absent, the server binds `127.0.0.1` and is reachable only from the machine it runs on; given, it binds `0.0.0.0` and is on the network.** The console has no authentication of its own and it spawns processes, so `--host` is the operator saying "this is my home network" and must never be given on a network that is not. |
| `--operator <name>` | `console:<username>` | Who the server acts as. The string is stamped on every gate answer as `by`, on every reset, and as the `trigger` of every run it launches. |
| `--worker <path>` | the console's own compiled worker | The worker entry to spawn. A test points it at a fake worker; an operator has no reason to set it. |
| `--engine-root <path>` | the repository this server was built in | Where `scripts/` and `render/` live, which the pipeline's script steps need. |
| `--concurrency <n>` | `7` | How many ready agent steps each spawned worker may run at once, passed on as `--concurrency <n>`. Seven is the width of the script pass's review panel. Only agent steps are batched, so a larger number buys nothing elsewhere. |

In development, Vite serves the client on its own port and proxies `/api` to the server:

    cd console && SHOWRUNNER_SHOW_ROOT=<show repository> npm run dev

`npm run dev` starts `tsx watch server/main.ts --show $SHOWRUNNER_SHOW_ROOT` and `vite --port 5183`
together, and the browser goes to the Vite port. The variable has no default, because a default
would have to spell a show's directory name.

## What the console writes

**The console writes six things, all of them inside the show repository, and nothing else.** No
file is written anywhere under the engine repository, and no file is written outside the episode
the operator acted on.

| What | Where | Written by |
|---|---|---|
| The run log | `<productionDir>/<id>/runs/<runId>.jsonl` | **Only through the engine's verbs** — `answerGate`, `resumeRun`, `resetSteps` and `withdrawApproval` in the server, and `run()` in the worker. The server appends no event of its own invention, and the `RunStore` that reads every log writes nothing at all. |
| The lock | `<productionDir>/<id>/runs/<runId>.lock` | The worker, which creates it with `O_CREAT\|O_EXCL`, rewrites it every five seconds, and removes it in a `finally`. |
| The worker log | `<productionDir>/<id>/runs/<runId>.worker.log` | The worker, one line per segment outcome. |
| The worker's output | `<productionDir>/<id>/runs/<runId>.worker.out` | The spawned worker's stdout and stderr, appended by the kernel. The server opens the file; it writes nothing into it. |
| The troubleshooting log | `<productionDir>/<id>/runs/<runId>.troubleshooting.jsonl` | The server, one line per question asked on the What-happened page. |
| An episode's premise | `<episodesDir>/<id>/premise.md` | The server, once, when the New-episode form is submitted. It is written with `wx`, so a second submission for the same id is refused rather than overwriting an idea. |

**A read-only visit writes nothing.** Every one of the six is reached either from a `POST` route or
from a worker, and a worker starts only from a `POST` route. Opening the Board, a Run view, a Gate
view or an artifact issues `GET` requests that read the filesystem and never touch it — which is
what makes it safe to point the console at a finished season and look.

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

### Resume — `POST /api/episodes/:id/runs/:run/resume`

**Resume reopens a run that failed.** It calls the engine's `resumeRun` and appends one
`run_resumed` event carrying the operator's name. Refused with a 409 while a live worker holds the
run (`run <runId> is held by pid <pid>`), and refused by the engine for a run that is not failed
(`run <runId> is not failed, so there is nothing to resume`) — a completed run has nothing to
continue, and a running one is not finished. The next worker finds the failed step and everything
the failure swept back at pending and continues from there; every completed step keeps its status,
so no agent step is paid for twice. Resume is also what clears the `refs-ready` and
`showrunner-images` guards once the missing file is on disk.

### Continue — `POST /api/episodes/:id/runs/:run/continue`

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

### Re-run from here — `POST /api/episodes/:id/runs/:run/reset`

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

### Withdraw approval — `POST /api/episodes/:id/runs/:run/withdraw`

**Withdraw takes back an approval the showrunner already gave.** It calls the engine's
`withdrawApproval`, which appends a `run_resumed` when the run had finished, then one `step_reset`
per step downstream of the gate — recorded as `by: withdraw:<gateId>`, so the rail says which
withdrawal reset them — and finally a `gate_answered` with `approved: false` and the notes the
operator wrote.

Refused with a 409 while a live worker holds the run, while **any** gate is open (`answer it
instead`), and for a gate whose last answer is not an approval (`gate "<stepId>" is not approved on
run <runId>`). The next worker then takes the ordinary rejection path, which is the point of writing
the withdrawal as a rejection: the gate's fix agent runs, the gate's own re-run set and everything
downstream of it run again, and the gate reopens at the next attempt.

## The artifact route's fence

`GET /api/episodes/:id/files/<show-relative path>` serves the episode's own files — the outline a
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
still says that a different episode has started waiting. It takes three forms: `<show> console` when
nothing wants attention, `⏸ <id> NEEDS YOU — <show>` when an episode is parked at a gate, and
`● <id> <stage> · <N>m — <show>` when a run is working, where `N` is the whole minutes since that
run's last event. Before `GET /api/show` has answered there is no show name to use and the title is
the neutral `console`: this repository names no show, and a placeholder would be a name invented in
code.

A failed or crashed run reaches the Board in red but does **not** reach the tab title.

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
`console/test/fixtures/fake-worker.mjs` stands in for the real worker. Together they are how the
console is exercised end to end without a model, a render, or a real show.

**No show's name may appear anywhere under `console/`.** The rule and the grep that checks it are in
the repository root's `README.md`, under **Develop**; `console/` has no exemption from it.
