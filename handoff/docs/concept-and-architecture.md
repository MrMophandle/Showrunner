# Showrunner — Concept & Architecture

Ruled Aug 3, 2026 — all six sections and decisions D1–D19 approved by Ryan.
(Markdown export of the design engagement's ruled document.)

## Section 1 · The domain model

Three families: the **spine** (what you make), **canon** (what is true), **production**
(the machinery that turns one into the other under the showrunner's rule).

### 1.1 The spine — Show → Season → Episode → Scene
- **Show** owns its canon store, check categories, and house style. Everything below is
  scoped to it — no hardcoded show/season anywhere. The canon store's shape is a
  documented, versioned schema shipped with the app, so a new showrunner can point a
  Claude session at it and populate a fresh show.
- **Arc** — first-class, with a *scope* (show or season) and *kind* (character or story).
  Episodes record *touches* against arcs; an episode touching none is **vanilla** —
  legal, tracked, never a failure state.
- **Season** carries story arcs, ordered episodes, and its *idea pool* (premises
  greenlit / parked / spiked).
- **Episode** tells its own story; unit of production. Lifecycle: premise → outline →
  script → assets → assembled → published. Canon conflicts are flagged during outline
  and script work and surface at those gates.
- **Scene** — first-class and addressable, but **derived, never prescribed**. The writer
  writes the episode; scenes are delineated where the story breaks. num_scenes is an
  output of the episode, never an input to the writer. Scenes anchor findings, own
  their images/audio, and scope re-checks.

### 1.2 Canon
- **Category** — a kind of canon (character, location, faction, species, technology,
  timeline, house style, world rules). Defined as data: fields, applicable artifact
  kinds, check instructions. Adding a category is an edit, not engineering.
- **Entity** — one instance. Skeleton (see 3.1): identity + standing, prose body,
  facts with lineage, references, relations.
- **Proposal** — the only way canon changes. Anatomy (five parts): the change
  (entity + fact, before → after); usage context (script excerpt, lines either side);
  implications (blast radius across facts, arcs, prior episodes); alternatives; origin
  & disposition (who raised it, Ryan's ruling + notes, kept forever). Provisional
  until ruled — visible to checks so scene 9 can't contradict what scene 4 established.
- **Ratification** — a proposal becomes canon when Ryan approves it at its gate. A
  completion sweep at episode approval turns implicit established facts into proposals
  for one last ruling. Facts carry lineage (episode, gate, date) so an abandoned
  episode's facts can be surgically reverted.

### 1.3 Production
- **Artifact** — anything produced (outline, script, scene text, shot image, TTS take,
  mix, timeline, render, publish kit). Carries provenance (entities touched), a
  version, and freshness edges ("this mix was built from script v4; script is now v6").
  Staleness is computed, never remembered.
- **Run / Step** — a pipeline stage in motion. Steps are code (no DSL); state persists;
  crash resumes.
- **Gate** — first-class decision object: artifact under review, findings, round
  history, ruling (approve / reject-with-notes / override-with-record). Gates render
  their artifact — always.
- **Check / Finding** — one reviewer pass, parameterized by canon category, fired at
  artifact boundaries. Findings are structured: anchor, concern, severity, confidence,
  remediation actions. Failed checks auto-retry the producing step at most twice.

### 1.4 Invariants
1. Only ratification writes canon; everything else proposes.
2. Every artifact declares provenance; checks load exactly the entities in scope.
3. Checks argue, never veto — approval over a red finding is a recorded override.
4. Honest confidence: text gates hard, image flags, audio queues a listen.
5. Nothing runs without a click; retries bounded, history shown.

### Decisions
- **D1 · Name:** Showrunner — github.com/MrMophandle/Showrunner.
- **D2 · Storage/deployment:** containerized; SQLite for structure + plain files for
  heavy artifacts on a mounted volume, human-readable and git-versionable.
- **D3 · Scene first-class:** yes — derived from the written episode, never prescribed.
- **D4 · Facts vs. prose:** both layers — prose for generation context, extracted
  facts with lineage for checking.

## Section 2 · Orchestration — the boring runner

**The Archon rule (binding):** no workflow DSL, no configurable workflow engine.
Stages are TypeScript code. If either party proposes one, the other says "Archon."

### 2.1 Shape
One app process: web UI, API, SQLite, runner, SSE event stream. No broker, no job
queue service. Stages (write, produce, canon, assemble, season review) are TypeScript
functions; changing one is a code change with a test.

### 2.2 Four primitives
- **Run** — one stage executing against one episode/season; owns steps, gates, cost, history.
- **Step** — one unit of work (LLM call, image gen, mix, render). Declares inputs and
  outputs, idempotent, records what it consumed for freshness computation.
- **Gate** — a run paused on a decision object; resumes only on Ryan's ruling.
- **Event** — append-only log of every transition; drives the live UI and is the audit trail.

### 2.3 Execution semantics
- **Preconditions before the button** — evaluated live to set button state; blocked
  actions show the reason in words.
- **No "Launch"** — verb + object + scope + cost on every button, always.
- **Per-episode serialization, cross-episode parallelism** — named locks for scarce
  resources (GPU, image API); contention shows as "waiting on GPU (held by ep05)".
  → **Amended by D20:** `gpu` covers local image generation *and* TTS (they must never
  run concurrently); `image-api` covers cloud image steps, which parallelize with audio.
- **Bounded self-correction** — failed check re-runs the step with findings as notes,
  max twice, then reaches Ryan with the loop history.
- **Crash-proof** — step state persists before/after; killed process resumes; open
  gates survive reboots.
- **Streams, not spinners** — long steps stream output live.

### 2.4 Cost ledger
Every LLM call and generation records tokens/dollars against step, run, episode,
show. Projected cost on buttons; burn per episode and per period visible.

### 2.5 Deployment
One `docker compose up`: app container + mounted volumes. GPU-bound steps run on a
native worker (Macs can't pass the GPU into containers).

### Decisions
- **D5 · GPU:** (a) tiny native Mac worker the container calls; GPU is a named lock.
- **D6 · Claude access:** one adapter, both backends — Anthropic API and `claude` CLI.
- **D7 · Parallelism:** confirmed — assembly line across episodes, locks arbitrate.

## Section 3 · The canon system

### 3.1 Anatomy of an entity
- **Identity** — id, name, aliases, category, status (active/historical/candidate),
  and **standing**: core (always loaded as writer context) / recurring / one-shot
  (keeps its full sheet) / retired (reappearance is a finding). Standing is declared
  intent; appearance history is computed from provenance.
- **Prose body** — the rich sheet that makes LLM drafts good; sectioned per category fields.
- **Facts** — atomic checkable statements: statement, field, lineage (established-in,
  ratified-at), status (ratified/provisional/reverted).
- **References** — locked reference images, voice clips, style boards; each marked
  locked or aspirational.
- **Relations** — typed edges (member-of, located-in…). Makes blast radius computable.
  → **Amended by D23:** relation types are *declared per category* (name, target category,
  cardinality, inverse name); an undeclared type is invalid.
  → **Amended by D22:** every character declares a `species` relation — required, exactly
  one; the species' facts load into check scope with the character.

### 3.2 Categories as data
A category declares: name, structured fields (which are checkable), applicable
artifact kinds, and check instructions — **and, per D23, its allowed relation types.** Ships with: characters, locations, factions,
species, technology, **timeline** (ordered events), **house style** (narrator voice,
pacing, content constraints), **world rules** (physics/environment invariants —
space-not-sea, vacuum requires suit or containment field, sound doesn't carry
outside the hull).

### 3.2b The continuity board (blocking)
Every script derives a continuity board: per scene — location, characters present,
environment state (suited/inside/exposed), ship position, elapsed time. LLM extracts;
the worst bugs are then caught deterministically: dual presence, impossible adjacency
(spacewalker tapping a shoulder on the bridge), duplicate arrivals, vacuum without
protection. Doubles as the human-readable scene grid.

### 3.3 Proposal lifecycle
raised → provisional (rides its episode, visible to checks) → ruled at gate →
ratified / rejected / deferred.
- Raised by: Ryan, a writer agent mid-draft (flagged, surfaces at the script gate),
  a check remediation, or the completion sweep.
- Rejected proposals keep their notes — future writer runs see why Trent stays mortal.
- Deferred parks a proposal (stops riding the episode, invisible to checks).
- Reverting: an abandoned episode's ratified facts are flagged for revert rulings,
  one by one.

### 3.4 Contradiction detection
- **Structural** (deterministic, free): dependency lighting, timeline violations,
  orphaned relations, locked-reference conflicts.
- **Semantic** (LLM at artifact boundaries): category check reads the artifact with
  exactly the in-scope facts loaded.

### 3.5 Schema doc & the empty-show story
The store's shape ships as a versioned schema document. New show: create → pick
categories → hand schema doc + source material to a Claude session → it drafts
entities as candidates → showrunner promotes. Migration is the same pipeline pointed
at the old repo.

### Decisions
- **D8 · Arcs:** ordered waypoint sequences on the arc ("distrusts → listens but
  double-checks → trusts"); episodes declare positions ("arc1 @ waypoint2"); behavior
  ahead of/behind the waypoint is a finding; landing a waypoint becomes a fact via
  the proposal flow.
- **D9 · Versioning:** point-in-time reads — facts append-only with validity ranges.
- **D10 · House style is a canon category**; world rules follow the same pattern.

## Section 4 · The check system

### 4.1 When checks fire
At artifact boundaries, never continuously. Boundary events: outline lands, script
draft lands, scene edited (scene-scoped re-check), continuity board rebuilt, image
generated, take produced, mix completed. Artifact kinds × category declarations
decide what fires. Scope comes from provenance.

### 4.2 Three tiers, honestly
- **Deterministic** — continuity board + canon graph checks. Free, certain, gate hard.
- **Text vs. text** — script against facts, waypoints, world rules, house style.
  Strong; high confidence; self-corrects before reaching Ryan.
- **Media vs. reference** — image checks flag for his eye; audio checks verify words
  only and queue a listen. Never rendered as a green checkmark.

### 4.3 Anatomy of a finding
Anchor (exact span/scene/shot/take — clicking lands on the material, highlighted) ·
concern (entity + fact with lineage, quoted) · severity & confidence (both shown,
never collapsed) · remediations as buttons: rewrite the span (pre-drafted, editable),
propose the canon change, dismiss with note (recorded).

### 4.4 The correction loop
Failed check → producing step re-runs with findings as rejection notes, max twice,
every attempt kept. The gate shows artifact + loop history. Dismissed-finding and
rejected-proposal notes feed future runs' context.

### 4.5 Panels
A gate can convene several category checks + craft reviewers (pacing, dialogue, hook)
as one verdict board; findings cluster by anchor. The **story-craft reviewer** is
mandatory equipment: genre story shapes, trope usage (knowing vs. cliché),
setup/payoff discipline.

### 4.6 The HIL contract
Wherever the system defaults to the human: everything pertinent, present, zero
archaeology. Image review = image (full-screen), script location, generating prompt,
canon references, and change actions in place. If Ryan has to go find context, the
screen has failed.

### 4.7 The final gate
Non-delegable: the listen-through/watch-through of the assembled episode. Approve
(ratification sweep, clear for publish) or reject with notes. Rejection is **routed,
not rewound**: each note targets a depth (premise / scene rewrite / new image / new
take); the freshness graph regenerates only what must.

### Decisions
- **D11 · Reviewing the reviewers:** Ryan is the final gate; beneath it, cried-wolf
  tracking per check surfaces "tune this check?" maintenance prompts.
- **D12 · Deterministic findings** block the next stage but never Ryan's gate.
- **D13 · Craft reviewers ship in v1**, including story-craft.

## Section 5 · Screens & information architecture

Seven screens; the organizing principle: the app always knows what needs Ryan.

- **5.1 The floor (home)** — one row per in-flight episode, lifecycle as a track,
  "needs you" loud (open gates, queued reviews, blocked-with-reason). Health strip
  (adapter, GPU worker, output volume, budget). Couch-glanceable.
- **5.2 The episode room** — stage rail (legal next actions as full-sentence buttons
  with cost; everything else visibly blocked with reason), scene grid (continuity
  board as UI), artifacts with freshness ("built from script v4, now v6"), pending
  proposals, findings, arc positions, episode cost ledger. Direct scene editing (D14).
- **5.3 The gate room** — dedicated page (D15). Artifact rendered full-height, verdict
  board, findings inline at their anchors, proposals with five-part anatomy, round
  history (stale verdicts marked "from before your last rejection"), decision dock.
- **5.4 The canon library** — browse by category; entity pages (prose, facts with
  lineage, references, relations graph, computed appearances, standing, arcs);
  proposal queue; timeline; point-in-time reads; candidates visibly unofficial.
- **5.5 The review desk** — HIL queues as flow state: one at a time, full context per
  the HIL contract, keyboard-driven, resumable. One artifact, one ruling (approve /
  recreate / reject) — never batch. Promote-to-pile is a tag during review (exclude
  by default); tagged images become candidate canon references via proposals.
  Voice casting queue: listen before locking; locked voice becomes a canon reference.
  → **Amended by D21:** *reject* is routed, not rewound — the note picks its depth
  (the shot's prompt / the scene / hold the slot for a hand-made still).
- **5.6 The screening room** — the final gate as a place: assembled episode + synced
  script; drop notes at timestamps; each note binds to the scene/shot/take under the
  playhead and carries routing depth. One ruling at the end.
- **5.7 The season map** — episodes as columns, arcs as rows, waypoints plotted;
  vanilla episodes visibly vanilla; hanging-thread detection (time since arc last
  touched vs. next waypoint, long gaps loud); the idea pool; "pitch a premise against
  canon" runs checks against an idea pre-episode.
- **5.8 The arc page** (added by D24) — an arc's own screen, reached from the season
  map's arc names and the canon library: prose statement (what the arc is, the question
  it asks), ordered waypoints each with meaning + what landing looks like, entities and
  episodes involved, how the arc is checked (D8 with a worked example), edit history.
  **The screen set is eight, not seven.**

Killed: the old Discussion feature (no run-state visibility) — its job is covered by
rejection notes with visible loop state and direct scene edits. Publish destination
is per-show configuration. Show switcher stays a menu until show #2. v1.1: the
writers' room (full-season layout screen), deferred until S2 planning.

### Decisions
- **D14 · Scripts directly editable** in the episode room; edits mark downstream
  stale and trigger scene re-checks.
- **D15 · Gate room is a dedicated page.**
- **D16 · Mockup order:** floor → episode room → gate room → review desk →
  screening room → canon library → season map.

## Section 6 · Build plan

### 6.1 Working agreements
One issue = one Opus session with context-to-load, deliverable, machine-checkable
done-condition. Repo CLAUDE.md carries the invariants. Fixtures before features
(Grey Harbor fixture show). Ryan gates epics, not issues.

### 6.2 Epics
- **E1 · The spine** — scaffold, domain schema, runner (run/step/gate/event,
  crash-resume, locks), Claude adapter, cost ledger, fixture. Ends: two-step run
  operated end-to-end incl. kill-and-resume.
  → **DONE, Aug 5 2026.** Issues #1–#9 merged, and the exit was operated rather than
  simulated: a run survived `SIGKILL` with its gate open and finished on one model call.
  The drill is in the root `README.md`; what it built is mapped in `docs/README.md`.
- **E2 · Canon** — entities, categories, proposals, ratification, point-in-time,
  arcs/waypoints, schema doc. Ends: create entity, rule a proposal, query "canon as of."
  → **DONE, Aug 7 2026.** Issues #23–#29 merged, D25 ruled (canon founded by proposals,
  never imported), and the exit operated: Ryan founded Grey Harbor from the bench,
  promoted and created entities by ruling, changed a ratified fact by a second proposal,
  and watched canon-as-of flip across his own ruling on the ledger.
  → **Scope grew (D22, D23):** per-category relation-type declarations with inverses;
  required `species` on characters; species facts loading into check scope with their
  members; inherited facts edited at the species, individual exceptions naming what they
  override. Arc statements + per-waypoint landing criteria (D24) are E2's to author-edit,
  though the tables are E1-2's.
- **E3 · Checks** — generic checker, findings, continuity board + deterministic
  checks, correction loop, panels + story-craft, cried-wolf tracking. Ends: planted
  contradiction produces an anchored finding whose rewrite remediation fixes it.
- **E4 · The writing line** — premise → outline → script with scene delineation,
  writer context assembly, outline/script gates, direct editing + staleness. Ends:
  full fixture episode written incl. a rejection round-trip.
- **E5 · The cockpit** — the screens, built to the approved mockups in `mockups/`.
  Ends: E4 run entirely from the cockpit, from the couch.
  → **Scope grew (D24): eight screens, not seven** — the arc page is the eighth.
  All eight mockups are approved and in the repo; see `mockups/README.md` for the
  screen→epic map and for design intent ruled but not rendered.
- **E6 · The media line** — shot manifests, GPU worker, image gen, TTS + mix, review
  desk, image checks, timeline + render, screening room, publish kit + configurable
  destination. Ends: fixture episode premise → watchable file.
  → **Scope grew (D20, D21):** one `ImageAdapter` with three backends routed per shot
  (see `D20-image-backends.md` for the full carry-forward from the Dead Light console,
  including the operational rules that made it work); routed reject at the review desk.
- **E7 · Dead Light moves in** — canon import (facts extracted, reviewed), eps 1–4 as
  published history, in-flight episode at its true position, arcs reconstructed.
  Old repo read-only forever. Ends: a real S1 episode finished on the new platform.
- **E8 · Ernie-readiness** — compose-up from fresh clone, first-run setup, empty-show
  onboarding, operator docs. Ends: a new show created by someone who isn't Ryan.

### 6.3 Sequencing
E1–E3 are the risk — each ends operated, not read about. Mockups run ahead of E5.
Dead Light ships on the old stack until E7. Issue files are written epic-by-epic,
just before each epic starts.

### Decisions
- **D17 · E1→E8 as ordered.**
- **D18 · GitHub Issues** on MrMophandle/Showrunner, one milestone per epic.
- **D19 · Next:** E1 issues first, mockups in parallel.

## Addendum · rulings after the export

- **D20 · Image generation backends** (ruled Aug 3, 2026): one `ImageAdapter`,
  three backends carried forward from the Dead Light console — Nano Banana Pro
  (Gemini API, cloud) for character shots; Z-Image-Turbo (local GPU) for ambient
  shots; Qwen-Image-Edit (local GPU) for hero/identity shots. Routing is declared
  per shot in the shot manifest. Cloud steps take the `image-api` lock only and
  parallelize with audio; local image gen and TTS share the `gpu` lock (Metal
  corruption lesson). A hand-made shot always wins — existing files are never
  overwritten. Image-check auto-retries bounded at 2, then the shot reaches Ryan.
  Full detail: `D20-image-backends.md`.
- **D21 · Review-desk reject is routed, not rewound** (ruled Aug 3, 2026): the
  three shot-image rulings are approve · recreate-with-notes (re-roll now, note
  as corrective feedback) · reject-with-note, where the reject note picks its
  depth — rewrite the shot's prompt in the manifest, send the scene back to
  writing, or hold the slot for a hand-made still (which always wins, per D20).
  Nothing regenerates until the route lands. Extends 4.7's routing rule from
  the screening room down to the review desk.
- **D22 · Every character declares a species** (ruled Aug 3, 2026): species is a
  required identity field on the character category — a typed relation to an
  entity in the Species category, not free text. Consequences: (a) the species'
  facts load into check scope whenever that character is in scope, so world-rules
  and physiology checks can actually fire on a character ("vacuum without
  protection" only catches Ferro if something says what Ferro is); (b) editing an
  inherited fact edits the species and every member inherits it — an individual
  exception is a fact on the character that names what it overrides; (c) an
  unknown species is declared explicitly as `unknown` (legal, tracked — e.g. a
  candidate like the Passenger), never left blank. Non-character categories are
  unaffected. Gap found while reviewing the canon-library mockup: 3.2 shipped
  Species as a category but nothing linked a character to one.
- **D23 · Relation types are declared per category** (ruled Aug 4, 2026): a
  category declares its allowed relation types the same way it declares fields —
  data, not code. Each declaration carries: the type name, the target category,
  cardinality (and whether required), and its **inverse name**, so an edge is
  navigable and blast radius computable from both ends. The app ships a sensible
  default set per category; adding one is an edit, not engineering (consistent
  with 3.5). A relation whose type isn't declared by the category is invalid —
  free verbs are rejected, because a checker can't traverse what it can't
  interpret. D22's `species` is the first such declaration: target Species,
  required, exactly one. Gap found when Ryan asked what the mockup's invented
  `keeps` relation meant — 3.1 listed "member-of, located-in…" and never said
  who owns that list.
- **D24 · Arcs get their own page** (ruled Aug 4, 2026): an arc is a first-class
  object with no home in the seven screens — it appeared only as a row on the
  season map and a chip on entity pages, so nothing anywhere said what an arc
  *is*. An arc page is added, reachable from the season map (click the arc name)
  and the canon library (an Arcs section beside the categories). It carries: a
  prose **statement** (what the arc is about and the question it asks — authored
  by Ryan, the thing you re-read when you've forgotten); the ordered waypoints,
  each with what it means, **what landing it looks like**, which episode holds
  it, and the facts ratified when it landed; the entities involved; episodes
  touching it; how the arc is checked (D8 semantics, with an example finding);
  and an edit history including waypoint renames with their notes. Waypoints are
  editable and insertable — inserting re-checks episodes that declare a later
  position. Gap found when Ryan said he'd forgotten what "The beacon" was and
  had nowhere to look.
- **D25 · Canon is founded by proposals, never imported** (ruled Aug 6, 2026):
  there is no import path that writes ratified facts directly — not for the
  fixture, not for E7's Dead Light migration, not for E8's empty-show onboarding.
  Bootstrap canon enters as **promotion proposals** (an entity's full initial
  sheet as the change) raised by loaders and ruled through the same ruling API
  Ryan uses; tests exercise that API rather than bypassing it. Invariant 1 stays
  whole with no carve-outs, and E7's import becomes bulk *raising* plus efficient
  ruling surfaces rather than a sanctioned breach. Ruled while filing E2's
  issues; enforced by E2-2 (issue #25) and exercised by E2-4 (issue #27).
