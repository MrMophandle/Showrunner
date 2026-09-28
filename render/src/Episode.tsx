import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { Shot, TitleCard, Timeline } from "./timeline";

/**
 * The letterbox colour for an episode that has no title card.
 *
 * The stage colour travels with the card's other colours (`title.colors.stage`), because a show
 * picks them together. An episode whose manifest marks no title-card gap has no `title` object at
 * all, so there is nothing to read; black is the engine's own neutral ground, not a show's choice.
 */
const NO_STAGE_COLOUR = "black";

// Series title card: opaque ground, quiet type, fades out with the room tone. Every value it
// draws with -- the words, the font, the three colours -- comes from the timeline.
const SeriesTitle: React.FC<{ title: TitleCard }> = ({ title }) => {
  const frame = useCurrentFrame(); // local to the Sequence
  const d = title.durationInFrames;
  const opacity = interpolate(
    frame,
    [0, 6, d - title.fadeFrames, d],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <AbsoluteFill
      style={{
        backgroundColor: title.colors.background,
        opacity,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          color: title.colors.type,
          fontFamily: title.fontFamily,
          fontSize: 64,
          letterSpacing: "0.45em",
          textIndent: "0.45em", // recenters letterspaced text
          fontWeight: 400,
          textShadow: `0 0 24px ${title.colors.glow}`,
        }}
      >
        {title.text}
      </div>
    </AbsoluteFill>
  );
};

const KenBurnsShot: React.FC<{
  shot: Shot;
  index: number;
  crossfadeFrames: number;
  stage: string;
}> = ({ shot, index, crossfadeFrames, stage }) => {
  const frame = useCurrentFrame(); // local to the Sequence
  const d = shot.durationInFrames;
  const { fps } = useVideoConfig();

  // PER-SECOND motion rates (constant, visible regardless of hold length).
  // Zoom ~0.35%/s, pan ~1.4px/s; long holds cap at 1.35x so faces of the
  // frame never crop absurdly. Direction alternates by shot index.
  const ZOOM_PER_S = 0.0035;
  const PAN_PER_S = 1.4;
  const seconds = frame / fps;
  const dSeconds = d / fps;
  const zoomIn = index % 2 === 0;
  const zoomSpan = Math.min(dSeconds * ZOOM_PER_S, 0.33);
  const scale = zoomIn
    ? Math.min(1.02 + seconds * ZOOM_PER_S, 1.02 + zoomSpan)
    : Math.max(1.02 + zoomSpan - seconds * ZOOM_PER_S, 1.02);
  const panSpan = Math.min(dSeconds * PAN_PER_S, 90);
  const panProgress = Math.min(seconds * PAN_PER_S, panSpan);
  const driftX = (index % 4 < 2 ? 1 : -1) * (panProgress - panSpan / 2);
  const driftY = (index % 3 === 0 ? 0.6 : -0.6) * (panProgress - panSpan / 2);

  const opacity = interpolate(
    frame,
    [0, crossfadeFrames, d - crossfadeFrames, d],
    [index === 0 ? 1 : 0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: stage }}>
      <Img
        src={staticFile(shot.src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${driftX}px, ${driftY}px)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const Episode: React.FC<{ timeline: Timeline | null; ep: string }> = ({
  timeline,
}) => {
  if (!timeline) {
    return <AbsoluteFill style={{ backgroundColor: NO_STAGE_COLOUR }} />;
  }
  const stage = timeline.title?.colors.stage ?? NO_STAGE_COLOUR;
  return (
    <AbsoluteFill style={{ backgroundColor: stage }}>
      {timeline.shots.map((shot, i) => (
        <Sequence
          key={shot.id}
          from={shot.from}
          durationInFrames={shot.durationInFrames}
          layout="none"
        >
          <KenBurnsShot
            shot={shot}
            index={i}
            crossfadeFrames={timeline.crossfadeFrames}
            stage={stage}
          />
        </Sequence>
      ))}
      {timeline.title && (
        <Sequence
          from={timeline.title.from}
          durationInFrames={timeline.title.durationInFrames}
          layout="none"
        >
          <SeriesTitle title={timeline.title} />
        </Sequence>
      )}
      <Audio src={staticFile(timeline.audio)} />
    </AbsoluteFill>
  );
};
