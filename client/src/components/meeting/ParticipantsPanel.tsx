"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useIsMuted, useParticipantInfo, useParticipants } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { ChevronDown, Mic, MicOff, Video, VideoOff, X } from "lucide-react";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import type { ParticipantCredentials } from "@/lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { useClickOutside } from "./hooks";
import { parseRole, participantName, roleSuffix } from "./participant";

interface ParticipantsPanelProps {
  meetingNumber: string;
  /** The local participant's live role; enables the host controls. */
  isHost: boolean;
  /** Own credentials for host actions; the server checks the current role. */
  me: ParticipantCredentials;
  onClose: () => void;
  /** Room-level notice, e.g. "{name} is now the host". */
  onNotice: (message: string) => void;
}

type Pending =
  | { kind: "remove"; identity: string; name: string }
  | { kind: "makeHost"; identity: string; name: string }
  | { kind: "muteAll" };

const CONFIRM: Record<Pending["kind"], { label: string; danger: boolean }> = {
  remove: { label: "Remove", danger: true },
  makeHost: { label: "Make Host", danger: false },
  muteAll: { label: "Mute All", danger: false },
};

function confirmMessage(pending: Pending): string {
  switch (pending.kind) {
    case "remove":
      return `Remove ${pending.name} from the meeting?`;
    case "makeHost":
      return `Make ${pending.name} the host? You will become a participant.`;
    case "muteAll":
      return "Mute all current participants?";
  }
}

