# Plan H (the console side of the new-show setup) — inventory

**Status: this document is an inventory, not a plan.** It was taken on 2026-10-07 against three
repositories: the engine at `~/GitHub/Showrunner` on branch `plan-h` (cut from `main` at `12e2eaa`,
Plans A–G merged); the live show instance at `~/GitHub/DeadLight2` (`main` at `c4c645f`), read and
never written; and the retired first repository at `~/GitHub/DeadLight` (GitHub
`MrMophandle/DeadLight-v1`), read and never written. Console v1 kept running from the retired
repository on port 4400 (pid 3353) throughout and was not touched. Every measurement that needed a
live server used a second console on port 4413, stopped by pid when the measurements were done. No
tracked file changed in either show repository: the retired repository's `git status` shows the same
two untracked `Production/ep10/*.json` backups before and after, and the instance's is empty. The
only file this inventory writes is itself.

**What Plan H is, as the records assign it.** Four things, with their addresses: a **show registry**
so one console server holds many shows instead of one `--show` root
(`docs/plans/2026-10-03-the-new-show-setup-deferred.md:20`, Ryan's ruling of 2026-10-03, which cites
Plan E's O-05; Plan E's own record had assigned the registry to Plan G
at `docs/plans/2026-10-02-the-console-deferred.md:25`, and Plan G reassigned it to Plan H); a
**"New show" surface** in the console over Plan G's `showrunner-init` (spec §9.4 at
`docs/specs/2026-09-25-console-rewrite-design.md:232`; the record at
`docs/plans/2026-10-03-the-new-show-setup-deferred.md:21`); **the interview's runs made visible**
(`docs/plans/2026-10-03-the-new-show-setup-deferred.md:22`); and **two deferrals from Plan F** — the
run view for an archived episode derives `NEEDS_IDEA`
(`docs/plans/2026-10-04-the-cutover-deferred.md:45`) and `refs-ready` passes vacuously on an outline
with no `## Cast` section (`docs/plans/2026-10-04-the-cutover-deferred.md:44`).

**What Plan H does not take**, per spec §7.2 (`docs/specs/2026-09-25-console-rewrite-design.md:199`)
and Plan E's "Not built" (`docs/plans/2026-10-02-the-console-deferred.md:52`): the season map, the
desk state, discuss, notes, and the standalone shot re-roll, ambient pass and casting-pile buttons.

The headline counts, measured and not estimated:

| What | Count | Where measured |
|---|---|---|
| Lines in `console/` (non-test) that read the server's one `ShowContext` | **72** — 50 in the server and worker, 22 in the client | §1.8 |
| Files holding those lines | **14**, counting `console/server/show.ts` (89 lines, the declaration itself) | §1.8 |
| HTTP routes the console registers | **20** — 18 API routes in `console/server/app.ts`, 2 static fallbacks in `console/server/main.ts` | §1.5 |
| Of the 18 API routes: carry an episode id / carry a show id | **14 carry `:id` · 0 carry a show id** | §1.5 |
| Questions in one full bible interview | **52**, across the 10 interview-mode files of 13 gated files | §3.3 |
| Findings below | **21** (H-01 … H-21) | §7 |

---

## 1 · The console's single-show assumptions, every site

**Conclusion: the console holds exactly one `ShowContext`, built once at startup, and 72 lines in 14
files read it. No route, no SSE message and no client URL carries a show key.** The one place the
show reaches a second process is the worker's argv, which already carries the show root as a value —
so the worker needs no change to serve a second show.

### 1.1 `ShowContext` and `loadShowContext` — `console/server/show.ts`

`ShowContext` is declared at `console/server/show.ts:17-39` with **eight fields**: `showRoot`
(absolute path of the show repository, `:19`), `show` (the `ShowConfig`, `:20`), `engineRoot`
(`:21`), `operator` (`:25`, `"console:<user>"`), `productionDir` (`:27`, already defaulted),
`episodesDir` (`:29`, already defaulted), `workerCommand` (`:32`, `[executable, entry]`) and
`concurrency` (`:38`, default 7).

The module's own doc comment at `console/server/show.ts:7-11` states the assumption as a decision,
not an accident: *"The server holds one of these and never a second, because a console that could be
pointed at two shows at once would have to say which one every route meant, and no route does."*

`loadShowContext(opts)` at `console/server/show.ts:71-89` resolves, once: `showRoot` through
`path.resolve` (`:72`), the config through `loadShowConfig(showRoot)` (`:73`), the worker command
with `defaultWorkerEntry()` as its default (`:74`, resolved from `import.meta.url` at `:56-58`), the
worker entry's existence (`:76-78` — the only startup refusal), `engineRoot` through `path.resolve`
(`:82`), `operator` (`:83`), and the two directory defaults (`:84-85`).

### 1.2 The flags and what is built once — `console/server/main.ts`

`main()` at `console/server/main.ts:45-107` reads **seven flags**: `--show` (`:46`, the only required
one — missing is exit 64 at `:47`), `--engine-root` (`:51`, defaulting to three levels above
`dist/server/`), `--port` (`:52`, `DEFAULT_PORT = 4410` at `:41`), `--host` (`:89`, a presence flag),
`--operator` (`:55`), `--worker` (`:56`) and `--concurrency` (`:59`).

**`flag()` at `console/server/main.ts:22-27` uses `process.argv.indexOf`, so a repeated flag takes
its first occurrence and the rest are ignored silently.** Measured against the same function's logic
with `["--show","/a","--show","/b"]`: the result is `/a`. Option (a) of §2 therefore cannot be added
by passing `--show` twice without rewriting `flag`.

Three singletons are built at startup, in this order: the context (`console/server/main.ts:63`), one
`RunStore` over it (`:68`), one Hono app over both (`:69`). The built client is mounted at `:73-83`
when `dist/client` exists. `store.watch()` runs before `serve()` (`:86`, `:90`) so the first request
already has the show's logs tailed. The startup line at `:91` prints `ctx.show.showName` — the one
show-identity string the operator sees.

### 1.3 `RunStore` — one per server, one watcher per episode — `console/server/runs.ts`

`RunStore` is declared at `console/server/runs.ts:313-616`. **One store per server, not one per
show**, instantiated at `console/server/main.ts:68`. Its private state at `:314-324`:

| Member | Shape | Keyed by |
|---|---|---|
| `#ctx` (`:314`) | one `ShowContext` | — |
| `#logs` (`:316`) | `Map<string, CachedLog>` — events, byte offset, `lastError` (`:39`) | `"<episodeId>/<runId>"` (`#key`, `:407-411`) |
| `#tails` (`:320`) | `Map<string, Promise<void>>`, one chain per log | the same key |
| `#watchers` (`:320`) | `Map<string, FSWatcher>` | **episode id alone** (`#watchEpisode`, `:542-554`) |
| `#subscribers` (`:321`) | `Set<(m: SseMessage) => void>` | — |
| `#episodeIds` (`:322`) | `string[]` | — |

`listEpisodeIds(this.#ctx.showRoot, this.#ctx.show)` is called at **three sites**:
`console/server/runs.ts:348` (in `watch()`, once at startup), `console/server/runs.ts:610` (in
`#rescan()`, every `pollMs`), and `console/server/app.ts:149` (the Board route, on every request).

The tail cache never evicts: `#tailOnce` at `console/server/runs.ts:491-525` writes into `#logs` and
nothing removes an entry except `close()` at `:400-405`. Plan E's record already carries this as
deferred (`docs/plans/2026-10-02-the-console-deferred.md:41`, F-21 ruled no cap). **A registry
multiplies it by the number of shows registered.**

`#watchEpisode` at `console/server/runs.ts:542-554` attaches one `fs.watch` to
`path.join(this.#ctx.showRoot, this.#ctx.productionDir, episodeId, "runs")` (`:544`) — a path built
from the one context. A registry needs one watcher per *(show, episode)* pair, and `#watchers`'
key must grow a show segment, or two shows with an `s02e01` each would share one watcher entry.

### 1.4 The SSE bus

One channel, one subscriber set. `subscribe` at `console/server/runs.ts:358-361`, `#publish` at
`:417-422`, the route at `console/server/app.ts:204-238`. The vocabulary is
`console/shared/types.ts:163-166`:

```
export type SseMessage =
  | { type: "run"; episodeId: string; runId: string; offset: number }
  | { type: "episodes" }
  | { type: "hello"; operator: string; showName: string };
```

**`hello` carries `showName`, which is the only show-identity field on the wire, and it is sent once
per connection rather than per message** (`console/server/app.ts:205-206`). The client parses the
three variants at `console/src/api.ts:233-258` and validates each field by type; a fourth field on
`run` would need an edit on both sides.

### 1.5 Every route the console registers

Eighteen in `console/server/app.ts`, two in `console/server/main.ts`. **None carries a show id.**

| # | Method and path | Line | Episode id? |
|---|---|---|---|
| 1 | `GET /api/show` | `console/server/app.ts:137` | no |
| 2 | `GET /api/episodes` | `console/server/app.ts:148` | no |
| 3 | `GET /api/episodes/:id` | `console/server/app.ts:154` | yes |
| 4 | `GET /api/episodes/:id/runs/:run` | `console/server/app.ts:164` | yes |
| 5 | `GET /api/episodes/:id/runs/:run/events` | `console/server/app.ts:179` | yes |
| 6 | `GET /api/events` (SSE) | `console/server/app.ts:204` | no |
| 7 | `POST /api/episodes` | `console/server/app.ts:269` | no (the id is in the body) |
| 8 | `POST /api/episodes/:id/runs` (launch) | `console/server/app.ts:319` | yes |
| 9 | `POST /api/episodes/:id/runs/:run/gate` | `console/server/app.ts:367` | yes |
| 10 | `POST /api/episodes/:id/runs/:run/resume` | `console/server/app.ts:396` | yes |
| 11 | `POST /api/episodes/:id/runs/:run/continue` | `console/server/app.ts:423` | yes |
| 12 | `POST /api/episodes/:id/runs/:run/reset` | `console/server/app.ts:445` | yes |
| 13 | `POST /api/episodes/:id/runs/:run/withdraw` | `console/server/app.ts:482` | yes |
| 14 | `GET /api/episodes/:id/runs/:run/gate` | `console/server/app.ts:511` | yes |
| 15 | `GET /api/episodes/:id/files/:path{.+}` | `console/server/app.ts:522` | yes |
| 16 | `GET /api/episodes/:id/runs/:run/log` | `console/server/app.ts:530` | yes |
| 17 | `GET /api/episodes/:id/runs/:run/context` | `console/server/app.ts:537` | yes |
| 18 | `POST /api/episodes/:id/runs/:run/ask` | `console/server/app.ts:547` | yes |
| 19 | `app.use("/*", serveStatic)` | `console/server/main.ts:75` | no |
| 20 | `app.get("/*")` → the client's index | `console/server/main.ts:79` | no |

**14 of the 18 API routes carry `:id`; four do not; zero carry a show id.** Every `:id` goes through
`checkEpisodeId` at `console/server/app.ts:44-46`, which is `parseEpisodeId` in a `try`.

### 1.6 How the show root reaches the worker — confirmed

