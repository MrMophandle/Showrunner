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

export type Shot = {
  src: string;
  from: number;
  durationInFrames: number;
  id: string;
};

export type TitleCard = {
  from: number;
  durationInFrames: number;
  fadeFrames: number;
};

export type Timeline = {
  fps: number;
  width: number;
  height: number;
  audio: string;
  durationInFrames: number;
  crossfadeFrames: number;
  shots: Shot[];
  title?: TitleCard;
};

// Series title card: opaque black, quiet type, fades out with the ship hum.
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
        backgroundColor: "#000504",
        opacity,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          color: "#b8d4d0",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 64,
          letterSpacing: "0.45em",
          textIndent: "0.45em", // recenters letterspaced text
          fontWeight: 400,
          textShadow: "0 0 24px rgba(96, 160, 152, 0.25)",
        }}
      >
        DEAD LIGHT
      </div>
    </AbsoluteFill>
  );
};

const KenBurnsShot: React.FC<{
  shot: Shot;
  index: number;
  crossfadeFrames: number;
}> = ({ shot, index, crossfadeFrames }) => {
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
    <AbsoluteFill style={{ opacity, backgroundColor: "#04100f" }}>
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
    return <AbsoluteFill style={{ backgroundColor: "#04100f" }} />;
  }
  return (
    <AbsoluteFill style={{ backgroundColor: "#04100f" }}>
      {timeline.shots.map((shot, i) => (
        <Sequence
          key={shot.id}
          from={shot.from}
          durationInFrames={shot.durationInFrames}
          layout="none"
        >
          <KenBurnsShot shot={shot} index={i} crossfadeFrames={timeline.crossfadeFrames} />
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
