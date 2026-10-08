import type { LocalAudioTrack, LocalVideoTrack } from "livekit-client";
import type { JoinResponse } from "@/lib/types";

/** Everything the pre-join stage hands to the room stage. */
export interface MeetingSession {
  join: JoinResponse;
  /** Set when this browser holds the host key for the meeting. */
  hostKey: string | null;
  hostName: string | null;
  displayName: string;
  /** Preview tracks, published as-is on connect. The audio track is already muted if the mic was off. */
  audioTrack: LocalAudioTrack | null;
  videoTrack: LocalVideoTrack | null;
}