`spawnWorker` at `console/server/workers.ts:74-98` builds the argv at **`console/server/workers.ts:88`**:

```
const argv = [...entry, "--show", ctx.showRoot, "--episode", episodeId, "--run", runId, "--engine-root", ctx.engineRoot, "--operator", ctx.operator, "--concurrency", String(ctx.concurrency)];
```

**The worker already takes the show root as an argv value, so a registry tells the worker which show
by passing a different `--show` — no worker change is needed for the registry itself.** The worker
reads exactly those six flags at `console/worker/main.ts:148-163`, declares them as `WorkerOptions`
at `console/worker/main.ts:15`, and loads the config itself at `console/worker/main.ts:72`. It is
spawned `detached: true` into its own process group at `console/server/workers.ts:89`.

### 1.7 The client

**No base URL exists.** `console/src/api.ts` fetches relative paths at `:72` (`getJson`), `:81`
(`getText`), `:91` (`post`) and `:106` (`postStream`); the SSE path is the constant `"/api/events"`
at `console/src/api.ts:207`. The module's comment at `console/src/api.ts:8-10` states the
assumption: *"The server is the only origin this client talks to. There is no second base url…"*

`App.tsx` declares **five `<Route>` elements** at `console/src/App.tsx:67-73`: `/` → Board (`:68`),
`/episodes/:id/runs/:run` → Run (`:69`), `/episodes/:id/runs/:run/gate` → Gate (`:70`),
`/episodes/:id/runs/:run/what-happened` → WhatHappened (`:71`), and `*` → the "no such page" line
(`:72`). **No route segment names a show.**

Three places assume one show:

- the chrome's own link, `console/src/App.tsx:57` — `{show.data?.showName ?? "console"}` as the link
  to `/`;
- **the Board's title, `console/src/pages/Board.tsx:118`** — `` `${show.showName} — the board` ``;
- **the document title**, `useDocTitle` at `console/src/useDocTitle.ts:34-39` mounted once at
  `console/src/App.tsx:43`, deriving its string from `titleFor` at
  `console/src/projections.ts:198-211`, which interpolates one `showName` into five forms (`:199`,
  `:202`, `:204`, `:208`, `:210`).

`ShowInfo` is declared on the client side at `console/src/api.ts:23-31` with seven fields, including
`showName` and `showSlug`.

### 1.8 The count a registry touches

Measured by grep over `console/server/*.ts`, `console/worker/*.ts` and the client's non-test sources:

| Where | Lines reading the one show | Files |
|---|---|---|
| `console/server/app.ts` | 18 | |
| `console/server/runs.ts` | 7 | |
| `console/server/gates.ts` | 6 | |
| `console/server/what-happened.ts` | 6 | |
| `console/server/episodes.ts` | 5 | |
| `console/server/workers.ts` | 4 | |
| `console/server/artifacts.ts` | 3 | |
| `console/server/main.ts` | 1 | |
| **server and worker subtotal** | **50 lines** (82 individual field reads) | 8 |
| `console/src/api.ts` | 7 | |
| `console/src/App.tsx` | 6 | |
| `console/src/projections.ts` | 5 | |
| `console/src/useDocTitle.ts` | 3 | |
| `console/src/pages/Board.tsx` | 1 | |
| **client subtotal** | **22 lines** | 5 |
| **total** | **72 lines** | **13**, plus `console/server/show.ts` (89 lines) = **14** |

Twenty-two function signatures and class members take `ctx: ShowContext` as a parameter
(`console/server/app.ts:85`, `:93`, `:132`; `console/server/artifacts.ts:63`, `:179`, `:206`; `console/server/gates.ts:75`,
`:119`; `console/server/runs.ts:314`, `:326`; `console/server/episodes.ts:17`, `:40`, `:75`, `:112`; `console/server/workers.ts:25`, `:47`,
`:74`; `console/server/what-happened.ts:46`, `:97`, `:138`, `:189`, `:218`). Every one of them becomes a signature
that must also say which show it means, or must take a per-show context resolved by the caller.

### 1.9 The engine calls underneath are episode-shaped, which matters for §4

`parseEpisodeId` is called at **10 non-test sites** in the console: `console/server/artifacts.ts:65`,
`console/server/episodes.ts:18`, `:41`, `:77`, `console/server/gates.ts:120`, `console/server/app.ts:45`, `console/server/runs.ts:372`, `:408`,
`console/server/what-happened.ts:139`, `console/server/workers.ts:75`. Beneath those: `EventLog.logPath` at **nine** sites
(`console/server/app.ts:86`, `:189`, `:335`; `console/server/artifacts.ts:207`; `console/server/what-happened.ts:47`; `console/server/runs.ts:414`;
`console/server/workers.ts:26`; `console/worker/main.ts:36`, `:74`), `episodePipeline` at **five** (`console/server/gates.ts:130`,
`console/server/app.ts:94`, `console/server/what-happened.ts:141`, `console/server/runs.ts:433`, `console/worker/main.ts:118`), `latestRunId` at **two**
(`console/server/app.ts:323`, `console/server/runs.ts:373`) and `runLogPaths` at **one** (`console/worker/main.ts:122`). **Twenty-seven
sites in all.**

---

## 2 · What a registry could be, measured against what exists

**Conclusion: the registry's hard problem is not where the list lives — it is that the only
show-identity fields in a `showrunner.json` are `showName` and `showSlug`, and the two shows on this
machine both declare `"Dead Light"` and `"DeadLight"`.** A URL keyed on the slug cannot tell them
apart. So can a NAS path: both configs name `/Volumes/media/DeadLight`.

### 2.1 The two configs, side by side

Measured by reading both `showrunner.json` files on 2026-10-07:

| Key | `~/GitHub/DeadLight` (retired) | `~/GitHub/DeadLight2` (live instance) |
|---|---|---|
| `showName` | `"Dead Light"` | `"Dead Light"` |
| `showSlug` | `"DeadLight"` | `"DeadLight"` |
| `episodesDir` / `productionDir` / `canonDir` / `promptsDir` | `Episodes` / `Production` / `Canon` / `prompts` | identical |
| `airMap` keys | `ep01`…`ep10` (ten entries) | `{}` (none) |
| `output.nasRoot` | `/Volumes/media/DeadLight` | `/Volumes/media/DeadLight` |
| `output.finalFilename` | `{slug} S{season:02d}E{episode:02d}.mp4` | identical |
| top-level keys | the same thirteen: `airMap`, `audio`, `canonDir`, `episodesDir`, `models`, `output`, `productionDir`, `promptsDir`, `publish`, `showName`, `showSlug`, `video`, `visual` | the same thirteen |

`SHOW_CONFIG_KEYS` at `engine/src/show-config.ts:56-116` carries **60 rows** and **no identity key
beyond `showName` and `showSlug`**. There is no `showId`.

### 2.2 The three options, each measured

**(a) `--show` repeated (`--show a --show b`).** Blocked today by `flag()` at
`console/server/main.ts:22-27`: `indexOf` returns the first match, so `--show /a --show /b` yields
`/a` and the second root is dropped with no message. The fix is one function (collect every
occurrence); the cost is that the registry then lives only in the process's argv, so adding a show
means restarting the console, and the "New show" surface of §3 cannot register what it just created
without a restart. **That is the option that makes the New-show surface incomplete.**

**(b) A registry file** (`~/.showrunner/shows.json`, or a path under the engine root).
`~/.showrunner` does not exist on this machine (measured). A file is the only one of the three
options the New-show surface can append to at the end of a successful `runInit` — `InitReport.root`
at `tools/src/init/init.ts:58` is exactly the value such an entry needs. It is also the only option
that can carry a **key chosen by the operator**, which §2.1 shows is required: the slug cannot be it.

**(c) A directory the server scans for `showrunner.json`.** Measured: `find ~/GitHub -maxdepth 2
-name showrunner.json` returns exactly **two** files today — the retired repository and the live
instance. The scan works, and it finds both shows with no configuration at all. Its defect is the
same slug collision: the scan would discover two shows whose only names are identical, so the server
would have to key them on their directory basename (`DeadLight` and `DeadLight2`) — a path, not a
show-config fact.

### 2.3 How the client would name a show in a URL

Today no client URL carries a show. The two candidate shapes:

- **`/shows/<key>/…`** in front of the existing five routes (`console/src/App.tsx:68-72`) and the
  fourteen `:id` routes of §1.5. The key cannot be `showSlug`: §2.1 measured it as `"DeadLight"` for
  both repositories, so `/shows/DeadLight/episodes/s01e01/runs/r1` is ambiguous between them.
- **A chosen key**, stored in the registry beside the root. This is what option (b) buys and what
  options (a) and (c) must invent from a path.

### 2.4 How the SSE channel keys events

Today `{type: "run", episodeId, runId, offset}` at `console/shared/types.ts:164`. With a registry,
one server's channel carries notices from every registered show, and two shows each holding an
`s02e01` would be indistinguishable. **A show key must be added to `run` and to `episodes`**, and
`parseMessage` at `console/src/api.ts:233-258` must validate it, or a Board watching show A will
refetch on show B's every heartbeat. The `hello` variant already carries `showName`
(`console/server/app.ts:205`) and would become a list rather than one name.

### 2.5 What `ShowContext` becomes

Two shapes are available, and the 22 signatures of §1.8 decide which:

- **A map of contexts**, `Map<showKey, ShowContext>`, resolved per request by a middleware that
  reads the URL's show segment. Every one of the 22 signatures keeps its `ctx: ShowContext`
  parameter unchanged; only the callers change. `RunStore` becomes one store per show
  (`console/server/main.ts:68` becomes a loop) or one store whose five maps gain a show segment.
- **One context with a show list**, every signature gaining a show parameter. This touches all 22
  signatures and all 50 server lines.

The first shape is the smaller change, and `console/server/show.ts:7-11`'s own argument supports it:
the objection recorded there is that *"no route"* says which show it means — a URL segment and a
middleware answer exactly that objection without changing what a context is.

### 2.6 The retired repository as a second show, measured today

Every claim below was measured by running the engine at `12e2eaa` against
`~/GitHub/DeadLight` on 2026-10-07. Nothing was written.

**`loadShowConfig(~/GitHub/DeadLight)` succeeds.** It returns `showName: "Dead Light"`,
`showSlug: "DeadLight"`. The ten `epNN` entries in its `airMap` are accepted (the loader refuses an
*aired* key, not a production one).

**`listEpisodeIds` there returns twelve ids:** `ep01 ep02 ep03 ep04 ep05 ep06 ep07 ep08 ep09 ep10
ep98 ep99`. For contrast, the live instance returns ten: `s01e01`…`s01e10`.

**Archive markers: ten, `Episodes/ep01/archive.json` through `Episodes/ep10/archive.json`.** `ep98`
and `ep99` have none. `ep98` has `Episodes/ep98/` (an `outline.md`, a `script.md` and a leftover
`STATUS.md`) and `Production/ep98/` with an **empty** `runs/` directory; `ep99` has only
`Production/ep99/` and no `Episodes/ep99/` at all. No episode in the retired repository has a
`premise.md`.

**What the Board would show** — measured by calling `RunStore.episodeRow` for all twelve ids against
the retired repository through `console/dist/server/`:

