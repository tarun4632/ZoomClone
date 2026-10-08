"use client";

import { useRef, useState } from "react";
import { useRemoteParticipants } from "@livekit/components-react";
import { Check, CircleX } from "lucide-react";
import { initials } from "@/lib/format";
import { useClickOutside } from "./hooks";
import { participantName } from "./participant";
import { ToolbarButton } from "./Toolbar";

interface LeaveMenuProps {
  isHost: boolean;
  onLeave: () => Promise<void>;
  /** Host only. */
  onEndForAll: () => Promise<void>;
  /** Host only: make this participant the host, then leave. Rejects if the hand-over failed. */
  onAssignAndLeave: (identity: string) => Promise<void>;
}

/**
 * The red End (host) / Leave toolbar control, with Zoom's menu above it.
 *
 * A host who leaves while others are in the meeting first picks who takes over ("Assign a
 * new host"), as in Zoom: a meeting has exactly one host, and the role does not come back to
 * someone who gave it away.
 */
export function LeaveMenu({ isHost, onLeave, onEndForAll, onAssignAndLeave }: LeaveMenuProps) {
  const others = useRemoteParticipants();
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setAssigning(false);
    setFailed(false);
  }
  useClickOutside(rootRef, close, open && !busy);

  // Longest in the meeting first: the natural default to hand over to.
  const candidates = [...others].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0));
  // The choice survives only while that person is still here.
  const chosen = candidates.find((p) => p.identity === picked) ?? candidates[0];

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true); // still in the meeting; the menu stays open to try again
    } finally {
      setBusy(false);
    }
  }

  function leaveClicked() {
    // Alone, there is nobody to hand over to: leaving simply ends the meeting.
    if (isHost && candidates.length > 0) setAssigning(true);
    else void run(onLeave);
  }

  const label = isHost ? "End" : "Leave";

  return (
    <div ref={rootRef} className="relative">
      <ToolbarButton
        label={label}
        ariaLabel={isHost ? "End meeting" : "Leave meeting"}
        pressed={open}
        menu
        onClick={() => (open ? close() : setOpen(true))}
        icon={<CircleX className="size-6 text-zoom-danger" />}
      />

      {open && assigning && isHost && chosen ? (
        <div
          role="dialog"
          aria-label="Assign a new host"
          className="absolute right-0 bottom-full z-40 mb-2 flex w-[min(20rem,calc(100vw-1rem))] flex-col rounded-xl bg-[#2b2b2b] p-4 shadow-2xl ring-1 ring-white/10"
        >
          <h2 className="text-base font-bold text-white">Assign a new host</h2>
          <ul role="radiogroup" aria-label="New host" className="mt-3 max-h-56 space-y-1 overflow-y-auto">
            {candidates.map((p) => {
              const name = participantName(p.name, p);
              const selected = p.identity === chosen.identity;
              return (
                <li key={p.identity}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy}
                    onClick={() => setPicked(p.identity)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-white transition-colors outline-none focus-visible:ring-2 focus-visible:ring-zoom-blue ${
                      selected ? "bg-white/20" : "hover:bg-white/10"
                    }`}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zoom-blue text-xs font-semibold">
                      {initials(name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {selected && <Check className="size-4 shrink-0" strokeWidth={3} aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
          {failed && (
            <p role="alert" className="mt-3 text-xs text-red-400">
              Could not assign a new host. Please try again.
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => onAssignAndLeave(chosen.identity))}
            className="mt-3 rounded-lg bg-zoom-danger px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-zoom-danger-hover disabled:opacity-60"
          >
            Assign and leave
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setAssigning(false);
              setFailed(false);
            }}
            className="mt-1 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      ) : (
        open && (
          <div
            role="menu"
            aria-label={label}
            className="absolute right-0 bottom-full z-40 mb-2 flex w-60 flex-col gap-2 rounded-lg bg-[#2b2b2b] p-3 shadow-2xl ring-1 ring-white/10"
          >
            {isHost && (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => run(onEndForAll)}
                className="rounded-md bg-zoom-danger px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zoom-danger-hover disabled:opacity-60"
              >
                End Meeting for All
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={leaveClicked}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
                isHost
                  ? "bg-[#3d3d3d] text-white hover:bg-[#4a4a4a]"
                  : "bg-zoom-danger text-white hover:bg-zoom-danger-hover"
              }`}
            >
              Leave Meeting
            </button>
          </div>
        )
      )}
    </div>
  );
}
