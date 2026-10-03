# {{show.showName}}

This repository is the show. Everything that makes {{show.showName}} what it is lives here — the bible, the episodes, the prompts the agents run, and the generated production files. The engine that runs the pipeline lives in a separate repository and contains nothing about this show: it reads `showrunner.json` and the prompts in `prompts/` and does what they say. One engine, many shows.

## The layout

| Path | Holds |
|---|---|
| `showrunner.json` | The show's config: its name and slug ({{show.showSlug}}), the model tiers, the directory names, the audio, visual, video and publishing settings every step reads. |
| `Canon/` | The bible — the premise, the arc, the voice, the look, the laws, the ledger — plus one sheet per recurring character, species, location and faction. `Canon/README.md` is its index. |
| `Episodes/` | One directory per episode: the premise, the locked beats, the outline, the script. `Episodes/_TEMPLATE/outline.md` is the format an outline must take. |
| `Production/` | Everything generated: the TTS manifest, the audio, the images, the video timeline, the publish kit. Binaries are gitignored and regenerable; manifests are committed. `Production/setup/` holds the record of the bible interview. |
| `Production/voice-refs/refs.json` | Every voice the pipeline can speak with. A character is castable once its entry's status contains LOCKED. |
| `Canon/refs.json` | Every recurring subject's reference image. A subject is castable once its reference exists on disk. |
| `prompts/` | Every agent prompt the pipeline runs, one file per step. These are yours to edit; the engine only reads them. See `prompts/README.md`. |
| `.gitignore` | Derived from the directory names in `showrunner.json`, so generated binaries stay out of git. |

## Your first episode

**1. Write the premise.** Create `Episodes/s01e01/premise.md` and write three sentences: what happens, whose episode it is, and what it must pay. That is the whole input the pipeline needs to begin — the outline agent turns it into beats, and every later step works from what the step before it produced.

**2. Lock the beats, if you want to.** `Episodes/s01e01/locked-beats.md` is optional, and binding where it exists: anything you write there the outline may not change. Leave it out and the outline agent decides the beats itself, and you approve or reject them at the outline gate.

**3. Launch it.** Start the console from the engine repository and point it at this directory:

```
node console/dist/server/main.js --show <this directory> --engine-root <the engine repository>
```

Open it in a browser, find the episode, and press **Launch**.

**4. Expect to stop at NEEDS_REFS.** The first run halts before it can make audio or images, because a new show has no cast on file. The run stops at `NEEDS_REFS` until **every speaking recurring character has a locked voice** in `Production/voice-refs/refs.json` and **every recurring subject has a reference image** in `Canon/refs.json`. The stop names exactly who is missing. Two scripts are how you clear it:

```
uv run scripts/design-voice.py      # auditions a voice and writes its refs.json entry
uv run scripts/design-visual.py     # makes candidate images; you pick one and commit it as the ref
```

This stop is deliberate. A voice and a face are decisions a person makes by ear and by eye, and the pipeline will wait for you rather than invent them.

## Two conventions the pipeline reads by machine

A change to either of these breaks the pipeline and not merely a prompt.

**The outline's `## Cast` section is the pipeline's NEEDS_REFS source**: every line in it reads `- <Name> (<tags>)`, tags drawn from `recurring`, `guest`, `speaks` and `location`, and `parseCastSection` in the engine's `engine/src/needs.ts` silently ignores any line in the section that does not match that grammar.

**The shot list's `source` field is the pipeline's NEEDS_IMAGES source**: each shot in `Production/<episodeId>/images/prompts.json` is `"pipeline"` (the default, and what the generators make) or `"showrunner"` (a shot the showrunner makes by hand, which no generator touches and which holds the run at NEEDS_IMAGES until its PNG is on disk).

## After editing the bible

Run `bible-check --show <this directory>`. It names every bible file that is missing or empty and every section a prompt reads by name that the file does not carry. A prompt that reads an absent section gets a silent partial read, which is the one failure that does not announce itself, so check after every edit to `Canon/`.
