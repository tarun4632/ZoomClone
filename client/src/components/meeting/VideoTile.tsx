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
import { MicOff } from "lucide-react";
import { initials } from "@/lib/format";
import { participantName } from "./participant";

interface VideoTileProps {
  /** Camera track reference, or a placeholder when the participant has no camera track. */
  trackRef: TrackReferenceOrPlaceholder;
  width: number;
  height: number;
}

export function VideoTile({ trackRef, width, height }: VideoTileProps) {
  const { participant } = trackRef;
  const { name } = useParticipantInfo({ participant });
  const isSpeaking = useIsSpeaking(participant);
  // A placeholder (no publication) counts as muted.
  const cameraMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });

  const displayName = participantName(name, participant);
  const showVideo = isTrackReference(trackRef) && !cameraMuted;
  const compact = height < 140;

  return (
    <div
      className="relative overflow-hidden rounded-lg bg-room-tile"
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2">
          {!compact && (
            <div className="flex size-14 items-center justify-center rounded-full bg-zoom-blue text-lg font-semibold text-white sm:size-20 sm:text-2xl">
              {initials(displayName)}
            </div>
          )}
          <span className="max-w-full truncate text-sm font-medium text-room-text sm:text-base">
            {displayName}
          </span>
        </div>
      )}

      <div className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        {micMuted && <MicOff className="size-3.5 shrink-0 text-zoom-danger" aria-label="Muted" />}
        <span className="truncate">{displayName}</span>
      </div>

      {isSpeaking && (
        <div
          className="pointer-events-none absolute inset-0 rounded-lg border-[3px] border-speaking"
          aria-hidden
        />
      )}
    </div>
  );
}
