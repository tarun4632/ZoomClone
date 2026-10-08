import type { LocalAudioTrack, LocalVideoTrack } from "livekit-client";
import type { JoinResponse } from "@/lib/types";

/** Everything the pre-join stage hands to the room stage. */
export interface MeetingSession {
  /** Includes `participant_secret`: keep it in memory only, never in storage or the URL. */
  join: JoinResponse;
  hostName: string | null;
  displayName: string;
  /** Preview tracks, published as-is on connect. The audio track is already muted if the mic was off. */
  audioTrack: LocalAudioTrack | null;
  videoTrack: LocalVideoTrack | null;
}
