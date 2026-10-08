"use client";

import { useRef, useState } from "react";
import { useClickOutside } from "./hooks";

interface LeaveMenuProps {
  isHost: boolean;
  onLeave: () => Promise<void>;
  /** Host only. */
  onEndForAll: () => Promise<void>;
}

/** The red End (host) / Leave button, with Zoom's confirmation menu above it. */
export function LeaveMenu({ isHost, onLeave, onEndForAll }: LeaveMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open && !busy);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-lg bg-zoom-danger px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-zoom-danger-hover sm:px-5"
      >
        {isHost ? "End" : "Leave"}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-40 mb-3 flex w-60 flex-col gap-2 rounded-xl bg-room-panel p-3 shadow-2xl ring-1 ring-white/10"
        >
          {isHost && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onEndForAll)}
              className="rounded-lg bg-zoom-danger px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zoom-danger-hover disabled:opacity-60"
            >
              End Meeting for All
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => run(onLeave)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
              isHost
                ? "bg-white/10 text-room-text hover:bg-white/20"
                : "bg-zoom-danger text-white hover:bg-zoom-danger-hover"
            }`}
          >
            Leave Meeting
          </button>
        </div>
      )}
    </div>
  );
}
