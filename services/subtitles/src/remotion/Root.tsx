import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {SubtitleRender, type SubtitleRenderProps} from './SubtitleRender';

const defaultProps: SubtitleRenderProps = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  background: '#000000',
  subtitles: [],
  source_static_path: '',
  font_faces: [],
};

const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="SubtitlesRender"
      component={SubtitleRender}
      durationInFrames={defaultProps.durationInFrames}
      fps={defaultProps.fps}
      width={defaultProps.width}
      height={defaultProps.height}
      defaultProps={defaultProps}
      calculateMetadata={({props}) => {
        const typedProps = props as SubtitleRenderProps;
        return {
          durationInFrames: Math.max(1, Math.ceil(Number(typedProps.durationInFrames || defaultProps.durationInFrames))),
          fps: Math.max(1, Math.round(Number(typedProps.fps || defaultProps.fps))),
          width: Math.max(1, Math.round(Number(typedProps.width || defaultProps.width))),
          height: Math.max(1, Math.round(Number(typedProps.height || defaultProps.height))),
        };
      }}
    />
  );
};

registerRoot(RemotionRoot);
