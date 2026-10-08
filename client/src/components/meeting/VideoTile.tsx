"use client";

import {
  VideoTrack,
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useParticipantInfo,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { initials } from "@/lib/format";
import { MutedMicIcon } from "./icons";
import { participantName } from "./participant";

interface VideoTileProps {
  /** Camera track reference, or a placeholder when the participant has no camera track. */
  trackRef: TrackReferenceOrPlaceholder;
  width: number;
  height: number;
  /** Gallery tiles get slightly rounded corners; a lone tile is square like Zoom's. */
  rounded: boolean;
}

export function VideoTile({ trackRef, width, height, rounded }: VideoTileProps) {
  const { participant } = trackRef;
  const { name } = useParticipantInfo({ participant });
  const isSpeaking = useIsSpeaking(participant);
  // A placeholder (no publication) counts as muted.
  const cameraMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });

  const displayName = participantName(name, participant);
  const showVideo = isTrackReference(trackRef) && !cameraMuted;
  const compact = height < 140;
  const corner = rounded ? "rounded-md" : "";

  return (
    <div
      className={`relative overflow-hidden bg-[#232323] ${corner}`}
      style={{ width, height }}
      data-speaking={isSpeaking || undefined}
    >
      {showVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className="h-full w-full object-cover"
          // Mirror your own camera, like Zoom's self view.
          style={participant.isLocal ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-3">
          {!compact && (
            <div className="flex size-16 items-center justify-center rounded-lg bg-zoom-blue text-xl font-semibold text-white sm:size-24 sm:text-3xl">
              {initials(displayName)}
            </div>
          )}
          <span className="max-w-full truncate text-base font-medium text-white sm:text-xl">
            {displayName}
          </span>
        </div>
      )}

      <div className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-[13px] text-white sm:text-sm">
        {micMuted && <MutedMicIcon className="size-4 shrink-0" aria-label="Muted" role="img" aria-hidden={false} />}
        <span className="truncate">{displayName}</span>
      </div>

      {isSpeaking && (
        <div
          className={`pointer-events-none absolute inset-0 border-[3px] border-speaking ${corner}`}
          aria-hidden
        />
      )}
    </div>
  );
}
