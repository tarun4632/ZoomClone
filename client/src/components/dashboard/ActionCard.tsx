"use client";

import { Plus, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToday } from "./hooks";
import type { MeetingActions } from "./useMeetingActions";

const tones = {
  blue: "bg-zoom-blue group-hover:bg-zoom-blue-hover",
  orange: "bg-zoom-orange group-hover:bg-zoom-orange-hover",
};

function ActionButton({
  label,
  tone,
  glyph,
  onClick,
  busy = false,
}: {
  label: string;
  tone: keyof typeof tones;
  glyph: ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className="group flex min-w-0 flex-col items-center gap-2.5 rounded-xl p-1 outline-none focus-visible:ring-2 focus-visible:ring-zoom-blue focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-wait"
    >
      <span
        className={`flex size-[62px] items-center justify-center rounded-[14px] text-white transition-[background-color,transform] duration-150 group-active:scale-95 ${tones[tone]}`}
      >
        {busy ? <Spinner className="size-7" /> : glyph}
      </span>
      <span className="text-center text-[13px] leading-tight font-medium whitespace-nowrap text-ink-muted group-hover:text-ink sm:text-sm">
        {busy ? "Starting…" : label}
      </span>
    </button>
  );
}

/** Zoom's calendar glyph: a white calendar showing today's day of the month (same in both themes). */
function CalendarGlyph() {
  const today = useToday();
  return (
    <span aria-hidden="true" className="relative flex h-[26px] w-6 flex-col overflow-hidden rounded-[5px] bg-white">
      <span className="h-[7px] shrink-0 bg-white" />
      <span className="flex flex-1 items-center justify-center text-[11px] leading-none font-bold text-zoom-blue tabular-nums">
        {today ? today.getDate() : ""}
      </span>
      <span className="absolute top-[1px] left-[6px] h-[4px] w-[2px] rounded-full bg-zoom-blue" />
      <span className="absolute top-[1px] right-[6px] h-[4px] w-[2px] rounded-full bg-zoom-blue" />
    </span>
  );
}

function JoinGlyph() {
  return (
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-[6px] bg-white">
      <Plus className="size-4 text-zoom-blue" strokeWidth={3} />
    </span>
  );
}

/** Schedule / Join / New Meeting as rounded-square icons with grey labels, like Zoom's portal. */
export function ActionCard({ actions, className = "" }: { actions: MeetingActions; className?: string }) {
  return (
    <Card aria-label="Quick actions" className={className}>
      <div className="mx-auto grid max-w-sm grid-cols-3 gap-1">
        <ActionButton label="Schedule" tone="blue" glyph={<CalendarGlyph />} onClick={actions.openSchedule} />
        <ActionButton label="Join" tone="blue" glyph={<JoinGlyph />} onClick={actions.openJoin} />
        <ActionButton
          label="New Meeting"
          tone="orange"
          glyph={<Video className="size-7 fill-current" aria-hidden="true" />}
          onClick={actions.newMeeting}
          busy={actions.starting}
        />
      </div>
      {actions.startError && (
        <div className="mt-5">
          <Alert title="Couldn't start a new meeting">
            Make sure you&apos;re online and the server is running, then try again.
          </Alert>
        </div>
      )}
    </Card>
  );
}
