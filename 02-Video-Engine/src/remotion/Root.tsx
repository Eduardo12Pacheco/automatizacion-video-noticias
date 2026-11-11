import { Composition } from "remotion";
import { type AutomaticVideoProps, MyComposition } from "./Composition";

const defaultProps: AutomaticVideoProps = {
  audioSrc: "generated/audio.wav",
  segments: [],
};

const calculateDurationInFrames = ({
  props,
}: {
  props: AutomaticVideoProps;
}) => {
  const fps = props.fps ?? 30;
  const latestEnd = props.segments.reduce((max, segment) => {
    return Math.max(max, segment.endTime);
  }, 0);
  const compositionDurationSeconds = Math.max(latestEnd, props.compositionDurationSeconds ?? 0);
  const outroSeconds = props.outro?.enabled === false ? 0 : props.outro?.durationSeconds ?? 0;

  return {
    durationInFrames: Math.max(1, Math.ceil((compositionDurationSeconds + outroSeconds) * fps)),
  };
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="MyComp"
        component={MyComposition}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
        calculateMetadata={calculateDurationInFrames}
      />
    </>
  );
};
