"use client";

import { useState, type ReactNode } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Mic, MicOff, Users, Video, VideoOff } from "lucide-react";

interface ToolbarProps {
  participantCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onError: (message: string) => void;
  /** True until the room is connected; mic/camera toggles wait for it. */
  mediaDisabled: boolean;
  /** The red Leave / End control on the right. */
  leaveControl: ReactNode;
}

export function Toolbar({
  participantCount,
  panelOpen,
  onTogglePanel,
  onError,
  mediaDisabled,
  leaveControl,
}: ToolbarProps) {
  // Button state comes only from LiveKit, so a server-side Mute All flips it to "Unmute".
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const [micBusy, setMicBusy] = useState(false);
  const [camBusy, setCamBusy] = useState(false);

  async function toggleMic() {
    setMicBusy(true);
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      onError("Cannot access microphone");
    } finally {
      setMicBusy(false);
    }
  }

  async function toggleCamera() {
    setCamBusy(true);
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      onError("Cannot access camera");
    } finally {
      setCamBusy(false);
    }
  }

  return (
    <footer className="flex h-16 shrink-0 items-center justify-between gap-1 bg-room-toolbar px-2 sm:h-[72px] sm:px-4">
      <div className="flex items-center gap-0.5 sm:gap-1">
        <ToolbarButton
          label={isMicrophoneEnabled ? "Mute" : "Unmute"}
          onClick={toggleMic}
          disabled={micBusy || mediaDisabled}
          icon={
            isMicrophoneEnabled ? (
              <Mic className="size-5 sm:size-6" />
            ) : (
              <MicOff className="size-5 text-zoom-danger sm:size-6" />
            )
          }
        />
        <ToolbarButton
          label={isCameraEnabled ? "Stop Video" : "Start Video"}
          onClick={toggleCamera}
          disabled={camBusy || mediaDisabled}
          icon={
            isCameraEnabled ? (
              <Video className="size-5 sm:size-6" />
            ) : (
              <VideoOff className="size-5 text-zoom-danger sm:size-6" />
            )
          }
        />
      </div>

      <ToolbarButton
        label="Participants"
        onClick={onTogglePanel}
        active={panelOpen}
        icon={
          <span className="relative">
            <Users className="size-5 sm:size-6" />
            <span className="absolute -top-1.5 -right-3 min-w-4 rounded-full bg-room-panel px-1 text-center text-[10px] leading-4 font-semibold text-room-text ring-1 ring-white/15">
              {participantCount}
            </span>
          </span>
        }
      />

      <div className="flex items-center justify-end">{leaveControl}</div>
    </footer>
  );
}

interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

function ToolbarButton({ label, icon, onClick, disabled, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex min-w-14 flex-col items-center gap-1 rounded-lg px-1.5 py-1.5 text-room-text transition-colors hover:bg-white/10 disabled:opacity-60 sm:min-w-[72px] sm:px-2 ${
        active ? "bg-white/10" : ""
      }`}
    >
      <span aria-hidden className="flex h-6 items-center">
        {icon}
      </span>
      <span className="text-[11px] leading-none whitespace-nowrap sm:text-xs">{label}</span>
    </button>
  );
}
