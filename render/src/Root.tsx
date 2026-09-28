import { Composition, staticFile, CalculateMetadataFunction } from "remotion";
import { Episode, Timeline } from "./Episode";

const EP = process.env.REMOTION_EPISODE ?? "ep99";

const calculateMetadata: CalculateMetadataFunction<{ timeline: Timeline | null; ep: string }> =
  async () => {
    const res = await fetch(staticFile(`${EP}/timeline.json`));
    const timeline = (await res.json()) as Timeline;
    return {
      durationInFrames: timeline.durationInFrames,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      props: { timeline, ep: EP },
    };
  };

export const Root: React.FC = () => {
  return (
    <Composition
      id="Episode"
      component={Episode}
      durationInFrames={1000}
      fps={30}
      width={1024}
      height={576}
      defaultProps={{ timeline: null, ep: EP }}
      calculateMetadata={calculateMetadata}
    />
  );
};
