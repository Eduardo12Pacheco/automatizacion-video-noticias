import { buildPublicStorageUrl, VIDEO_PROJECT_AUDIO_BUCKET } from '../data/storage-paths.js';

const DEFAULT_BACKGROUND_MUSIC_PREFIX = 'defaults/background-music';

function buildDefaultTrack({ id, label, fileName }) {
  const path = `${DEFAULT_BACKGROUND_MUSIC_PREFIX}/${fileName}`;
  return {
    id,
    label,
    fileName,
    path,
    public_url: buildPublicStorageUrl(VIDEO_PROJECT_AUDIO_BUCKET, path),
    mime_type: 'audio/wav',
  };
}

export const DEFAULT_BACKGROUND_MUSIC_TRACKS = [
  buildDefaultTrack({
    id: 'musica-golazo',
    label: 'Musica Golazo',
    fileName: 'musica-golazo-rapida.wav',
  }),
  buildDefaultTrack({
    id: 'musica-emotiva-golazo',
    label: 'Musica Emotiva Golazo',
    fileName: 'musica-emotiva-golazo.wav',
  }),
  buildDefaultTrack({
    id: 'trap-boxing',
    label: 'Trap Boxing',
    fileName: 'Trap-Boxing.wav',
  }),
  buildDefaultTrack({
    id: 'slow-motion',
    label: 'Slow Motion',
    fileName: 'sport-bass-slow.wav',
  }),
  buildDefaultTrack({
    id: 'epic-dramatic',
    label: 'Epic Dramatic',
    fileName: 'Epic-Dramatic-Cinematic.wav',
  }),
  buildDefaultTrack({
    id: 'trap-mma',
    label: 'Trap MMA',
    fileName: 'Trap-MMA.wav',
  }),
  buildDefaultTrack({
    id: 'on-a-mission',
    label: 'On a Mission',
    fileName: 'On-A-Mission.wav',
  }),
  buildDefaultTrack({
    id: 'epic-motivacional-golazo',
    label: 'Epic Motivacional Golazo',
    fileName: 'epic-motivacional-golazo.wav',
  }),
  buildDefaultTrack({
    id: 'debate-golazo-polemico',
    label: 'Debate Golazo Polemico',
    fileName: 'debate-golazo-polemico.wav',
  }),
];

export const DEFAULT_BACKGROUND_MUSIC_TRACK_ID = 'musica-golazo';

export function findDefaultBackgroundMusicTrack(trackId) {
  return DEFAULT_BACKGROUND_MUSIC_TRACKS.find((track) => track.id === trackId) || null;
}

export function getDefaultBackgroundMusicTrack() {
  return findDefaultBackgroundMusicTrack(DEFAULT_BACKGROUND_MUSIC_TRACK_ID) || DEFAULT_BACKGROUND_MUSIC_TRACKS[0] || null;
}

export function createDefaultBackgroundMusicAudio({ selectedAt = '' } = {}) {
  const track = getDefaultBackgroundMusicTrack();
  return createBackgroundMusicAudioFromTrack(track, { selectedAt });
}

export function createBackgroundMusicAudioFromTrack(track, { selectedAt = '' } = {}) {
  if (!track) return {};

  return {
    kind: 'background',
    bucket: VIDEO_PROJECT_AUDIO_BUCKET,
    storage_path: track.path,
    public_url: track.public_url,
    name: track.label,
    file_name: track.fileName,
    size: 0,
    mime_type: track.mime_type,
    source: 'default-background-music',
    default_track_id: track.id,
    ...(selectedAt ? { selected_at: selectedAt } : {}),
  };
}