| Row | `stage` | `status` | Note |
|---|---|---|---|
| `ep01`…`ep10` | `COMPLETE` | `archived` | each with its marker's own note, e.g. `ep05`: "Season 1, made by console v1; final on the NAS 2026-08-02" |
| **`ep98`** | **`NEEDS_IDEA`** | **`none`** | title `Ep. 98 — "The Wick" — BEAT SKELETON` |
| **`ep99`** | **`NEEDS_IDEA`** | **`none`** | title falls through to the id, `ep99` |

**This is F-10's question, measured.** For a row with `status: "none"`, `console/src/pages/Board.tsx:171-184`
renders a launch button **disabled** (`disabled={row.needs.ideaMissing || busy !== null}` at `:176`)
with the reason `write Episodes/ep98/premise.md first` at `:182`. So the cost of registering the
retired repository is two rows that read `NEEDS_IDEA · no runs` with a greyed launch button, in a
repository nobody intends to run — the exact shape the fresh instance dissolved
(`docs/plans/2026-10-04-the-cutover-deferred.md:32`).

**Its prompts are the old thirty-four plus the seven desk prompts, confirmed by diff.** The retired
`prompts/` holds 51 entries, 42 of them `.md` (41 prompts plus `README.md`); the instance's holds 43,
35 of them `.md` (34 prompts plus `README.md`). The eight entries present only in the retired
repository are `apply.md`, `arc-tracker.md`, `craft-critic.md`, `desk-editor.md`,
`desk-gate.gate.md`, `desk-gate.reject.md`, `thread-auditor.md` — **the seven desk prompts** — and
`prompts/index.json`. Nothing is present only in the instance.

**`check-prompts` renders all forty-one of them with the engine at `12e2eaa`:**

```
$ node tools/dist/check-prompts.js --prompts /Users/ryanperkowski/GitHub/DeadLight/prompts \
      --context tools/show-data/deadlight-check-context.json
every prompt in /Users/ryanperkowski/GitHub/DeadLight/prompts renders
EXIT=0
```

**This corrects Plan F's record.** `docs/plans/2026-10-04-the-cutover-deferred.md:33` says "four of
the seven do not render under the engine's context". Against
`tools/show-data/deadlight-check-context.json` they all render, because that context file supplies
step results for `arc-tracker`, `craft-critic`, `desk-editor`, `desk-gate`, `propose`,
`thread-auditor` and `season-status`. The record's claim must have been measured against a context
without them; the file in the engine repository at `12e2eaa` renders the whole directory clean.

**`bible-check` passes for both seasons:**

```
$ node tools/dist/bible-check.js --show /Users/ryanperkowski/GitHub/DeadLight --season 1
every bible file … is present and carries every section a prompt reads by name (season 1)   EXIT=0
$ node tools/dist/bible-check.js --show /Users/ryanperkowski/GitHub/DeadLight --season 2
every bible file … is present and carries every section a prompt reads by name (season 2)   EXIT=0
```

Both pass because the retired repository carries `Canon/season-1.md`, `Canon/season-2.md` **and**
`Canon/season-desk-report.md`. `bible-check` runs the same two functions the engine's `bible-ready`
guard runs (`README.md:553-554`), so **the `bible-ready` guard passes in the retired repository for
both seasons.**

**What breaks if the new console is pointed at the retired repository.** Measured, nothing is
written and nothing refuses at startup. What is wrong is downstream:

1. **Two `NEEDS_IDEA` rows with a disabled launch button** (`ep98`, `ep99`) — §2.6's table.
2. **`ep98` and `ep99` build a 68-step pipeline with no season file in the canon spine.** Measured:
   `episodePipeline({show, episodeId: "ep98"})` succeeds with 68 steps and the `outline` step
   declares no `Canon/season-*.md` input, while `ep01` declares `Canon/season-1.md` (because the
   retired `airMap` maps `ep01` → `[1,1]` and maps neither `ep98` nor `ep99`). A prompt writing
   `{{season}}` therefore fails for those two ids — `README.md:463-470` and
   `docs/plans/2026-10-04-the-cutover-deferred.md:61`. In the retired repository, `{{season}}`
   appears in seven prompts plus the README: `apply.md`, `arc-tracker.md`,
   `canon-review-outline.md`, `craft-critic.md`, `desk-editor.md`, `desk-gate.reject.md`,
   `thread-auditor.md`.
3. **The NAS collision.** Both configs name `output.nasRoot: /Volumes/media/DeadLight` and the same
   `finalFilename` pattern. A finalize step run in the retired repository writes over the live
   instance's Season 1 finals. Read-only listing is safe; one launch is not.
4. **The `ep98` exercise owns that tree.** `docs/plans/2026-10-04-the-cutover-deferred.md:49` names
   `SHOWRUNNER_SHOW_ROOT=/Users/ryanperkowski/GitHub/DeadLight` as the one documented writer of the
   retired repository. A registry entry puts a second writer beside it.

---

## 3 · The "New show" surface, measured against `runInit`

**Conclusion: `runInit` is already shaped for a browser — it takes an `InitIO` of three methods and
returns an `InitReport` — but it spawns `git` and `gh`, builds the real SDK executors, and runs for
the length of thirteen interviews. The decision Plan H's author must make is not whether the IO can
be implemented over HTTP (it can) but whether an interview is a request or a process.**

### 3.1 `InitOptions`, `InitDeps`, `InitReport`

`InitOptions` at `tools/src/init/init.ts:23-32`: `name`, `slug?`, `path`, `nasRoot?`,
`github: "private"|"public"|"none"`, `engineRoot`, `importFrom?`, `resume?` — **eight fields, all of
them form inputs.**

`InitDeps` at `tools/src/init/init.ts:40-46`: `executors?`, `renderGateMessage?`, `git?`, `now?`,
`operator?` — **five seams, every one optional.** The real executors are built inside `runInit` by
`realInterviewDeps` at `tools/src/init/init.ts:121-127`, with
`promptsDir: interviewPromptsDir()` (`tools/src/init/init.ts:80-82`,
`<templatesDir()>/interview`) — **not the show's own `prompts/`.**

`InitReport` at `tools/src/init/init.ts:57-64`: `root`, `files` (one `InterviewResult` per approved
file), `stalled`, `commits`, `remote?`, `nextSteps`. **`root` is exactly the value a registry entry
needs** (§2.2's option (b)).

`runInit(opts, io, deps)` is at `tools/src/init/init.ts:337-495`.

### 3.2 `InitIO` — three methods

`tools/src/init/interview.ts:23-27`:

```
export interface InitIO {
  say(text: string): void;
  ask(question: string, opts?: { multiline?: boolean; default?: string }): Promise<string>;
  choose<T extends string>(question: string, choices: readonly { key: T; label: string }[]): Promise<T>;
}
```

`say` is **fire-and-forget and synchronous**; `ask` and `choose` are promises. The contract recorded
at `tools/src/init/interview.ts:18-22` binds any implementation: *"when the author accepts [a
default] unchanged, return the default text"* — a browser form that posted an empty textarea would
erase the prior answer.

### 3.3 How often each is called in a full interview

Call sites, measured: **`say` at 33 sites** (19 in `tools/src/init/init.ts` — `:288`, `:349`, `:351`,
`:360`, `:372`, `:395`, `:409`, `:417`, `:434`, `:460`, `:466`, `:468`, `:477`, `:481`, `:483`,
`:486`, `:491`, `:492`; 14 in `tools/src/init/interview.ts` — `:453`, `:473`, `:478`, `:489`, `:499`,
`:579`, `:580`, `:612`, `:639`, `:646`, `:652`, `:656`, `:671`, `:675`). **`ask` at four sites**
(`tools/src/init/interview.ts:525` the per-question ask; `:593` the rejection notes; `:609` the import path; `:659`
the cast fallback). **`choose` at two sites** (`tools/src/init/interview.ts:464` the pre-question import offer;
`tools/src/init/interview.ts:585` the gate answer).

The questions per canon template, measured with `grep -c 'Q:' tools/templates/canon/*.md` and
confirmed by running `parseCanonTemplate` over all fifteen templates:

| Key | Mode | Questions |
|---|---|---|
| `world-overview` | interview | 9 |
| `series-arc` | interview | 5 |
| `episode-formula` | interview | 5 |
| `story-craft` | default | 0 |
| `style-guide` | interview | 8 |
| `technology` | interview | 5 |
| `timeline` | interview | 3 |
| `season-1` | interview | 3 |
| `visual-style` | interview | 9 |
| `visual-audit-laws` | interview | 1 |
| `publishing-guide` | interview | 4 |
| `pipeline-artifacts` | default | 0 |
| `readme` | default | 0 |
| `continuity-ledger` | scaffold | 0 (never interviewed) |
| `voice-registry` | scaffold | 0 (never interviewed) |
| **total** | **13 gated, 10 of them interviewed** | **52** |

So **one clean interview with no imports and no rejections is 52 `ask` calls (every one with
`multiline: true`, `tools/src/init/interview.ts:525`) and 13 `choose` calls** (one gate answer per gated file,
`tools/src/init/interview.ts:585`). With `--import` finding a candidate for all thirteen files, add **13 more
`choose` calls** (`tools/src/init/interview.ts:464`) for 26. Each rejection adds one `choose` plus one `ask`
(`tools/src/init/interview.ts:593`); the cap is ten rejections per file
(`maxAttempts: 10`, `engine/src/pipelines/bible.ts:68`), so the worst case per file is 10 `choose`
and 10 `ask` beyond its questions.

### 3.4 The terminal IO's line queue and the multiline terminator

`terminalIO` is at `tools/src/init/main.ts:159-253`. **Input is read through a line queue and never
through `rl.question()`** — the reason is recorded at `tools/src/init/main.ts:152-158`: readline
starts consuming input the moment the interface exists, so a pasted block became `line` events with
nobody listening and every answer after the first vanished. The queue is `queued: string[]` at
`:163`, the parked questions are `waiting` at `:165`, and `askLine` at `:188-201` consults the queue
**before** the `ended` flag (`:197-199`) so a block piped in and followed by EOF is fully answered.

**The multiline terminator is a line holding only a period** — `if (line.trim() === ".") break` at
`tools/src/init/main.ts:228`. A multiline answer the author ends immediately keeps the offered
default (`:231`). `choose` takes Enter as the first choice (`:239`), a number, or a choice's own key
(`:240-243`), and re-asks anything else (`:244`) — *"a gate answer that was a typo would otherwise
approve a bible file"* (`tools/src/init/main.ts:145-147`).

**None of this is what a browser needs**, and that is the point: the three `InitIO` methods are the
seam, and `terminalIO` is one implementation of it.

### 3.5 What state lives where during an interview — what "resume" can mean

Four stores, measured:

