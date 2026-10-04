import path from "node:path";

/** The three facts about a show that nothing can be derived from and nobody can be interviewed
 *  about: what it is called, the one-word name its files are named with, and where its finished
 *  video lives. Everything else in `showrunner.json` is either a house default or derived from
 *  these three, which is why they are the only arguments `buildShowConfig` takes besides the cast.
 *
 *  `showSlug` names files on disk and in the NAS tree (`output.mixFilename` renders `{slug}`), so
 *  it is letters and digits only; `init` validates it before it reaches here. `nasRoot` is an
 *  absolute path on the author's machine — the show's directory on the NAS, whose parent becomes
 *  `output.nasMount`, the mount the episode pipeline's NAS guard checks for. */
export interface ShowIdentity {
  showName: string;
  showSlug: string;
  nasRoot: string;
}

/** A new show's `showrunner.json`, carrying every key in `SHOW_CONFIG_KEYS` — the engine's own
 *  measured list of what its readers and the Python steps read — with a value for each.
 *
 *  It exists because the keys were previously discoverable nowhere but in the readers, so a new
 *  show's config could only be written by copying an existing show's and editing it, which is how
 *  one show's settings became another show's defaults. Here, every value is one of three things
 *  and the difference is deliberate:
 *
 *  1. **Derived from the identity**: `showName`, `showSlug`, `output.nasRoot`, `output.nasMount`
 *     (the NAS root's parent), `video.titleCard.text` (the name in upper case),
 *     `publish.playlistName`, `publish.standingCopy.weekly` and `audio.mainCast` (the narrator
 *     plus the cast the `world-overview` interview recorded).
 *  2. **Left empty, because a new show cannot know it yet**: `publish.playlistUrl`,
 *     `publish.tags`, `visual.ambientPromptScaffold` and `airMap`. Inheriting another show's value
 *     for any of these is worse than an empty one: a wrong playlist, another show's genre tags, or
 *     another show's prompt scaffolding on every image.
 *  3. **A house default**: the model tiers, the directory names, the filename patterns, the audio
 *     numbers, the frame size and the loudness targets. These are the engine's and the scripts'
 *     own operating points rather than anything about a particular show, and an author who wants
 *     different ones edits `showrunner.json`, which is one file and is read by everything.
 *
 *  The four directory keys are written unconditionally and `init` exposes no flag for them: the
 *  prompt templates still carry literal `Canon/` paths in seventeen places, so a show that renamed
 *  its canon directory would fail silently at the first prompt that read one.
 *
 *  `airMap` is `{}` and that is the only honest value for a new show. It maps a *production* id
 *  (`epNN`) to `[season, episode]` for episodes that aired before the rename to the `sXXeYY`
 *  grammar; `loadShowConfig` refuses any key in it that is not a production id, and `seasonOf`
 *  reads an aired id's season off the id itself and never consults the map. A show that starts at
 *  `s01e01` therefore has nothing it could legally or usefully put there.
 *
 *  Returns a plain record rather than a `ShowConfig` because it is written as JSON and read back
 *  through `loadShowConfig`, which is the validator: `init` writes the file and then loads it, so
 *  the config every later step uses has been through the same door a show's own config goes
 *  through.
 *
 *  `cast` is the recurring cast's names, which the config needs for `audio.mainCast` — the speaker
 *  keys a TTS manifest may use without a guest voice reference on disk. It is empty when `init`
 *  first writes the file, because the cast is not known until the `world-overview` interview is
 *  answered; `init` rewrites that one key afterwards. */
export function buildShowConfig(id: ShowIdentity, cast: string[]): Record<string, unknown> {
  return {
    showName: id.showName,
    showSlug: id.showSlug,
    promptsDir: "prompts",
    canonDir: "Canon",
    episodesDir: "Episodes",
    productionDir: "Production",
    models: {
      small: "claude-haiku-4-5",
      medium: "claude-sonnet-5",
      large: "claude-opus-4-8",
      writer: "claude-fable-5",
    },
    airMap: {},
    output: {
      nasMount: path.dirname(id.nasRoot),
      nasRoot: id.nasRoot,
      finalFilename: "{slug} S{season:02d}E{episode:02d}.mp4",
      mixFilename: "{slug} S{season:02d}E{episode:02d}.wav",
      videoFilename: "episode.mp4",
    },
    audio: {
      sampleRate: 24000,
      loudness: { i: -14, tp: -1.5, lra: 11 },
      voiceDesignLoudnessI: -16,
      roomToneDb: -42,
      roomToneFundamentalHz: 55,
      tailOutSeconds: 1.0,
      titleCardGapSeconds: 7.0,
      titleCardGapMaxSeconds: 8.5,
      sceneTransitionGapSeconds: 3.5,
      sceneTransitionGapMaxSeconds: 4.0,
      authoredPauseRangeSeconds: [0.2, 3.5],
      narratorSpeakerKey: "narrator",
      mainCast: ["narrator", ...cast],
      voiceRefsDir: "Production/voice-refs",
      guestRefsDir: "Production/{episodeId}/guest-refs",
      voiceRegistry: "Canon/voice-registry.md",
    },
    visual: {
      refs: "Canon/refs.json",
      style: "Canon/visual-style.md",
      auditLaws: "Canon/visual-audit-laws.md",
      castingPileDir: "Canon/characters",
      candidatesDir: "Canon/_candidates",
      shotFrame: [1024, 576],
      characterKinds: ["human", "creature", "ship"],
      // Empty, not a sample: this list is prepended to every ambient image prompt, so another
      // show's scaffolding would put its weather and its architecture in every frame of this one.
      ambientPromptScaffold: [],
      // The two constants that are true of every generated frame whatever the show looks like.
      // The look itself is the author's, and `Canon/visual-style.md` is where they state it.
      styleConstants: "no text, no watermark, no signature.",
      collectivePopulatorBans: ["the crew", "a crowd", "background figures"],
    },
    video: {
      fps: 30,
      crossfadeSeconds: 1.0,
      compositionId: "Episode",
      titleCard: {
        text: id.showName.toUpperCase(),
        fontFamily: "Georgia, 'Times New Roman', serif",
        colors: { background: "#05070a", type: "#d4d8b8", glow: "rgba(152, 160, 96, 0.25)", stage: "#0f1004" },
        fadeSeconds: 2.0,
      },
    },
    publish: {
      channelName: "[YOUR NAME]",
      playlistUrl: "",
      playlistName: `${id.showName} Season 1`,
      tags: "",
      category: "Film & Animation",
      standingCopy: {
        weekly: `New episodes weekly. Self-contained stories set in the world of ${id.showName}.`,
        aiDisclosure: "A human dreamed up this world and rules every frame of it. AI helps with the writing, the narration, and the art.",
      },
      guide: "Canon/publishing-guide.md",
    },
  };
}

/** `showrunner.json`'s text as `init` writes it: two-space JSON with a trailing newline, so the
 *  file reads as a file and a later hand edit produces a one-line diff. */
export function showConfigText(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
