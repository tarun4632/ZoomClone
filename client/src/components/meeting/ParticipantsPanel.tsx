"use client";

import { useRef, useState } from "react";
import { useIsMuted, useParticipantInfo, useParticipants } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { Mic, MicOff, Video, VideoOff, X } from "lucide-react";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { parseRole, participantName, roleSuffix } from "./participant";

interface ParticipantsPanelProps {
  meetingNumber: string;
  /** Present only for the host; enables Remove and Mute All. */
  hostKey: string | null;
  onClose: () => void;
}

type Pending = { kind: "remove"; identity: string; name: string } | { kind: "muteAll" };

/** Right-side panel on desktop, full-screen overlay on phones. */
export function ParticipantsPanel({ meetingNumber, hostKey, onClose }: ParticipantsPanelProps) {
  const participants = useParticipants();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<number | null>(null);

  // Me first, then hosts, then everyone else by name.
  const sorted = [...participants].sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    const hostA = parseRole(a.metadata) === "host";
    const hostB = parseRole(b.metadata) === "host";
    if (hostA !== hostB) return hostA ? -1 : 1;
    return (a.name || a.identity).localeCompare(b.name || b.identity);
  });

  function showError(message: string) {
    setError(message);
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), 4000);
  }

  async function confirmPending() {
    if (!pending || !hostKey) return;
    try {
      if (pending.kind === "remove") {
        await api.removeParticipant(meetingNumber, pending.identity, hostKey);
      } else {
        await api.muteAll(meetingNumber, hostKey);
      }
      setPending(null);
    } catch {
      setPending(null);
      showError(pending.kind === "remove" ? `Could not remove ${pending.name}` : "Could not mute everyone");
    }
  }

  return (
    <aside
      aria-label="Participants"
      className="fixed inset-0 z-30 flex flex-col bg-[#242424] text-white sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-black"
    >
      <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-white/10 px-10">
        <h2 className="truncate text-sm font-semibold">Participants ({participants.length})</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close participants"
          className="absolute right-2 flex size-8 items-center justify-center rounded-md text-[#bdbdbd] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-zoom-blue"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {sorted.map((p) => (
          <ParticipantRow
            key={p.identity}
            participant={p}
            canRemove={hostKey !== null}
            onRemove={(name) => setPending({ kind: "remove", identity: p.identity, name })}
          />
        ))}
      </ul>

      {(hostKey || error) && (
        <footer className="flex shrink-0 flex-col items-center border-t border-white/10 p-3">
          {error && (
            <p role="alert" className="mb-2 self-stretch text-center text-xs text-red-400">
              {error}
            </p>
          )}
          {hostKey && (
            <button
              type="button"
              onClick={() => setPending({ kind: "muteAll" })}
              className="rounded-md bg-[#3a3a3a] px-4 py-1.5 text-sm font-medium text-white ring-1 ring-white/10 transition-colors hover:bg-[#474747] focus-visible:outline-2 focus-visible:outline-zoom-blue"
            >
              Mute All
            </button>
          )}
        </footer>
      )}

      {pending && (
        <ConfirmDialog
          message={
            pending.kind === "remove"
              ? `Remove ${pending.name} from the meeting?`
              : "Mute all current participants?"
          }
          confirmLabel={pending.kind === "remove" ? "Remove" : "Mute All"}
          danger={pending.kind === "remove"}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </aside>
  );
}

interface ParticipantRowProps {
  participant: Participant;
  canRemove: boolean;
  onRemove: (name: string) => void;
}

function ParticipantRow({ participant, canRemove, onRemove }: ParticipantRowProps) {
  const { name, metadata } = useParticipantInfo({ participant });
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const cameraMuted = useIsMuted({ participant, source: Track.Source.Camera });

  const displayName = participantName(name, participant);
  const isHost = parseRole(metadata) === "host";
  const suffix = roleSuffix(isHost, participant.isLocal);
  // Never offer Remove on yourself or on a host (e.g. the host's own second tab).
  const removable = canRemove && !participant.isLocal && !isHost;

  return (
    <li className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-white/5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zoom-blue text-xs font-semibold text-white">
        {initials(displayName)}
      </div>
      <div className="min-w-0 flex-1 truncate text-sm">
        {displayName}
        {suffix && <span className="text-[#a6a6a6]"> {suffix}</span>}
      </div>
      {removable && (
        <button
          type="button"
          onClick={() => onRemove(displayName)}
          className="rounded-md bg-[#3a3a3a] px-2.5 py-1 text-xs text-white ring-1 ring-white/10 transition-colors hover:bg-zoom-danger hover:ring-zoom-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
        >
          Remove
        </button>
      )}
      <span className="flex shrink-0 items-center gap-2.5 text-[#d0d0d0]">
        {micMuted ? (
          <MicOff className="size-4 text-zoom-danger" aria-label="Microphone muted" />
        ) : (
          <Mic className="size-4" aria-label="Microphone on" />
        )}
        {cameraMuted ? (
          <VideoOff className="size-4 text-zoom-danger" aria-label="Camera off" />
        ) : (
          <Video className="size-4" aria-label="Camera on" />
        )}
      </span>
    </li>
  );
}