| State | Where | Written when |
|---|---|---|
| the author's answers | `<productionDir>/setup/<key>/answers.md` (`answersPath`, `engine/src/pipelines/bible.ts:30-32`) | **after every single answer**, not once at the end — `record()` at `tools/src/init/interview.ts:519-523`, called at `:526` |
| the run log | `<productionDir>/setup/<key>/runs/<runId>.jsonl` (`bibleLogDir`, `engine/src/pipelines/bible.ts:22-24`) | by `run()` as it goes; the gate answer by `answerGate` (`tools/src/init/interview.ts:589`, `:598`, `:604`, `:617`) |
| the bible file itself | `<canonDir>/<file>.md` | by the `write` agent, or written directly for a default file (`tools/src/init/interview.ts:532`) or for "I will write this one myself" (`tools/src/init/interview.ts:600`) |
| the commits | git, **one per approved file** | `gitCommit` at `tools/src/init/init.ts:456` |

`--resume` asks one question per file: `isApproved(showRoot, entry, productionDir)` at
`tools/src/init/interview.ts:690-696` — the lexically last log under the file's log directory,
`state.finished && state.status === "completed"`. The resume path is `tools/src/init/init.ts:408-421`
and it also makes a catch-up commit for an approval that was never committed (`:415-420`).

An unfinished file's earlier answers are offered back as defaults: `parsePriorAnswers` is read before
anything is asked (`tools/src/init/interview.ts:494-498`) because the answers file is about to be rewritten
(`tools/src/init/interview.ts:492-493`).

**So a browser-driven interview can already be resumed after a tab closes, with no new persistence:
every answer is on disk the moment it is given, and the approval is in the log.** What a browser does
*not* have is the terminal's guarantee that the process holding the question is the process the
answer returns to — see §3.7.

### 3.6 What the surface must show while waiting

The `write` step's declared bound is **`timeoutMs: 20 * MIN` at `engine/src/pipelines/bible.ts:63`**
(the `revise` fix agent the same, at `:57`). That is the measured upper bound a browser surface must
tolerate for one file.

**The cost figure the records carry is `$2.24` for one file on the writer model**
(`docs/plans/2026-10-03-the-new-show-setup-deferred.md:37`), *"so a thirteen-file setup is near $30
before the author writes a premise"*. **No duration was recorded.** Plan G's plan asked for one
(`docs/plans/2026-10-03-the-new-show-setup.md:1173`, Task 9 Step 2: *"the elapsed time"*) and neither
the plan file nor the deferred record states a number — grepping both for a seconds figure returns
nothing. Plan H's author must treat the wait as "up to twenty minutes, one real sample costing
$2.24, duration unmeasured", which argues for a surface that streams the step's events rather than
one that blocks on a response.

