"use client";

import { useRef, useState } from "react";
import { CircleX } from "lucide-react";
import { useClickOutside } from "./hooks";
import { ToolbarButton } from "./Toolbar";

interface LeaveMenuProps {
  isHost: boolean;
  onLeave: () => Promise<void>;
  /** Host only. */
  onEndForAll: () => Promise<void>;
}

/** The red End (host) / Leave toolbar control, with Zoom's confirmation menu above it. */
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

  const label = isHost ? "End" : "Leave";

  return (
    <div ref={rootRef} className="relative">
      <ToolbarButton
        label={label}
        ariaLabel={isHost ? "End meeting" : "Leave meeting"}
        pressed={open}
        menu
        onClick={() => setOpen((o) => !o)}
        icon={<CircleX className="size-6 text-zoom-danger" />}
      />

      {open && (
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
            onClick={() => run(onLeave)}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60 ${
              isHost
                ? "bg-[#3d3d3d] text-white hover:bg-[#4a4a4a]"
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
