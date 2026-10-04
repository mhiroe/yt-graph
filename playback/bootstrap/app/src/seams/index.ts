// Seam resolution — every external integration the playback component
// touches enters through one of these adapters. yt-graph core is reached
// only through the export contract behind ChannelFeedAdapter; nothing in
// this app imports from docs/iterations/bootstrap/app.

import { createChannelFeed, type ChannelFeedAdapter } from "./channelFeed";
import { createPointsGate, type PointsGateAdapter } from "./pointsGate";
import { selectSurface, type PlaybackSurfaceAdapter } from "./playbackSurface";

export type Seams = {
  feed: ChannelFeedAdapter;
  pointsGate: PointsGateAdapter;
  surface: PlaybackSurfaceAdapter;
};

export async function resolveSeams(env: {
  feed?: string;
  exportUrl?: string;
  points?: string;
} = {}): Promise<Seams> {
  return {
    feed: createChannelFeed(env.feed, { exportUrl: env.exportUrl }),
    pointsGate: createPointsGate(env.points),
    surface: await selectSurface(),
  };
}