What the surface has to render during that wait, from the run log: `step_started`/`step_completed`
for `write`, the `agent_query`/`agent_result` pair, and then the gate. The interview's own two `say`
calls at the gate are the content: `io.say(gate.message)` at `tools/src/init/interview.ts:579` and
`io.say(await fileForReview(destination, entry.file))` at `:580` — **the gate message and the whole
file, unpaged** (`tools/src/init/main.ts:148-150`: *"A bible file at its gate is printed whole …
a pager would put the decision behind a program"*).

The four gate answers are `GATE_CHOICES` at `tools/src/init/interview.ts:105-110`: approve, reject
with notes, "I will write this one myself", import. The gate's step id is the literal `"gate"`
(`tools/src/init/interview.ts:74`).

### 3.7 What `runInit` returns, where it throws, and whether it can run in the server

`runInit` returns `InitReport` at `tools/src/init/init.ts:494`. It throws at: an empty name (`:340`),
a bad slug (`:366-368`), `checkRoot`'s refusal of a non-empty directory without `--resume` (`:342`),
`checkImportFrom` (`:343`), and any `interviewFile` failure that is **not** gate exhaustion
(`:441-443`; exhaustion is caught at `:430-441`, pushed to `stalled`, and the interview carries on).
A failed run inside one file throws from `tools/src/init/interview.ts:626`.

**Can it run inside the console's server process? Technically yes, and architecturally no.**

The technical answer, measured: `run()`'s in-process guard is `const active = new Map<string,
Promise<RunResult>>()` at `engine/src/runner.ts:191`, **keyed by `path.resolve(opts.log.path)`**
(`:195`). An interview's log is `<productionDir>/setup/<key>/runs/<runId>.jsonl` and an episode run's
is `<productionDir>/<episodeId>/runs/<runId>.jsonl` — **different paths, so an interview in the
server process and a worker's episode run would not collide.** The map is module-level and therefore
per-process in any case; a worker is a separate process. **Two interviews of the same bible file in
one server process would collide**, which is the real exposure, and it is the shape a browser with
two tabs produces.

The architectural answer is Plan E's rule, stated at `console/server/main.ts:11-18` and
`README.md:477-479`: the server *"owns no run"*, spawns every worker detached, and may be killed or
restarted without a run noticing. `runInit` violates all of it — it spawns `git` and `gh`
(`tools/src/init/git.ts`), builds the real SDK executors with `sdkQuery`
(`tools/src/init/init.ts:122`), and runs for up to twenty minutes per file across thirteen files.
**An interview inside the server is a twenty-minute-per-file agent run that dies when the operator
restarts the console** — the single failure the three-process design exists to prevent.

### 3.8 The worker: a `--setup <key>` mode, or a second entry

Measured, `console/worker/main.ts` hard-codes the episode shape at **five lines**:

| Line | What it builds | What a setup mode needs instead |
|---|---|---|
| `console/worker/main.ts:36` | `lockPath` via `EventLog.logPath` | a lock beside the bible log |
| `console/worker/main.ts:74` | `logFile` via `EventLog.logPath` | `bibleLogDir(showRoot, key, productionDir)` + the run id (`engine/src/pipelines/bible.ts:22`) |
| `console/worker/main.ts:118` | `episodePipeline({show, episodeId, engineRoot})` | `bibleFilePipeline({entry, vars, productionDir})` (`engine/src/pipelines/bible.ts:52`) |
| `console/worker/main.ts:119` | `agentOpts = {query: sdkQuery, show}` — **no `promptsDir`**, so the executor resolves the show's own `prompts/` (`engine/src/agent-step.ts:148-150`) | `promptsDir: <templatesDir()>/interview` (`tools/src/init/init.ts:80-82`) |
| `console/worker/main.ts:122` | `runLogPaths(showRoot, episodeId, productionDir)` for the prior logs | the bible file's own log directory |

Plus the `vars` object the three interview prompts render — six keys built at
`tools/src/init/interview.ts:546-552` (`file`, `key`, `purpose`, `answersPath`, `templatePath`,
`date`). `EventLog.logPath` cannot build a setup path at all: its own comment at
`engine/src/pipelines/bible.ts:18-21` records that *"that function validates the episode id and the
reserved id is not one"*.

**Measured confirmation that the reserved id is refused everywhere the console would need it:**

```
episodePipeline('setup') THREW: invalid episode id "setup": expected sXXeYY (aired) or epNN (production)
latestRunId('setup')     THREW: invalid episode id "setup": expected sXXeYY (aired) or epNN (production)
listRuns('setup')        THREW: invalid episode id "setup": expected sXXeYY (aired) or epNN (production)
```

So a `--setup <key>` mode is five changed lines plus a `vars` builder, and a second worker entry is
those same five decisions in a file of its own with no `if (setup)` in the episode path. **The
measured argument for the second entry is that the episode worker's five sites are the five the
episode path depends on**, and a branch at each is five chances for a setup run to take an episode
code path.

The author's answers are the harder half: `interviewFile`'s gate loop at
`tools/src/init/interview.ts:577-625` calls `io.choose` and `io.ask` **inside** the loop, between two
`run()` calls. A detached worker cannot call `io.ask`. The console's existing shape already answers
this: the engine's `answerGate` plus a fresh worker is exactly how an episode gate is answered
(`console/server/app.ts:367-395`), and `interviewFile`'s own comment at
`tools/src/init/interview.ts:434-437` says so: *"the same two steps the console takes (`answerGate`,
then a worker that calls `run()`)"*. **So the interview's gate needs no new machinery; the
interview's 52 questions do, because they happen before any `run()` and are recorded only in
`answers.md`.**

---

## 4 · The interview's runs in the console

**Conclusion: `setup` reaches nothing in the console today. Every route refuses it with HTTP 400,
and every projection beneath the routes throws on it. A "Bible" view is a new route family, not a
relaxed id check.**

### 4.1 `listEpisodeIds` never lists `setup` — measured

`listEpisodeIds` at `engine/src/episodes.ts:10-21` filters directory names with `isEpisodeId`
(`:18`). `RESERVED_EPISODE_ID = "setup"` at `engine/src/ids.ts:53` matches neither the aired nor the
production grammar (`parseEpisodeId`, `engine/src/ids.ts:15-33`). Measured against the live instance:
`listEpisodeIds` returns the ten `s01eNN` ids and nothing else, while
`Production/setup/` holds thirteen directories.

**The console imports neither `isReservedEpisodeId` nor `RESERVED_EPISODE_ID`.** Grepping
`engine/src`, `tools/src` and all of `console/` for both names finds them only in `engine/src/ids.ts`
(the declaration), `engine/src/agent-step.ts:3,169`, `engine/src/runner.ts:7,212` and
`engine/src/pipelines/bible.ts:3,13`.

### 4.2 The routes, probed against the live instance

A console was started on port 4413 against `~/GitHub/DeadLight2` and stopped by pid afterwards; port
4400 (console v1, pid 3353) was untouched. Measured responses:

| Request | Status | Body |
|---|---|---|
| `GET /api/episodes/setup` | **400** | `{"error":"invalid episode id \"setup\": expected sXXeYY (aired) or epNN (production)"}` |
| `GET /api/episodes/setup/runs/20261004T135026Z-byc7` | **400** | the same message |
| `GET /api/episodes/setup/runs/20261004T135026Z-byc7/gate` | **400** | the same message |
| `GET /api/episodes/setup/files/Canon/world-overview.md` | **400** | the same message |

**`parseEpisodeId` refuses `setup`; `isReservedEpisodeId` is never consulted.** The refusal is
`checkEpisodeId` at `console/server/app.ts:44-46`, reached from `checkIds` at `:69-80` and from each
route's own check (`console/server/app.ts:156`, `:167`, `:181`, …).

### 4.3 What a "Bible" view needs, and what the existing projections give it

The thirteen setup logs in the live instance, measured:

| Key | Logs | `answers.md` |
|---|---|---|
| `world-overview` | 1 | **yes** |
| `series-arc`, `episode-formula`, `story-craft`, `style-guide`, `technology`, `timeline`, `season-1`, `visual-style`, `visual-audit-laws`, `publishing-guide`, `pipeline-artifacts`, `readme` | 1 each | no |
| **total** | **13 logs** | 1 answers file |

Only `world-overview` has an `answers.md` because the import path asks the cast question there and
nowhere else (`tools/src/init/interview.ts:659`, written at `:666`).

One log's whole content, measured (`Production/setup/world-overview/runs/20261004T135026Z-byc7.jsonl`):

```
run_started    | payload keys: engineVersion, episodeId, pipeline, pipelineHash, trigger
gate_opened    | gate | attempt, message            (message: 275 characters)
gate_answered  | gate | {"approved": true, "waitedMs": 0, "attempt": 1, "by": "init:ryanperkowski"}
run_finished   | status
```

`run_started.episodeId` is `"setup"`, `pipeline` is the **name** `"bible-world-overview"`, and
`trigger` is `"init:ryanperkowski"`.

A Bible view needs four things, each with its address:

1. **The fifteen rows** — `BIBLE_FILES` at `engine/src/bible.ts:27-43`, each with `key`, `file`,
   `mode` (interview · default · scaffold) and `purpose`. Thirteen are gated; two (`continuity-ledger`,
   `voice-registry`) have no gate because the pipeline fills them.
2. **Per file, the latest run's state** — `isApproved` at `tools/src/init/interview.ts:690-696`
   already computes exactly this from the lexically last log under
   `bibleLogDir(showRoot, key, productionDir)` (`engine/src/pipelines/bible.ts:22-24`). It is in
   `tools/`, not in `engine/` or `console/`.
3. **The gate message and the file's content** — `gate_opened.message` from the log, and the file at
   `<canonDir>/<file>.md`.
4. **The four gate answers** — `GATE_CHOICES` at `tools/src/init/interview.ts:105-110`.

**What the console's existing projections do for a `setup` id, measured:** nothing, and not only
because of the id check.

- **`RunStore.view()`** (`console/server/runs.ts:365-367`) calls `#project` (`:426-467`), which calls
  `parseEpisodeId` through `#key` (`:408`) and builds `episodePipeline` at `:433` — **both throw on
  `"setup"`** (§3.8's measurement). Even exempted, it would describe a setup run as a 68-step episode
  pipeline with every step pending.
- **`GateView`** (`console/server/gates.ts:119-155`) calls `parseEpisodeId` at `:120` and
  `describePipeline(episodePipeline(...))` at `:130`. `gateArtifacts` at `:75-111` switches on the
  eight episode gate ids and returns `[]` for anything else (`:109-110`) — **a bible gate's id is
  the literal `"gate"`, so it falls through to the empty default.**
- **The files route** (`console/server/app.ts:522-529` → `resolveArtifactPath`,
  `console/server/artifacts.ts:63-88`) calls `parseEpisodeId` at `:65` and then requires the path to
  begin with `<episodesDir>/<id>/` or `<productionDir>/<id>/` (`:66-72`). **A bible file lives at
  `Canon/<file>.md`, which is under neither prefix**, and the comment at
  `console/server/gates.ts:70-74` records that `Canon/` is kept out of the fence deliberately, even
  for `canon-gate`. **So the Bible view cannot serve a bible file through the existing artifact
  route at all, exempted id or not.**

### 4.4 The two shapes available

- **Make `setup` a first-class id in the existing routes.** Cost, measured: the 10 `parseEpisodeId`
  sites of §1.9 become conditional, the 5 `episodePipeline` sites must choose a pipeline, the 9
  `EventLog.logPath` sites must choose a log path builder, and `gateArtifacts` and
  `resolveArtifactPath` need a `Canon/` branch — **27 sites plus the fence.**
- **Give it its own route family** (`/api/bible`, `/api/bible/:key`, `/api/bible/:key/runs/:run`,
  `/api/bible/:key/file`). Cost: four new routes and a second small projection, with the 27 sites
  untouched and the artifact fence unchanged.

---

## 5 · The two Plan F deferrals

### 5.1 (a) The run view for an archived episode derives `NEEDS_IDEA`

**Measured, against the live instance on port 4413:**

```
$ curl -s -w ' HTTP %{http_code}' http://127.0.0.1:4413/api/episodes/s01e01/runs/anything
HTTP 200
```

The body, trimmed:

```
{ "episodeId": "s01e01",
  "runId": "anything",
  "status": "none",
  "stage": "NEEDS_IDEA",
  "steps": [ {"id":"previous-episode","kind":"guard","status":"pending"},
             {"id":"bible-ready","kind":"guard","status":"pending"},
             {"id":"premise","kind":"guard","status":"pending"}, … 68 rows, every one "pending" ],
  "pipeline": { "name":"episode",
                "hashNow":"90364242865d0cf56b9ea9dd9d3bd939b6d1ddfcaf9bad32851beef9f6372a12",
                "changed": false },
  "offset": 0 }
```

Meanwhile the Board row for the same episode is honest:

```
$ curl -s http://127.0.0.1:4413/api/episodes/s01e01
{"id":"s01e01","title":"Ep. 1 — \"Dead Light\" — OUTLINE (pilot rewrite)","stage":"COMPLETE",
 "status":"archived","needs":{"ideaMissing":false,"refsMissing":[],"imagesMissing":[]},
 "archiveNote":"Season 1, made by console v1; final on the NAS 2026-07-18"}
```

**The code path.** The route is `console/server/app.ts:164-178`, whose own comment at `:161-163`
states the behaviour as intended for a different case: *"A run id with no log is not an error: the
view is the pipeline with every step pending, which is what a run looks like in the second between
its launch and its worker's first write."* It calls `store.view(id, run)` at `:177` →
`RunStore.view` at `console/server/runs.ts:365-367` → `#project` at `:426-467`, whose `stage` comes
from `deriveStage(state, EPISODE_STAGE_MAP, needs.flags)` at `console/server/runs.ts:446`.

**`#project` never reads the archive marker.** `readArchiveMarker` is at
`console/server/episodes.ts:74-98` and its only caller is `idleEpisodeRow` at
`console/server/episodes.ts:112-132` (`:114`), which `RunStore.episodeRow` reaches **only** when the
episode has no run logs (`console/server/runs.ts:373-374`). The comment at
`console/server/episodes.ts:105-111` states the rule: *"This is also the only place an
`archive.json` marker is read."*

**The asymmetry that decides the fix.** Three of the four routes for the same nonexistent run id
already refuse or answer empty — measured:

| Request on a run that does not exist | Status | Body |
|---|---|---|
| `GET /api/episodes/s01e01/runs/anything` | **200** | the fabricated 68-step pipeline above |
| `GET /api/episodes/s01e01/runs/anything/gate` | 404 | `{"error":"no gate is open on run anything of s01e01"}` (`console/server/app.ts:515`) |
| `GET /api/episodes/s01e01/runs/anything/log` | 404 | `{"error":"no log for run anything of s01e01"}` (`console/server/artifacts.ts:209-210`) |
| `GET /api/episodes/s01e01/runs/anything/events` | 200 | `{"events":[],"offset":0}` |

**The two fixes' touch points:**

- **Carry the marker's stage into the view.** `#project` at `console/server/runs.ts:426-467` gains a
  `readArchiveMarker` call and a branch at `:446`; `RunView` (`console/shared/types.ts`) gains the
  `archived` status and the note the Board row already carries (`EpisodeRow.archiveNote`,
  `console/shared/types.ts:66`); the Run page renders it. Three files. The marker-is-read-in-one-place
  rule at `console/server/episodes.ts:105-111` becomes a two-place rule, which is the cost.
- **404 for a run id with no log.** One guard in the route at `console/server/app.ts:164-178`, with
  the message `console/server/artifacts.ts:209` already words. **The cost is the launch window the route's own
  comment at `:161-163` protects**: between `POST /api/episodes/:id/runs` creating the log
  (`console/server/app.ts:319-366`) and the worker's first write, the Run page the client has just
  navigated to would 404. Measured mitigation: the launch route creates the log before spawning
  (Plan E ruling 12, `docs/plans/2026-10-02-the-console-deferred.md:68`), so the log file *does*
  exist in that window — the 404 condition is "no log file", not "no events", and
  `console/server/artifacts.ts:209-210` already tests exactly that with `stat`.

### 5.2 (b) `refs-ready` passes vacuously on an outline with no `## Cast`

**The documented contract**, `engine/src/needs.ts:97-104`:

> One line per reference the outline's cast needs and the show does not have: a recurring subject
> without an entry or an image in the visual bible, a speaking recurring character whose voice is not
> LOCKED or whose WAV is absent, a speaking guest with no WAV under the episode's guest-refs. Two
> authoring slips are reported the same way, because a cast line this probe cannot read is a subject
> it cannot check: a line inside the section that misses the grammar, and an entry whose tags name
> none of `recurring`, `guest` or `location`. **Empty when the outline has no `## Cast` section — the
> section's absence is the canon reviewer's finding, not this probe's.**

The same rule is in the README at `README.md:426-427`.

`missingRefs` is at `engine/src/needs.ts:105-…`, and it returns early **twice**:

```
engine/src/needs.ts:108    if (!(await exists(outlinePath))) return [];
engine/src/needs.ts:110    if (cast.length === 0 && malformed.length === 0) return [];
```

Line 110 is the vacuous pass, and it covers two shapes, not one: an outline with **no** `## Cast`
section, and an outline with a `## Cast` section holding nothing `parseCastSection`
(`engine/src/needs.ts:15-27`) can read as either an entry or a malformed line.

**The guard**, `engine/src/pipelines/episode.ts:256-262`:

```
{
  kind: "guard", id: "refs-ready", dependsOn: ["write-commit"],
  check: async (ctx) => {
    const missing = await missingRefs(ctx.showRoot, ctx.episodeId, show);
    return missing.length === 0 ? { pass: true, message: "all references present" } : { pass: false, message: `NEEDS_REFS: ${missing.join("; ")}` };
  },
},
```

**What the canon reviewer prompt says.** `tools/templates/prompts/canon-review-outline.md:17-22`:

> Also flag: undeclared new/retroactive canon …, undeclared arc beats, death-rule violations
> (register, budget, earned grief), and **a missing or incomplete `## Cast` section** — every named
> character and every recurring location that appears must be listed there as `- <Name> (<tags>)`
> with tags from `recurring`, `guest`, `speaks`, `location`.

**It flags, it does not refuse.** The instruction puts a missing section in the reviewer's `issues`
array; it is one line of an agent's judgment, not a guard. So the deferred claim that *"the
section's absence is the canon reviewer's finding"* rests on a prompt line, not on a check.

**What changes if the guard refuses:**

1. **The `ep98` exercise is unaffected, because it is seeded past `refs-ready`.** `seed()` at
   `engine/test/ep98-exercise.test.ts:48-66` walks `orderSteps(pipeline)` and writes a
   `step_started`/`step_completed` pair for every step **before** `upto` (`:56-59`), breaking at
   `upto`. The two exercises use `upto` of `"audio-mix"` and `"nas-mounted"`
   (`engine/test/ep98-exercise.test.ts:121`, `:141`), both downstream of `refs-ready`, so the real
   guard never runs. Measured separately: `Episodes/ep98/outline.md` in the retired repository has
   **no** `## Cast` section (its ten level-2 headings are `## New canon proposed`, `## The mission`,
   `## The people at risk & the assets spent`, `## Beat outline`, `## The episode's payoffs`,
   `## Arc beats`, `## Threads opened`, `## Ending duties`, `## Death rules`, `## Locked choices`).
   **So an unseeded `ep98` run would fail a refusing guard** — the seeding is what hides it.
2. **The walk test's fixture already carries a `## Cast` section**, so it keeps passing. Measured at
   `engine/test/episode-pipeline.test.ts:189`: the fake `outline` executor writes
   `"# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n\n## Beat outline\n…"`, and
   the walk at `:236-…` seeds `Canon/refs.json` and `Production/voice-refs/refs.json` to match
   (`:243-245`).
3. **One test locks the vacuous pass and would have to change.**
   `engine/test/needs.test.ts:135-142` — *"finds a guest voice by slug prefix, and is empty without a
   cast section"* — asserts `expect(await missingRefs(root, "s02e01", show)).toEqual([])` at
   `engine/test/needs.test.ts:141` for an outline whose only heading is `## Beat outline`.
4. **Season 1's archived outlines would fail it, and none of them is ever run.** Measured in the live
   instance: **seven** of the ten Season 1 episodes have an `outline.md` (`s01e01`, `s01e05`–`s01e10`;
   `s01e02`, `s01e03`, `s01e04` have none), **none of the seven carries `## Cast`**, and three
   (`s01e08`, `s01e09`, `s01e10`) carry `## Scene synopsis`. This matches
   `docs/plans/2026-10-04-the-cutover-deferred.md:25` exactly. The ten archive markers keep the Board
   honest regardless, and §5.1's `status: "archived"` row offers no launch button
   (`console/src/pages/Board.tsx:189-191`).

**So the measured cost of making the guard refuse is one test assertion and the unseeded `ep98`
path.** The measured cost of leaving it is that a Season 2 outline written without a `## Cast`
section reaches `tts-script` with an unchecked cast, and the only thing between it and synthesis is
an agent's willingness to flag a missing heading.

---

## 6 · The smaller items the records assign to Plan H

### 6.1 A `.tsx` render test for the client

`console/vitest.config.ts:12-18` declares three keys: `include: ["test/**/*.test.ts"]`,
`testTimeout: 20_000`, `environment: "node"`. **The include pattern matches `.test.ts` only, so no
`.tsx` test file would be collected even if one existed.** The config's own comment at `:3-4` states
the position: *"The console's tests run in Node … none of them renders the client."*

**Neither `jsdom` nor `happy-dom` nor `@testing-library/*` is installed** (measured against
`node_modules`). The console's `devDependencies` (`console/package.json:22-32`) carry
`@vitejs/plugin-react`, `vitest`, `vite`, `tsx`, `typescript`, the three `@types` packages and
`concurrently` — no DOM environment and no render helper. So the cost is at minimum two new
dev dependencies (a DOM environment and `@testing-library/react`), one `include` pattern change and
one `environment` override.

The console suite is **124 tests** today (`it(` calls across `console/test/*.ts` and
`console/test/client/*.ts`), matching `docs/plans/2026-10-04-the-cutover-deferred.md:3`. Two of them
are client tests and both are pure: `console/test/client/doc-title.test.ts` (over `titleFor`) and
`console/test/client/projections.test.ts`.

**The smallest meaningful first test.** Measured by line count and import surface:

| Component | Lines | Imports |
|---|---|---|
| `console/src/components/ProgressBar.tsx` | **36** | `StepRow` (a type) and `progressLabel` — no React hook, no router, no fetch, no context |
| `console/src/components/Diff.tsx` | 47 | **none at all** |
| `console/src/components/AutoTextarea.tsx` | 48 | `useEffect`, `useRef` — jsdom-sensitive |
| `console/src/components/Verdicts.tsx` | 101 | `useState` |
| `console/src/pages/Board.tsx` | 225 | router, context, `post` |

`ProgressBar` is the smallest file and has the most assertable output (the bar's width, the count, the
rate, the ETA — none of it computed on the client, per its comment at `:6-9`). `Diff` is the only
component with zero imports. Either is reachable without a router or a context provider; every page
needs both.

### 6.2 `react-router-dom` and react-router 8

**Measured.** The console depends on `react-router-dom: ^7.18.4` (`console/package.json:20`) and has
`7.18.4` installed, alongside `react-router@7.18.4`. `react-router`'s latest published version is
**8.4.0**; `react-router-dom`'s latest is **7.18.4** — **it publishes no v8 at all.** `npm view
react-router-dom deprecated` returns empty, so npm carries **no deprecation flag**; the accurate
statement is "`react-router-dom` stopped at 7.18.4 and v8 removed it", not "npm deprecated it".

**The console's seven import lines**, all of which change:

```
console/src/App.tsx:1                  import { Link, Route, Routes } from "react-router-dom";
console/src/main.tsx:2                 import { BrowserRouter } from "react-router-dom";
console/src/components/ActionBar.tsx:2 import { Link } from "react-router-dom";
console/src/pages/Board.tsx:2          import { Link, useNavigate } from "react-router-dom";
console/src/pages/Gate.tsx:2           import { Link, useNavigate, useParams } from "react-router-dom";
console/src/pages/WhatHappened.tsx:2   import { Link, useParams } from "react-router-dom";
console/src/pages/Run.tsx:2            import { Link, useParams } from "react-router-dom";
```

**The v8 upgrade guide for a library-mode app** — cited page: <https://reactrouter.com/upgrading/v7>
("React Router v7 to v8 Upgrade Guide"), read 2026-10-07. What it says for a declarative app using
`BrowserRouter`, `Routes` and `Route`:

- **`react-router-dom` is removed in v8.** General APIs come from `react-router`; DOM-specific ones
  from `react-router/dom`. For the seven lines above, every one becomes
  `from "react-router"` — `BrowserRouter`, `Routes`, `Route`, `Link`, `useNavigate` and `useParams`
  are all in the general export.
- The procedure is: update to v7 first (`npm install react-router@7`), then
  `npm uninstall react-router-dom && npm install react-router@latest`.
- **No codemod is offered.**
- **The minimum versions are the load-bearing cost: `node@22.22+`, `react@19.2.7+` and
  `react-dom@19.2.7+`.** Measured against this machine and this repository: Node is **v24.13.1** (fine),
  but React and React DOM are **18.3.1** (`console/package.json:18-19`). **The router upgrade drags a
  React 18 → 19 upgrade with it**, across all fifteen components and four pages
  (`console/src/components/*.tsx`, `console/src/pages/*.tsx`, 2,262 lines).

The brief's phrasing "deprecated upstream" is therefore worth restating precisely for Plan H's
author: the package is not flagged deprecated, it is **frozen at 7.18.4 and absent from v8**, and the
v8 move is a React major as well as a router major.

### 6.3 `guestRefsDir`'s refusals land at probe time, not at config load

**Measured.** `engine/src/show-config.ts:24` declares `audio?: Record<string, unknown>` — the loader
validates `audio` as an object and nothing inside it. The two refusals live in
`guestRefsDir` at `engine/src/needs.ts:74-86`: an empty string at `:77-79` and a value with no
`{episodeId}` at `:80-82`, both `ShowConfigError`. `guestRefsDir` is called from inside `missingRefs`
at `engine/src/needs.ts:124`.

A scratch show (written in the session scratchpad, never in any show repository) with
`audio.guestRefsDir: "Production/guest-refs"` measures the consequence:

```
loadShowContext: OK (the loader accepted the config)
episodeRow THREW: ShowConfigError — showrunner.json: audio.guestRefsDir "Production/guest-refs"
  names no {episodeId} — one shared guest-references directory for every episode is not supported: …
```

And over HTTP, with a console started against that scratch show on port 4414 and stopped by pid:

```
$ curl -s -w ' HTTP %{http_code}' http://127.0.0.1:4414/api/episodes
Internal Server Error HTTP 500
```

**So a misconfigured `audio.guestRefsDir` starts the console cleanly and then makes the whole Board
answer 500** — `readNeeds` (`console/server/episodes.ts:47`) → `missingRefs` → the throw, inside the
`Promise.all` of `console/server/app.ts:150`. Hono has no `onError` handler in `createApp`
(`console/server/app.ts:132-…`), so the reason never reaches the operator. The same shape is recorded
for `video.compositionId` (O-03) at `docs/plans/2026-10-03-the-new-show-setup-deferred.md:31`.

**For a registry this gets worse, not better:** one bad config among several registered shows takes
down the Board for all of them unless the rows are gathered per show with a per-show failure.

### 6.4 The `init` IO on a real terminal

**Never exercised on a TTY, measured.** Every `terminalIO` test in `tools/test/init.test.ts` drives
a pipe: `readlineOver(block)` at `tools/test/init.test.ts:503-505` is
`createInterface({ input: Readable.from([block]) })`, used at `:510`, `:511`, `:520`, `:521`, `:531`,
`:532` and after. **The string `isTTY` appears nowhere in the repository.**

The two TTY-specific behaviours the code reasons about and no test covers: readline's own `"> "`
prompt redraw, handled by `rl.setPrompt(prompt)` at `tools/src/init/main.ts:190` with the reason at
`:183-189` (*"a plain backspace is enough"*), and line editing during a multiline continuation line.
`docs/plans/2026-10-03-the-new-show-setup-deferred.md:23` assigns the terminal check to the first
real `init` and the browser path to Plan H's surface.

### 6.5 `tools/templates/prompts/tts-script.md:141` names the guest-reference path in prose

**Measured in both the template and the instance, at the same line number:**

```
tools/templates/prompts/tts-script.md:141          {{show.productionDir}}/{{episodeId}}/guest-refs/<guest-slug>*.wav — the slug is
/Users/ryanperkowski/GitHub/DeadLight2/prompts/tts-script.md:141   (byte-identical)
```

The line renders `{{show.productionDir}}` and `{{episodeId}}` from the config but **hard-codes the
`guest-refs` segment**, while `engine/src/needs.ts:74-86` resolves that directory from
`audio.guestRefsDir`. A show that configures the key elsewhere gets a prompt that sends the agent to
the wrong directory and a probe that checks the right one. This is the same defect class as §6.3,
one layer up: the config key exists and one reader ignores it.

### 6.6 `scripts/publish-kit.py`'s reminder

**Measured, and the record's line numbers are one off.** `docs/plans/2026-10-04-the-cutover-deferred.md:22`
says "its line 201". The actual addresses:

- `scripts/publish-kit.py:90` — `channel_name = str(sc.value(cfg, "publish", "channelName"))`
- `scripts/publish-kit.py:91` — `playlist_url = …`
- `scripts/publish-kit.py:140` — **`playlist_url` is written into the sheet**
- `scripts/publish-kit.py:199-200` — the comment (*"the reminder still fires until somebody sets
  publish.channelName"*)
- **`scripts/publish-kit.py:201`** — `filled = channel_name != "[YOUR NAME]" and playlist_url != "[PLAYLIST URL]"`
- **`scripts/publish-kit.py:202`** — the `print` carrying
  `NOTE: set publish.channelName + publish.playlistUrl in showrunner.json once, then all episodes fill in`

**`channel_name` is read at `:90` and used only in the `filled` test at `:201`.** It reaches no output
file. So the reminder's promise — "then all episodes fill in" — is true of `playlist_url` (`:140`)
and false of `channel_name`. `publish.channelName` is still `[YOUR NAME]` in both repositories, and
`SHOW_CONFIG_KEYS` cites `scripts/publish-kit.py:90` as its one reader
(`engine/src/show-config.ts:108`). Two tests pin the current behaviour:
`scripts/tests/test_publish_kit.py:96` and `:104`.

### 6.7 A drift check between the engine's templates and a show's prompts and bible

**Measured today, template by template against the live instance:**

| What | Compared | Differing | Changed lines (instance side) |
|---|---|---|---|
| `tools/templates/prompts/*` vs `DeadLight2/prompts/*` | 43 files | **7** | **23** |
| `tools/templates/canon/*` vs `DeadLight2/Canon/*` | 15 files | **15** | not counted — every one is the author's own content |

The seven differing prompts and their instance-side changed-line counts: `outline.md` (7),
`visual-direction.md` (6), `tts-script.md` (5), `environment-check.md` (2), `flow-check.md` (1),
`nano-banana-gate.gate.md` (1), `nano-banana-gate.reject.md` (1).

**This refines `docs/plans/2026-10-04-the-cutover-deferred.md:55`, which says "twenty-three lines,
nine files".** The line count is exactly right; the file count is **seven**, not nine.

A recorded baseline sha per file would need three things, measured: a place to put it in the show
(nothing in `showrunner.json`'s thirteen top-level keys is a manifest — §2.1), a rule for the two
halves (a **prompt** can be compared with its template because the instance started byte-identical;
a **bible file** cannot, because all fifteen differ by design, so its baseline can only be "the sha
at import"), and a reader. `check-prompts` covers renderability only
(`tools/src/check-prompts.ts:1-23`), and `bible-check` checks headings and emptiness, not content
(`README.md:549-551`).

### 6.8 Seven Board titles read "OUTLINE"

**Measured from `GET /api/episodes` against the live instance** — seven of the ten rows carry
`OUTLINE` in the title:

```
s01e01  Ep. 1 — "Dead Light" — OUTLINE (pilot rewrite)
s01e02  S1E2 — "Margin"
s01e03  S1E3 — "The Bag Comes Home By Hand"
s01e04  S1E4 "The Well"
s01e05  Ep. 5 — "Dead Quiet" — OUTLINE
s01e06  Ep. 6 — "Nobody Took a Step" — OUTLINE
s01e07  Ep. 7 — "A Living Vanished" — OUTLINE
s01e08  Ep. 8 — "The Wall of Silence" — OUTLINE
s01e09  Ep. 9 — "The Working Day, Part One" — OUTLINE (written fresh; ep98 is dead and was not consulted)
s01e10  Ep. 10 — "The Working Day, Part Two" — OUTLINE (SEASON FINALE)
```

The three without it (`s01e02`, `s01e03`, `s01e04`) have no `outline.md` and fall through to the
script's heading — exactly as `docs/plans/2026-10-04-the-cutover-deferred.md:48` records. The same
seven-and-three split holds in the retired repository (`ep01`, `ep05`–`ep10` say OUTLINE).

**The derivation is `episodeTitle` at `console/server/episodes.ts:17-28`**: the first `# ` line of
`<episodesDir>/<id>/outline.md`, else of `script.md`, else the id. The comment at `:13-16` gives the
reason the outline is asked first (*"its heading is the one the showrunner approved at
`outline-gate`"*). Cosmetic: the titles are the Season 1 files' own first lines, and fixing them
means either editing ten archived files or stripping a trailing `— OUTLINE` in the derivation.

---

## 7 · Findings

Twenty-one findings. Each carries an address and the question Plan H's author must answer.

| # | Finding | Address | The question |
|---|---|---|---|
| **H-01** | **The registry's shape is undecided, and only one of the three options can be written to by the New-show surface.** `--show` repeated (option a) needs `flag()` rewritten (`console/server/main.ts:22-27`, measured: `--show /a --show /b` yields `/a`) and can only change at a restart. A directory scan (option c) finds both shows today with no configuration (`find ~/GitHub -maxdepth 2 -name showrunner.json` → 2). A registry file (option b) is the only one `runInit` can append `InitReport.root` to at `tools/src/init/init.ts:494`. | `console/server/main.ts:22-27`, `:46`; `tools/src/init/init.ts:58` | Which of the three, and if a file, where — `~/.showrunner/shows.json` (absent today) or a path under the engine root (which `--engine-root` already names, `console/server/main.ts:51`)? |
| **H-02** | **`showSlug` cannot key a show in a URL: both repositories on this machine declare `showName "Dead Light"` and `showSlug "DeadLight"`, and both name `output.nasRoot "/Volumes/media/DeadLight"`.** `SHOW_CONFIG_KEYS` (60 rows) carries no `showId`. | both `showrunner.json` files; `engine/src/show-config.ts:56-116` | What is the registry's key — an operator-chosen name, the directory basename (`DeadLight` vs `DeadLight2`), or a new config key? And does a registry refuse two entries whose `nasRoot` collides, given that one finalize run in the retired repository writes over the instance's Season 1 finals? |
| **H-03** | **The retired repository loads cleanly as a second show and shows twelve rows, two of which are F-10's.** `loadShowConfig` succeeds; `listEpisodeIds` returns `ep01`–`ep10`, `ep98`, `ep99`; the ten markers make `ep01`–`ep10` `COMPLETE`/`archived`; **`ep98` and `ep99` read `NEEDS_IDEA`/`none` with a disabled launch button and the reason `write Episodes/ep98/premise.md first`.** Its 41 prompts all render (`check-prompts`, exit 0) and `bible-check` passes for both seasons. | §2.6; `console/src/pages/Board.tsx:171-184`; `console/server/episodes.ts:112-132` | Is the retired repository a registry entry at all? If yes, what do `ep98` and `ep99` show — a second marker kind, a per-show ignore list, or two misleading rows? If no, the registry's first real use case (`docs/plans/2026-10-04-the-cutover-deferred.md:16`) does not exist and the registry is built for a show that has not been made yet. |
| **H-04** | **Where the interview runs is the plan's largest decision, and the engine's own guard does not forbid the server.** `run()`'s `active` map (`engine/src/runner.ts:191`) is keyed by the resolved log path, and a setup log (`<productionDir>/setup/<key>/runs/…`) never collides with an episode log — **different logs, no collision, measured.** But `runInit` spawns `git` and `gh`, builds `sdkQuery` executors (`tools/src/init/init.ts:122`) and runs up to 20 min per file (`engine/src/pipelines/bible.ts:63`) across thirteen files, which breaks Plan E's rule that the server owns no run (`console/server/main.ts:11-18`, `README.md:477-479`). | `engine/src/runner.ts:191-203`; `tools/src/init/init.ts:337-495` | Server, detached worker, or the CLI with the console as a viewer? A viewer is the cheapest honest answer: the interview already writes every answer and every approval to disk (H-06), so a console that only *reads* `Production/setup/` needs no `InitIO` implementation at all. |
| **H-05** | **The surface must render 52 questions, 13 gate answers and a wait of unmeasured length.** Measured: 52 `ask` calls (all `multiline: true`, `tools/src/init/interview.ts:525`), 13 `choose` calls at the gates (`:585`), 13 more with `--import` (`:464`), and 33 `say` sites. The gate shows **the message and the whole file unpaged** (`:579-580`). The only cost figure on record is **$2.24 for one file** (`docs/plans/2026-10-03-the-new-show-setup-deferred.md:37`); **no duration was ever recorded**, though Plan G's Task 9 asked for one (`docs/plans/2026-10-03-the-new-show-setup.md:1173`). | `tools/src/init/interview.ts:525`, `:585`, `:464`, `:579-580`; `engine/src/pipelines/bible.ts:63`; §3.3, §3.6 | Does the surface stream the `write` step's events from the log (which it can, with no new machinery) or block on a response for up to twenty minutes? And does the multiline answer keep the terminal's lone-period terminator, or become a textarea — in which case the "empty means keep the default" contract at `tools/src/init/interview.ts:18-22` must be reimplemented. |
| **H-06** | **"Resume" in the browser needs no new persistence, because every answer is already on disk the moment it is given.** `record()` rewrites `answers.md` after **every** answer (`tools/src/init/interview.ts:519-526`), the approval is in the run log, and `isApproved` (`tools/src/init/interview.ts:690-696`) is the per-file question `--resume` already asks. | `tools/src/init/interview.ts:519-526`, `:690-696`; §3.5 | What does a browser "resume" mean operationally — does the surface reconstruct an in-flight interview from `answers.md` plus the log, or does it hand the author the `--resume` command line? And who owns the half-answered file if two tabs are open on it? |
| **H-07** | **`setup` reaches nothing: all four probed routes answer HTTP 400, and three engine helpers throw on it.** Measured against the live instance: `GET /api/episodes/setup`, `…/runs/<id>`, `…/runs/<id>/gate` and `…/files/Canon/world-overview.md` all return `400 {"error":"invalid episode id \"setup\": …"}`. Beneath them, `episodePipeline`, `latestRunId` and `listRuns` each throw on `"setup"`. The console imports neither `isReservedEpisodeId` nor `RESERVED_EPISODE_ID`. **And the artifact fence refuses a bible file on a second ground: `Canon/<file>.md` is under neither `<episodesDir>/<id>/` nor `<productionDir>/<id>/`** (`console/server/artifacts.ts:66-72`), a restriction `console/server/gates.ts:70-74` records as deliberate. | §4.2, §4.3; `console/server/app.ts:44-46` | A first-class `setup` id (27 sites, §4.4) or its own route family (four routes, §4.4)? And how does a Bible view serve `Canon/<file>.md` without opening the shared canon tree to the artifact route? |
| **H-08** | **The archived episode's run view fabricates a 68-step pending pipeline and says `NEEDS_IDEA`, while three sibling routes on the same nonexistent run already refuse.** Measured: `GET /api/episodes/s01e01/runs/anything` → **200** with `status:"none"`, `stage:"NEEDS_IDEA"`, 68 pending steps; `…/gate` → 404 (`console/server/app.ts:515`); `…/log` → 404 (`console/server/artifacts.ts:209-210`); `…/events` → 200 and empty. The marker is read in exactly one place, `idleEpisodeRow` (`console/server/episodes.ts:112-132`), which `#project` never calls. | `console/server/app.ts:164-178`; `console/server/runs.ts:446`; `console/server/episodes.ts:112-132`; §5.1 | Carry the marker's stage into `RunView` (three files, and the one-place marker rule becomes two) or 404 the route (one guard, reusing `console/server/artifacts.ts:209`'s wording — and the launch window the route's comment protects is already covered, because the launch creates the log before spawning)? |
| **H-09** | **`refs-ready`'s vacuous pass covers two shapes, not one, and the "canon reviewer's finding" it defers to is a prompt line that says "flag", not "refuse".** `engine/src/needs.ts:110` returns `[]` both for an absent `## Cast` section and for a present one holding nothing readable. `tools/templates/prompts/canon-review-outline.md:17-22` asks the agent to *flag* a missing section into `issues`. Making the guard refuse costs **one test assertion** (`engine/test/needs.test.ts:141`) and **the unseeded `ep98` path** (`Episodes/ep98/outline.md` has no `## Cast`; the exercise seeds past the guard at `engine/test/ep98-exercise.test.ts:56-59`). The walk test's fixture already carries a `## Cast` section (`engine/test/episode-pipeline.test.ts:189`). Season 1's seven archived outlines carry none and are never run. | `engine/src/needs.ts:110`; `engine/src/pipelines/episode.ts:256-262`; `engine/test/needs.test.ts:141`; §5.2 | Does the guard refuse, and if so does it refuse an absent section, an empty one, or both? A refusal on "present but unreadable" is the cheaper half and catches the slip the probe was hardened against at `engine/src/needs.ts:12-14`. |
| **H-10** | **The first client render test needs two new dev dependencies and an `include` change, and `ProgressBar.tsx` is the smallest meaningful subject.** `console/vitest.config.ts:14` matches `.test.ts` only and `:16` sets `environment: "node"`; neither `jsdom` nor `happy-dom` nor `@testing-library/*` is installed. `ProgressBar.tsx` is 36 lines with two local imports and no hook, router, fetch or context; `Diff.tsx` is 47 lines with **zero** imports. | `console/vitest.config.ts:14`, `:16`; `console/src/components/ProgressBar.tsx:1-36`; §6.1 | Which DOM environment, and what does the first test assert — the bar's rendered width, or a page's whole tree (which needs a router and a context provider)? |
| **H-11** | **The router upgrade is a React major in disguise.** `react-router-dom` is frozen at **7.18.4** and absent from v8 (npm carries **no** deprecation flag); `react-router` is at **8.4.0**. The v7→v8 guide (<https://reactrouter.com/upgrading/v7>) requires **`react@19.2.7+` and `react-dom@19.2.7+`** and `node@22.22+`; this repository has React **18.3.1** (`console/package.json:18-19`) and Node **v24.13.1**. Seven import lines change (§6.2), and no codemod is offered. | `console/package.json:18-20`; `console/src/App.tsx:1`; §6.2 | Does Plan H take the router move at all, given it brings React 19 across 2,262 lines of components and pages — or does it pin `react-router-dom@7.18.4` and record the move as a later plan? |
| **H-12** | **The SSE channel has no show key, so one server's channel cannot distinguish two shows' runs.** `SseMessage` (`console/shared/types.ts:163-166`) has three variants; `run` carries `{episodeId, runId, offset}` and `episodes` carries nothing. `hello` carries one `showName` (`console/server/app.ts:205`) and is sent once per connection. The client validates each field at `console/src/api.ts:233-258`. | `console/shared/types.ts:163-166`; `console/src/api.ts:233-258`; §2.4 | Does `run` gain a show key (two files, both sides), does each show get its own SSE path, or does the Board filter by refetching and discarding? The Board already refetches on every matching `run` notice (`console/src/App.tsx:39-40`), so an unkeyed channel means show A's Board re-reads its whole disk on show B's heartbeats. |
| **H-13** | **A `--setup <key>` worker mode is five lines plus a `vars` builder; a second entry is the same five decisions without a branch in the episode path.** The five: `console/worker/main.ts:36` (lock path), `:74` (log path), `:118` (`episodePipeline`), `:119` (`agentOpts` — **no `promptsDir`, so it resolves the show's own `prompts/`, not `tools/templates/interview/`**), `:122` (prior logs). The `vars` object is six keys (`tools/src/init/interview.ts:546-552`). **The gate needs nothing new** — `answerGate` plus a fresh worker is the console's existing move, and `tools/src/init/interview.ts:434-437` says so. | `console/worker/main.ts:36`, `:74`, `:118`, `:119`, `:122`; `tools/src/init/interview.ts:546-552`; §3.8 | One worker with a mode flag or two entries? And either way, who asks the 52 questions, since they happen before any `run()` and live only in `answers.md`? |
| **H-14** | **A misconfigured `audio.guestRefsDir` starts the console cleanly and then makes the whole Board answer 500, with the reason never reaching the operator.** Measured on a scratch show: `loadShowContext` accepts it, `episodeRow` throws `ShowConfigError`, `GET /api/episodes` → `500 Internal Server Error`. The loader validates `audio` as an object only (`engine/src/show-config.ts:24`); the refusals are at `engine/src/needs.ts:77-82`. `createApp` registers no `onError`. | `engine/src/show-config.ts:24`; `engine/src/needs.ts:77-82`; `console/server/app.ts:150`; §6.3 | Does Plan H move the refusal to load time (F-02/O-02, `docs/plans/2026-10-03-the-new-show-setup-deferred.md:30`), add an `onError`, or make the Board gather rows per show so one bad config does not take down a registry's whole Board? |
| **H-15** | **`gateArtifacts` returns `[]` for a bible gate, because the bible gate's step id is the literal `"gate"`.** `console/server/gates.ts:75-111` switches on the eight episode gate ids and falls through to `default: return []` at `:109-110`; the interview's gate id is `"gate"` (`tools/src/init/interview.ts:74`). | `console/server/gates.ts:75-111`; `tools/src/init/interview.ts:74`; §4.3 | Does the Bible view reuse `GateView` (which also builds a 68-step `episodePipeline` at `console/server/gates.ts:130`) or get its own projection over `bibleFilePipeline`'s two steps? |
| **H-16** | **The drift today is 7 prompt files and 23 lines, and the bible cannot be baselined against a template at all.** Measured: 7 of 43 prompt files differ (`outline.md` 7 lines, `visual-direction.md` 6, `tts-script.md` 5, `environment-check.md` 2, `flow-check.md` 1, `nano-banana-gate.gate.md` 1, `nano-banana-gate.reject.md` 1); **all 15** bible files differ by design. `docs/plans/2026-10-04-the-cutover-deferred.md:55` says "nine files" — the measured count is **seven**. | `docs/plans/2026-10-04-the-cutover-deferred.md:55`; §6.7 | Where does a per-file baseline sha live, given `showrunner.json`'s thirteen top-level keys carry no manifest? And does the bible's baseline mean "the sha at import" rather than "matches the template"? |
| **H-17** | **Seven of the ten Board titles read as outline headings.** Measured in both repositories: `s01e01`, `s01e05`–`s01e10` carry `— OUTLINE`; `s01e02`–`s01e04` have no `outline.md` and fall through to the script heading. The derivation is `console/server/episodes.ts:17-28`. | `console/server/episodes.ts:17-28`; §6.8 | Leave it (the titles are the files' own first lines), strip a trailing `— OUTLINE` in the derivation, or edit ten archived files? Cosmetic either way. |
| **H-18** | **The `init` IO has never run on a TTY.** Every `terminalIO` test drives `Readable.from([block])` (`tools/test/init.test.ts:503-505`, used at `:510`, `:511`, `:520`, `:521`, `:531`, `:532`); the string `isTTY` appears nowhere in the repository. The two untested behaviours are readline's prompt redraw (`tools/src/init/main.ts:183-190`) and line editing inside a multiline continuation. | `tools/test/init.test.ts:503-505`; `tools/src/init/main.ts:183-190`; §6.4 | Does Plan H's surface replace the terminal path for the browser and leave the TTY check to the first real `init` (as `docs/plans/2026-10-03-the-new-show-setup-deferred.md:23` assigns), or does the console path make the terminal path dead code worth deleting? |
| **H-19** | **`tools/templates/prompts/tts-script.md:141` hard-codes `guest-refs` in prose while `engine/src/needs.ts:74-86` resolves it from `audio.guestRefsDir`** — byte-identical in the template and in the instance, at the same line number. A show that configures the key gets a prompt pointing one way and a probe checking another. | `tools/templates/prompts/tts-script.md:141`; `engine/src/needs.ts:74-86`; §6.5 | Does the line render `{{show.audio.guestRefsDir}}` (the template harness renders config values elsewhere, `docs/plans/2026-10-03-the-new-show-setup-deferred.md:14`), or does the key stay a defaulted convenience nothing but the probe honours? |
| **H-20** | **`publish-kit.py`'s reminder promises a substitution the script never performs, and the record's address is one line off.** `channel_name` is read at `scripts/publish-kit.py:90` and used **only** in the `filled` test at `:201`; `playlist_url` *is* written into the sheet at `:140`; the `print` is at `:202`. `publish.channelName` is `[YOUR NAME]` in both repositories. | `scripts/publish-kit.py:90`, `:201`, `:202`; §6.6 | Does `channelName` reach `upload.md`, or does the reminder stop promising that it will? Two tests pin today's behaviour (`scripts/tests/test_publish_kit.py:96`, `:104`). |
| **H-21** | **What Plan H does not take, restated so the plan can refuse it in writing:** the season map, the desk state, discuss, notes, and the standalone shot re-roll, ambient pass and casting-pile buttons — spec §7.2 (`docs/specs/2026-09-25-console-rewrite-design.md:199`) and `docs/plans/2026-10-02-the-console-deferred.md:52`. Re-roll and the ambient pass survive as gate rejections naming shot ids. The retired repository keeps the seven desk prompts (`docs/plans/2026-10-04-the-cutover-deferred.md:33`), which §2.6 measured as rendering cleanly — so the desk's prompts are not the thing blocking the desk. | spec `:199`; `docs/plans/2026-10-02-the-console-deferred.md:52` | Does Plan H state the refusal explicitly, so a later plan's author finds the boundary rather than inferring it? |

---

## 8 · How this inventory was taken

Commands and their outputs are quoted inline in §2–§6. The engine, tools and console were used as
already built at `engine/dist`, `tools/dist` and `console/dist` (every `dist/` is gitignored at
`.gitignore:2`, and the build on disk, 2026-10-04 16:54, postdates every source file in
`console/server/`, `console/worker/` and `console/src/`).

The read-only discipline, stated so it can be checked: `~/GitHub/DeadLight2` and `~/GitHub/DeadLight`
were read with `cat`, `grep`, `ls`, `diff`, `cmp`, `python3 -c` and the engine's own loaders, and
written by nothing. The one console pointed at a show repository (port 4413, against the instance)
served only `GET` requests and was stopped by pid. A second console (port 4414) ran against a scratch
show in the session scratchpad, never against a show repository, and was stopped by pid. Port 4400
(console v1, pid 3353) and port 5183 (its Vite server, pid 25817) were never signalled. After every
measurement, `git status --short` in `~/GitHub/DeadLight` showed the same two untracked files it
showed at the start (`Production/ep10/tts-script-v1-prepause.json`,
`Production/ep10/tts-script.json.bak-preop`) and `~/GitHub/DeadLight2` showed nothing.

Three claims in the records were measured as wrong or imprecise, and are corrected above rather than
repeated: the retired repository's desk prompts **do** render against
`tools/show-data/deadlight-check-context.json` (§2.6, against
`docs/plans/2026-10-04-the-cutover-deferred.md:33`); the template-to-instance prompt drift is
**seven** files, not nine (§6.7, against `docs/plans/2026-10-04-the-cutover-deferred.md:55`); and
`publish-kit.py`'s reminder sits at `:202` with the `filled` test at `:201` (§6.6, against
`docs/plans/2026-10-04-the-cutover-deferred.md:22`). One figure the brief asked for does not exist in
any record: the duration of Plan G's one real interview file (§3.6).

## 9 · Change log

- **2026-10-07 — created.** Inventory taken against `Showrunner` on branch `plan-h` at `12e2eaa`,
  `DeadLight2` at `c4c645f` and `DeadLight` (retired, `MrMophandle/DeadLight-v1`). Twenty-one
  findings, H-01 … H-21. Nothing in any repository was changed except this file.
