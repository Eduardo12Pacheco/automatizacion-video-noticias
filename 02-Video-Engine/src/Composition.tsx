import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

type TimelineSegment = {
  image: string;
  phrase?: string;
  startTime: number;
  endTime: number;
};

export type AutomaticVideoProps = {
  audioSrc?: string;
  segments: TimelineSegment[];
};

const Fps = 30;

const SegmentScene = ({ segment }: { segment: TimelineSegment }) => {
  const frame = useCurrentFrame();
  const durationInFrames = Math.max(
    1,
    Math.round((segment.endTime - segment.startTime) * Fps),
  );
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.08], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <Img
        src={staticFile(segment.image)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};

export const MyComposition = ({ audioSrc, segments }: AutomaticVideoProps) => {
  if (segments.length === 0) {
    return <AbsoluteFill style={{ backgroundColor: "#101828" }} />;
  }

  return (
    <AbsoluteFill>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
      {segments.map((segment) => {
        const from = Math.max(0, Math.round(segment.startTime * Fps));
        const durationInFrames = Math.max(
          1,
          Math.round((segment.endTime - segment.startTime) * Fps),
        );

        return (
          <Sequence
            key={`${segment.image}-${from}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <SegmentScene segment={segment} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
