"use client";

import { addDays, format, isBefore } from "date-fns";
import { LogIn, Play, RefreshCw, WifiOff } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ApiError } from "@/lib/api";
import { formatMeetingNumber, formatTimeRange } from "@/lib/format";
import type { MeetingOwner } from "@/lib/types";
import { useToday, type Resource } from "./hooks";

// ---------------------------------------------------------------------------
// Shared pieces

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading meetings" className="divide-y divide-line">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-28 rounded bg-surface-muted" />
            <div className="h-4 w-3/4 rounded bg-surface-muted" />
            <div className="h-3 w-36 rounded bg-surface-muted" />
          </div>
          <div className="h-9 w-20 rounded-xl bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

function ListError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const unreachable = !(error instanceof ApiError);
  return (
    <div role="alert" className="flex flex-col items-center px-4 py-8 text-center">
      <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-surface-muted text-ink-muted">
        <WifiOff className="size-5" aria-hidden="true" />
      </span>
      <p className="text-base font-bold text-ink">
        {unreachable ? "Can't reach the server" : "Couldn't load your meetings"}
      </p>
      <p className="mt-1 max-w-72 text-sm text-ink-muted">
        {unreachable
          ? "Check your connection, or make sure the API server is running."
          : "Something went wrong on our side. Please try again."}
      </p>
      <Button variant="soft" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

/**
 * Compact row. The title is a "stretched" link (its ::after covers the row), so the whole row
 * opens the details page while the Start button still sits on top and stays clickable.
 */
function MeetingRow({
  meeting,
  eyebrow,
  badge,
  action,
}: {
  meeting: MeetingOwner;
  eyebrow: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="relative flex items-center gap-3 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted">
          <span className="tabular-nums">{eyebrow}</span>
          {badge}
        </p>
        {/* Every row opens its details page, including meetings the user only attended
            (that page then shows who hosted and has no Start button). */}
        <Link
          href={`/meetings/${meeting.meeting_number}`}
          className="mt-0.5 block truncate text-[15px] font-semibold text-ink outline-none transition-colors after:absolute after:-inset-x-2 after:inset-y-0.5 after:rounded-xl hover:text-zoom-blue focus-visible:after:ring-2 focus-visible:after:ring-zoom-blue"
        >
          {meeting.title}
        </Link>
        <p className="mt-0.5 text-[13px] text-ink-muted tabular-nums">
          Meeting ID: {formatMeetingNumber(meeting.meeting_number)}
        </p>
      </div>
      {action && <div className="relative z-10 shrink-0">{action}</div>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Meetings (upcoming)

interface DayGroup {
  key: string;
  label: string;
  meetings: MeetingOwner[];
}

/** Today / Tomorrow / "Mon, Oct 12". An empty Today group is always first. */
function groupByDay(meetings: MeetingOwner[], today: Date): DayGroup[] {
  const tomorrowKey = format(addDays(today, 1), "yyyy-MM-dd");
  const todayKey = format(today, "yyyy-MM-dd");

  const sorted = meetings
    .filter((m) => m.scheduled_start_at)
    .sort((a, b) => Date.parse(a.scheduled_start_at!) - Date.parse(b.scheduled_start_at!));

  const groups = new Map<string, DayGroup>();
  groups.set(todayKey, { key: todayKey, label: "Today", meetings: [] });

  for (const m of sorted) {
    const start = new Date(m.scheduled_start_at!);
    // A meeting still running from an earlier day (live past its slot) belongs under Today.
    const key = isBefore(start, today) ? todayKey : format(start, "yyyy-MM-dd");
    let group = groups.get(key);
    if (!group) {
      const label = key === tomorrowKey ? "Tomorrow" : format(start, "EEE, MMM d");
      group = { key, label, meetings: [] };
      groups.set(key, group);
    }
    group.meetings.push(m);
  }
  return [...groups.values()];
}

function upcomingTime(m: MeetingOwner): string | null {
  if (!m.scheduled_start_at) return null;
  return m.duration_minutes
    ? formatTimeRange(m.scheduled_start_at, m.duration_minutes)
    : format(new Date(m.scheduled_start_at), "h:mm a");
}

export function UpcomingList({
  resource,
  onRetry,
  onStart,
  className = "",
}: {
  resource: Resource<MeetingOwner[]>;
  onRetry: () => void;
  onStart: (meeting: MeetingOwner) => void;
  className?: string;
}) {
  const today = useToday();
  let body: ReactNode;
  if (resource.status === "error") {
    body = <ListError error={resource.error} onRetry={onRetry} />;
  } else if (resource.status === "loading" || !today) {
    body = <ListSkeleton />;
  } else {
    body = groupByDay(resource.data, today).map((group) => (
      <div key={group.key} className="mt-5 first:mt-0">
        <h3 className="text-sm font-semibold text-ink-muted">{group.label}</h3>
        {group.meetings.length === 0 ? (
          <p className="mt-2.5 rounded-xl bg-surface-muted px-4 py-3.5 text-[17px] font-bold text-ink">
            No upcoming meetings today
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {group.meetings.map((m) => (
              <MeetingRow
                key={m.meeting_number}
                meeting={m}
                eyebrow={upcomingTime(m)}
                badge={
                  m.status === "live" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zoom-blue-soft px-2 py-0.5 text-[11px] font-semibold text-zoom-blue">
                      <span className="size-1.5 animate-pulse rounded-full bg-zoom-blue" aria-hidden="true" />
                      In progress
                    </span>
                  )
                }
                action={
                  m.host_key && (
                    // A live meeting is joined, not started (as in Zoom). Same action: enter as host.
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() => onStart(m)}
                      aria-label={`${m.status === "live" ? "Join" : "Start"} ${m.title}`}
                    >
                      {m.status === "live" ? (
                        <LogIn className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Play className="size-3.5 fill-current" aria-hidden="true" />
                      )}
                      {m.status === "live" ? "Join" : "Start"}
                    </Button>
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    ));
  }

  return (
    <Card aria-labelledby="meetings-heading" className={className}>
      <CardTitle id="meetings-heading">Meetings</CardTitle>
      <div className="mt-5">{body}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent meetings

function recentDate(m: MeetingOwner): string {
  const iso = m.ended_at ?? m.started_at ?? m.scheduled_start_at ?? m.created_at;
  return format(new Date(iso), "EEE, MMM d, yyyy · h:mm a");
}

const endedAt = (m: MeetingOwner) => Date.parse(m.ended_at ?? m.started_at ?? m.created_at);

/** An open cardboard box in Zoom blues, for the empty state. */
function EmptyBox() {
  return (
    <svg viewBox="10 6 185 136" aria-hidden="true" className="h-auto w-40 sm:w-44">
      <ellipse cx="108" cy="130" rx="72" ry="8" fill="#0b5cff" opacity="0.08" />
      {/* back flaps */}
      <polygon points="45,52 100,34 80,14 25,32" fill="#cddfff" />
      <polygon points="100,34 155,52 175,32 120,14" fill="#9dbfff" />
      {/* inside of the box */}
      <polygon points="45,52 100,34 155,52 100,70" fill="#1f3fae" />
      <polygon points="45,52 100,34 100,46 60,59" fill="#2f55d4" />
      {/* sides */}
      <polygon points="45,52 100,70 100,128 45,108" fill="#4b8dff" />
      <polygon points="100,70 155,52 155,108 100,128" fill="#0b5cff" />
      {/* front flaps, folded outward */}
      <polygon points="45,52 100,70 72,52 17,34" fill="#e8f0ff" />
      <polygon points="100,70 155,52 183,34 128,52" fill="#b9d2ff" />
    </svg>
  );
}

export function RecentList({
  resource,
  onRetry,
  className = "",
}: {
  resource: Resource<MeetingOwner[]>;
  onRetry: () => void;
  className?: string;
}) {
  let body: ReactNode;
  if (resource.status === "error") {
    body = <ListError error={resource.error} onRetry={onRetry} />;
  } else if (resource.status === "loading") {
    body = <ListSkeleton />;
  } else if (resource.data.length === 0) {
    body = (
      <div className="flex flex-col items-center py-10 text-center">
        <EmptyBox />
        <p className="mt-5 text-lg font-bold text-ink">No recent meetings</p>
      </div>
    );
  } else {
    const sorted = [...resource.data].sort((a, b) => endedAt(b) - endedAt(a));
    body = (
      <ul className="divide-y divide-line">
        {sorted.map((m) => (
          <MeetingRow
            key={`${m.meeting_number}-${m.ended_at}`}
            meeting={m}
            eyebrow={recentDate(m)}
          />
        ))}
      </ul>
    );
  }

  return (
    <Card aria-labelledby="recent-heading" className={className}>
      <CardTitle id="recent-heading">Recent meetings</CardTitle>
      <hr className="mt-5 border-line" />
      <div className="mt-1">{body}</div>
    </Card>
  );
}
