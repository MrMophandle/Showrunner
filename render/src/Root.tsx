import { Composition, staticFile, CalculateMetadataFunction } from "remotion";
import { Episode } from "./Episode";
import { Timeline, parseTimeline } from "./timeline";

/**
 * The episode to render is named by the caller, and there is no default.
 *
 * The assemble pipeline sets REMOTION_EPISODE alongside the composition id it takes from the
 * show's `video.compositionId`. A fallback here would let a mis-set environment render a
 * different episode than the one asked for, and four hours would pass before anyone saw it.
 * The check is lazy so that the composition still registers and the studio still opens; it fires
 * at the first moment the episode is actually needed.
 */
const episodeId = (): string => {
  const ep = process.env.REMOTION_EPISODE;
  if (ep === undefined || ep === "") {
    throw new Error(
      "REMOTION_EPISODE is not set: the assemble pipeline names the episode to render"
    );
  }
  return ep;
};

/**
 * Every figure the composition needs comes from the episode's own timeline: the frame rate, the
 * length, and the frame size. Remotion allows `<Composition>` to declare none of them when a
 * `calculateMetadata` supplies them, so none is declared -- a literal there would be dead weight
 * overwritten on every render, and a show's frame rate is the show's to choose.
 */
const calculateMetadata: CalculateMetadataFunction<{ timeline: Timeline | null; ep: string }> =
  async () => {
    const ep = episodeId();
    const res = await fetch(staticFile(`${ep}/timeline.json`));
    const timeline = parseTimeline(await res.json());
    return {
      durationInFrames: timeline.durationInFrames,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      props: { timeline, ep },
    };
  };

export const Root: React.FC = () => {
  return (
    <Composition
      id="Episode"
      component={Episode}
      defaultProps={{ timeline: null, ep: process.env.REMOTION_EPISODE ?? "" }}
      calculateMetadata={calculateMetadata}
    />
  );
};
