# Showrunner

A containerized web app for multi-show episodic video production — writing, canon
keeping, image and audio generation, assembly, and publishing, with the showrunner
ruling at every gate.

**Status: E1 in progress.** The scaffold stands — one container serving a hello page
on :4400, with the library volume mounted. The domain schema, runner, gates, and
event log are the rest of E1.

## Running it

```
docker compose up          # the app on http://localhost:4400
```

Everything durable lands in `./library` on the host — `showrunner.db` plus artifacts
as plain files (D2). The directory is gitignored; compose creates it on first run.

Working on it without the container:

```
npm install
npm run build              # the SPA
npm start                  # the app process on :4400
npm run dev:web            # the SPA with HMR on :4401, API proxied to :4400
npm test && npm run typecheck   # CI — run both before claiming done
```

Node 24+ is required: the server runs its TypeScript directly, and SQLite comes from
`node:sqlite` rather than a native module. GPU steps will run on a native Mac worker
outside the container (D5) — nothing GPU-related belongs in compose.

## Where things are

| Path | What |
|---|---|
| `handoff/docs/README.md` | **Start here.** Index of the design docs, what's authoritative, and how to write an epic's issue file. |
| `handoff/docs/concept-and-architecture.md` | The ruled design — domain, orchestration, canon, checks, screens, build plan. Decisions D1–D24. |
| `handoff/docs/D20-image-backends.md` | Image generation in detail, carried forward from the Dead Light console. |
| `mockups/` | Eight approved screen mockups + their README. Serve that directory and open the floor screen — instructions in `mockups/README.md`. |

Work is tracked in [GitHub Issues](https://github.com/MrMophandle/Showrunner/issues),
one milestone per epic. **E1 · The spine** is issues #1–#9.

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
