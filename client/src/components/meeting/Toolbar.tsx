"use client";

import { useState, type ReactNode } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Mic, Users, Video } from "lucide-react";
import { MutedMicIcon, VideoOffIcon } from "./icons";

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

/** Zoom's bottom bar: mic and video on the left, Participants centred, End/Leave on the right. */
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
    <footer className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center bg-[#1a1a1a] px-1 sm:h-[68px] sm:px-3">
      <div className="flex items-center justify-start">
        <ToolbarButton
          label={isMicrophoneEnabled ? "Mute" : "Unmute"}
          onClick={toggleMic}
          disabled={micBusy || mediaDisabled}
          icon={isMicrophoneEnabled ? <Mic className="size-6" /> : <MutedMicIcon className="size-6" />}
        />
        <ToolbarButton
          label={isCameraEnabled ? "Stop Video" : "Start Video"}
          onClick={toggleCamera}
          disabled={camBusy || mediaDisabled}
          icon={isCameraEnabled ? <Video className="size-6" /> : <VideoOffIcon className="size-6" />}
        />
      </div>

      <ToolbarButton
        label="Participants"
        ariaLabel={`Participants (${participantCount})`}
        onClick={onTogglePanel}
        pressed={panelOpen}
        icon={
          <span className="relative">
            <Users className="size-6" />
            <span className="absolute -top-1.5 left-full ml-0.5 text-[11px] leading-none font-medium text-white">
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
  ariaLabel?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** The button opens a menu: announce it with aria-haspopup/aria-expanded instead of aria-pressed. */
  menu?: boolean;
}

/** Icon stacked over a small label; no background until hovered. Shared with LeaveMenu. */
export function ToolbarButton({ label, icon, onClick, ariaLabel, disabled, pressed, menu }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={menu ? undefined : pressed}
      aria-haspopup={menu ? "menu" : undefined}
      aria-expanded={menu ? pressed : undefined}
      className={`flex min-w-[60px] flex-col items-center gap-1 rounded-md px-1 py-1.5 text-[#e8e8e8] transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-2 focus-visible:outline-zoom-blue disabled:opacity-50 disabled:hover:bg-transparent sm:min-w-[76px] sm:px-2 ${
        pressed ? "bg-white/10" : ""
      }`}
    >
      <span aria-hidden className="flex h-6 items-center">
        {icon}
      </span>
      <span className="text-[11px] leading-none whitespace-nowrap sm:text-xs">{label}</span>
    </button>
  );
}
