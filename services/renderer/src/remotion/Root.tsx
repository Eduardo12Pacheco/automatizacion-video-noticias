import { Composition } from "remotion";
import { type AutomaticVideoProps, MyComposition } from "./Composition";
import { resolveRootDurationFrames } from "./composition-timing";

const defaultProps: AutomaticVideoProps = {
  audioSrc: "generated/audio.wav",
  segments: [],
};

const calculateDurationInFrames = ({ props }: { props: AutomaticVideoProps }) =>
  resolveRootDurationFrames({ props });

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
