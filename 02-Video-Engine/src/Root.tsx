import "./index.css";
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
  const latestEnd = props.segments.reduce((max, segment) => {
    return Math.max(max, segment.endTime);
  }, 0);

  return {
    durationInFrames: Math.max(1, Math.ceil(latestEnd * 30)),
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
