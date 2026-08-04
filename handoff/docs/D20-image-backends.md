# D20 · Image generation — two backends, routed per shot

**Status: RULED — approved by Ryan 2026-08-03, no notes.** On the open retry
question he ruled: **2 auto-retries before it reaches him** — the invariant
holds unchanged. Raised after checking the Dead Light console for carry-forward.

## What the old console does (verified in `DeadLight/.archon/`)

Two image paths, chosen **per shot** from the shot manifest (`prompts.json`):

| Shot type | Backend | Where | Notes |
|---|---|---|---|
| `character` | **Nano Banana Pro** (`gemini-3-pro-image`, Gemini API) | cloud | conditioned on the subject's locked reference sheet + 2 newest approved pile stills; 2K 16:9; vision-audited by Claude headless; ≤3 attempts with corrective notes; hard cost cap per run (60 calls ≈ $8) |
| ambient (default) | **Z-Image-Turbo** (mflux) | local GPU | seeded, ~2.4 min/img — establishing wides, backgrounds, one-offs, suited figures at distance |
| `hero`-tagged | **Qwen-Image-Edit** (mflux, Apache-2.0) | local GPU | conditioned on locked baseline refs to carry a recurring subject's identity; ~11 min/img, 38 GB peak; falls back to ambient if the baseline isn't locked yet |

Operational rules that made it work:

- **Cloud parallel, local serialized.** Nano Banana holds no GPU, so it runs in
  parallel with the audio branch. Local image gen and TTS both hit Metal —
  running them concurrently corrupted TTS synthesis (ep04, 2026-07-25) — so they
  share one GPU serialization.
- **A hand-made shot always wins.** Existing PNGs are never overwritten;
  idempotent re-runs only fill gaps. Re-rolls are explicit (delete / `--only`).
- **Rejection is targeted.** Reject with shot ids + notes → only those shots
  re-roll, notes fed as corrective feedback. A canon-level miss (scale, anatomy,
  presentation) also fixes the subject's identity text in canon so future
  episodes inherit the fix.

## What Showrunner's ruled design already covers

- D5: native Mac GPU worker; `gpu` is a named lock → home for the local backends.
- D7: `image-api` named lock → arbitration for the cloud path.
- 3.1: locked/aspirational references · 5.5: promote-to-pile feeds candidate refs.
- 4.2/4.4: image checks flag for Ryan's eye; bounded correction loop.
- 2.4: per-call cost capture; budget per show.

## The gap — not ruled anywhere

1. **No image analog of D6.** Proposed: one `ImageAdapter` interface, three
   backends (`nano-banana-pro` cloud, `z-image-turbo` local, `qwen-image-edit`
   local), with routing declared per shot in the shot manifest
   (`character` / ambient / `hero: [subjects]`). Backends are code, not config
   (Archon rule); adding one is an engineering change with a test.
2. **Lock semantics.** Cloud image steps take `image-api` only; local image
   steps and TTS take the same `gpu` lock (the Metal-corruption lesson).
3. **Hand-made-wins idempotence** as a stated invariant of the media line.
4. **Retry bound — ruled.** 2 auto-retries max, then it reaches Ryan; the
   old console's 3-attempt allowance does not carry forward.
5. **Vision-audit placement.** The old audit-then-queue behavior maps to: an
   image check that can auto-retry the producing step, whose surviving output
   still queues for Ryan's eye — never rendered as a green checkmark.

## Consequence

The content above seeds the E6 issue files (shot manifest schema, ImageAdapter,
GPU worker contract, review desk re-roll flow).