/** Right-side panel on desktop, full-screen overlay on phones. */
export function ParticipantsPanel({ meetingNumber, isHost, me, onClose, onNotice }: ParticipantsPanelProps) {
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
    if (!pending) return;
    try {
      if (pending.kind === "remove") {
        await api.removeParticipant(meetingNumber, pending.identity, me);
      } else if (pending.kind === "makeHost") {
        await api.makeHost(meetingNumber, pending.identity, me);
        onNotice(`${pending.name} is now the host`);
      } else {
        await api.muteAll(meetingNumber, me);
      }
      setPending(null);
    } catch {
      setPending(null);
      showError(
        pending.kind === "remove"
          ? `Could not remove ${pending.name}`
          : pending.kind === "makeHost"
            ? `Could not make ${pending.name} the host`
            : "Could not mute everyone",
      );
    }
  }

  async function muteOne(identity: string, name: string) {
    try {
      await api.muteParticipant(meetingNumber, identity, me);
    } catch {
      showError(`Could not mute ${name}`);
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
            viewerIsHost={isHost}
            onMute={(name) => muteOne(p.identity, name)}
            onMakeHost={(name) => setPending({ kind: "makeHost", identity: p.identity, name })}
            onRemove={(name) => setPending({ kind: "remove", identity: p.identity, name })}
          />
        ))}
      </ul>

      {(isHost || error) && (
        <footer className="flex shrink-0 flex-col items-center border-t border-white/10 p-3">
          {error && (
            <p role="alert" className="mb-2 self-stretch text-center text-xs text-red-400">
              {error}
            </p>
          )}
          {isHost && (
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

      {/* Host-only dialogs close by themselves if the host role moves away meanwhile. */}
      {pending && isHost && (
        <ConfirmDialog
          message={confirmMessage(pending)}
          confirmLabel={CONFIRM[pending.kind].label}
          danger={CONFIRM[pending.kind].danger}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </aside>
  );
}

interface ParticipantRowProps {
  participant: Participant;
  viewerIsHost: boolean;
  onMute: (name: string) => Promise<void>;
  onMakeHost: (name: string) => void;
  onRemove: (name: string) => void;
}

function ParticipantRow({ participant, viewerIsHost, onMute, onMakeHost, onRemove }: ParticipantRowProps) {
  const { name, metadata } = useParticipantInfo({ participant });
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const cameraMuted = useIsMuted({ participant, source: Track.Source.Camera });
  const [menuOpen, setMenuOpen] = useState(false);
  const [muting, setMuting] = useState(false);

  const displayName = participantName(name, participant);
  const isHost = parseRole(metadata) === "host";
  const suffix = roleSuffix(isHost, participant.isLocal);
  // Make Host / Remove: never on your own row, never on another host's row (e.g. the host's second tab).
  const manageable = viewerIsHost && !participant.isLocal && !isHost;
  // A host mutes anyone else by clicking their microphone icon. It only ever mutes: once the
  // mic is off the icon is not a button any more, and only that person can unmute themselves.
  const canMute = viewerIsHost && !participant.isLocal && !micMuted;

  async function mute() {
    setMuting(true);
    try {
      await onMute(displayName);
    } finally {
      setMuting(false);
    }
  }

  return (
    <li className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-white/5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zoom-blue text-xs font-semibold text-white">
        {initials(displayName)}
      </div>
      <div className="min-w-0 flex-1 truncate text-sm">
        {displayName}
        {suffix && <span className="text-[#a6a6a6]"> {suffix}</span>}
      </div>
      {manageable && (
        <div
          className={`flex shrink-0 items-center gap-1 ${
            menuOpen ? "" : "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
          }`}
        >
          <RowMoreMenu
            name={displayName}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onMakeHost={() => onMakeHost(displayName)}
            onRemove={() => onRemove(displayName)}
          />
        </div>
      )}
      <span className="flex shrink-0 items-center text-[#d0d0d0]">
        {canMute ? (
          <button
            type="button"
            onClick={mute}
            disabled={muting}
            aria-label={`Mute ${displayName}`}
            title={`Mute ${displayName}`}
            className={`${STATUS_ICON} rounded-md transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-zoom-blue active:bg-white/25 disabled:cursor-wait disabled:opacity-50`}
          >
            <Mic className="size-4" aria-hidden />
          </button>
        ) : (
          <span className={STATUS_ICON}>
            {micMuted ? (
              <MicOff className="size-4 text-zoom-danger" aria-label="Microphone muted" />
            ) : (
              <Mic className="size-4" aria-label="Microphone on" />
            )}
          </span>
        )}
        <span className={STATUS_ICON}>
          {cameraMuted ? (
            <VideoOff className="size-4 text-zoom-danger" aria-label="Camera off" />
          ) : (
            <Video className="size-4" aria-label="Camera on" />
          )}
        </span>
      </span>
    </li>
  );
}

/** Same box for every mic / camera icon, button or not, so the columns line up down the list. */
const STATUS_ICON = "flex size-7 items-center justify-center";

const ROW_BUTTON =
  "flex items-center gap-0.5 rounded-md bg-[#3a3a3a] px-2.5 py-1 text-xs text-white ring-1 ring-white/10 transition-colors hover:bg-[#4a4a4a] focus-visible:outline-2 focus-visible:outline-zoom-blue disabled:opacity-60";

interface RowMoreMenuProps {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMakeHost: () => void;
  onRemove: () => void;
}

/**
 * "More" menu on a participant row. It is positioned `fixed` from the button, so the
 * scrolling participant list can't clip it; it closes on scroll, resize, Escape or outside click.
 */
function RowMoreMenu({ name, open, onOpenChange, onMakeHost, onRemove }: RowMoreMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useClickOutside(rootRef, () => onOpenChange(false), open);

  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onOpenChange]);

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    if (open) {
      onOpenChange(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    // Open downwards unless the menu would run off the bottom of the screen.
    setPosition(
      rect.bottom + 96 > window.innerHeight
        ? { right, bottom: window.innerHeight - rect.top + 4 }
        : { right, top: rect.bottom + 4 },
    );
    onOpenChange(true);
  }

  function choose(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <div ref={rootRef}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More options for ${name}`}
        className={ROW_BUTTON}
      >
        More
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Options for ${name}`}
          style={position}
          className="fixed z-40 flex w-40 flex-col rounded-md bg-[#2b2b2b] py-1 text-sm shadow-2xl ring-1 ring-white/10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onMakeHost)}
            className="px-3 py-1.5 text-left text-white transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
          >
            Make Host
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onRemove)}
            className="px-3 py-1.5 text-left text-white transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
