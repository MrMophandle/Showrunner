# CLAUDE.md — Showrunner

You are building Showrunner: a containerized web app for multi-show episodic video
production. Read `docs/concept-and-architecture.md` for the full ruled design (D1–D19
all approved by Ryan, the showrunner). This file is the distilled standing brief.

## The domain in one breath
Show → Season → Episode → Scene. Shows own canon (an approval-gated store of what is
true). Episodes move through a lifecycle: premise → outline → script → assets →
assembled → published. Checks compare artifacts to canon at artifact boundaries and
raise findings. Ryan rules at gates. Only ratification (his ruling) writes canon.

## Invariants — never violate
1. **Only ratification writes canon.** Everything else proposes. Not agents, not
   remediations, not the runner.
2. **Every artifact declares provenance** (which canon entities it touches); checks
   load exactly the entities in scope, never the whole bible.
3. **Checks argue, never veto.** A red finding makes an artifact loud; Ryan's approval
   over it is recorded as an explicit override. One exception (D12): deterministic
   findings (continuity-board contradictions) block the *next stage* but never his gate.
4. **Honest confidence.** Text checks gate hard; image checks flag for his eye; audio
   checks queue a listen. Never render a weak check as a green checkmark.
5. **Nothing runs without a click.** Retries are bounded at 2, with attempt history shown.

## The Archon rule
No workflow DSL. No configurable workflow engine. Pipeline stages are TypeScript
functions in this app. If you find yourself building a generic/configurable workflow
system, STOP — that is the failure mode this project exists to escape.

## UI rules
- **No generic buttons.** Every action button: verb + object + scope + cost.
  "Write the ep07 outline — 1 Opus call, ~$0.85". Never "Launch", "Run", "Do".
- Preconditions are evaluated *before* the button renders — a blocked action shows
  as disabled with the reason in words, never as a failure after launch.
- One artifact, one ruling — media review is one-at-a-time, no batch verdicts.
- Gates always render the artifact under review (readable script, viewable image,
  playable take) — never a filename.
- Run state is always visible: what's thinking, what changed, what's waiting on Ryan.
- Every screen has an honest empty state at every production stage.

## Architecture rulings (from the concept doc)
- Container app (docker compose), SQLite for structure + plain files for heavy
  artifacts on a mounted volume (D2). Native Mac GPU worker for GPU steps (D5).
- One LLM adapter, two backends: Anthropic API and `claude` CLI (D6).
- Per-episode serialization, cross-episode parallelism, named resource locks (D7).
- Scenes are first-class but **derived from** the written episode, never targets the
  writer fills — num_scenes is an output, not an input (D3).
- Canon entities: prose body + extracted facts with lineage; facts append-only with
  validity ranges; point-in-time reads supported (D4, D9).
- Arcs carry ordered waypoints; episodes declare positions ("arc1 @ waypoint2") (D8).
- Events are append-only and drive the UI via SSE; crash-resume from last completed step.

## Working agreements
- One issue, one session. Leave the repo green; if unfinished, write `HANDOFF.md`.
- Fixtures before features: the Grey Harbor fixture show (E1-7) backs all tests —
  never burn real generation money in tests.
- Issues live in GitHub Issues, one milestone per epic (E1–E8).
- Dead Light (Ryan's live show) ships on the old stack until E7 migration; the old
  repo is read-only, forever.
