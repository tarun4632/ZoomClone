"use client";

import { format } from "date-fns";
import { Check, ChevronLeft, Copy, Play, RefreshCw, SearchX, WifiOff } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useResource } from "@/components/dashboard/hooks";
import { Button } from "@/components/ui/Button";
import { api, ApiError } from "@/lib/api";
import { formatDuration, formatMeetingNumber, formatTimeRange } from "@/lib/format";
import { buildInvitation, timeZoneName } from "@/lib/invitation";
import type { MeetingOwner } from "@/lib/types";

const MEETING_NUMBER = /^\d{11}$/;

export function MeetingDetails({ onStart }: { onStart: (meeting: MeetingOwner) => void }) {
  const params = useParams<{ number: string }>();
  const number = params.number ?? "";

  const fetchDetails = useCallback(
    () =>
      MEETING_NUMBER.test(number)
        ? api.getDetails(number)
        : Promise.reject(new ApiError(404, "Invalid meeting ID")),
    [number],
  );
  const [resource, reload] = useResource(fetchDetails);

  if (resource.status === "loading") return <DetailsSkeleton />;

  if (resource.status === "error") {
    const notFound = resource.error instanceof ApiError && resource.error.status === 404;
    return notFound ? (
      <StateCard
        icon={<SearchX className="size-6" aria-hidden="true" />}
        title="Invalid meeting ID"
        detail="This meeting doesn't exist. Check the meeting ID or link and try again."
        action={
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-lg bg-zoom-blue px-4 text-sm font-medium text-white transition-colors hover:bg-zoom-blue-hover"
          >
            Back to Home
          </Link>
        }
      />
    ) : (
      <StateCard
        icon={<WifiOff className="size-6" aria-hidden="true" />}
        title={resource.error instanceof ApiError ? "Couldn't load this meeting" : "Can't reach the server"}
        detail={
          resource.error instanceof ApiError
            ? "Something went wrong on our side. Please try again."
            : "Check your connection, or make sure the API server is running."
        }
        action={
          <Button variant="soft" onClick={() => reload()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Retry
          </Button>
        }
      />
    );
  }

  return <DetailsView meeting={resource.data} onStart={onStart} />;
}

// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API missing (non-HTTPS origin) or denied: fall back to a hidden textarea.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    textarea.remove();
    return ok;
  }
}

function describeTime(meeting: MeetingOwner): string {
  if (!meeting.scheduled_start_at) return "Instant meeting";
  const start = new Date(meeting.scheduled_start_at);
  const range = meeting.duration_minutes
    ? formatTimeRange(meeting.scheduled_start_at, meeting.duration_minutes)
    : format(start, "h:mm a");
  return `${format(start, "EEE, MMM d, yyyy")} ${range} ${timeZoneName(start, "short")}`;
}

function DetailsView({ meeting, onStart }: { meeting: MeetingOwner; onStart: (meeting: MeetingOwner) => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  const invitation = buildInvitation(meeting);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function handleCopy() {
    const ok = await copyToClipboard(invitation);
    setCopyState(ok ? "copied" : "failed");
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <div>
      <Link
        href="/"
        className="mb-5 inline-flex items-center gap-1 rounded-md text-[15px] font-medium text-zoom-blue outline-none hover:underline focus-visible:ring-2 focus-visible:ring-zoom-blue"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Home
      </Link>

      <article aria-labelledby="meeting-title" className="overflow-hidden rounded-card bg-surface shadow-card">
        <header className="flex flex-col gap-5 border-b border-line p-5 sm:flex-row sm:items-start sm:justify-between sm:p-8">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm font-medium text-ink-muted">
              <span>{meeting.meeting_type === "scheduled" ? "Scheduled meeting" : "Instant meeting"}</span>
              <StatusBadge status={meeting.status} />
            </div>
            <h1 id="meeting-title" className="text-2xl leading-tight font-bold tracking-tight break-words text-ink sm:text-[30px]">
              {meeting.title}
            </h1>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="soft" onClick={handleCopy} aria-live="polite" className="min-w-44">
              {copyState === "copied" ? (
                <>
                  <Check className="size-4" aria-hidden="true" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="size-4" aria-hidden="true" />
                  {copyState === "failed" ? "Copy failed, retry" : "Copy Invitation"}
                </>
              )}
            </Button>
            {meeting.host_key && (
              <Button onClick={() => onStart(meeting)} className="min-w-28">
                <Play className="size-4 fill-current" aria-hidden="true" />
                Start
              </Button>
            )}
          </div>
        </header>

        <dl className="divide-y divide-line px-5 py-2 sm:px-8 sm:py-3">
          <Row label="Topic">{meeting.title}</Row>
          {meeting.description && <Row label="Description">{meeting.description}</Row>}
          <Row label="Time">{describeTime(meeting)}</Row>
          <Row label="Duration">{meeting.duration_minutes ? formatDuration(meeting.duration_minutes) : "—"}</Row>
          <Row label="Meeting ID">
            <span className="tabular-nums">{formatMeetingNumber(meeting.meeting_number)}</span>
          </Row>
          <Row label="Passcode">
            <span className="font-mono">{meeting.passcode}</span>
          </Row>
          <Row label="Invite Link">
            <a href={meeting.invite_url} className="break-all text-zoom-blue hover:underline">
              {meeting.invite_url}
            </a>
          </Row>
          <Row label="Video">
            <span className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Host: <span className="font-medium">{meeting.host_video_on ? "On" : "Off"}</span>
              </span>
              <span>
                Participant: <span className="font-medium">{meeting.participant_video_on ? "On" : "Off"}</span>
              </span>
            </span>
          </Row>
        </dl>

        <details className="border-t border-line px-5 py-5 sm:px-8">
          <summary className="cursor-pointer text-[15px] font-medium text-zoom-blue select-none">Show invitation</summary>
          <pre className="mt-3 overflow-x-auto rounded-xl bg-surface-muted p-4 font-sans text-sm leading-6 whitespace-pre-wrap break-words text-ink">
            {invitation}
          </pre>
        </details>
      </article>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-[15px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-[15px] break-words whitespace-pre-line text-ink">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: MeetingOwner["status"] }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zoom-blue-soft px-2 py-0.5 text-[11px] font-semibold text-zoom-blue">
        <span className="size-1.5 animate-pulse rounded-full bg-zoom-blue" aria-hidden="true" />
        In progress
      </span>
    );
  }
  if (status === "ended") {
    return (
      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-muted">Ended</span>
    );
  }
  return null;
}

function StateCard({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-card bg-surface px-6 py-14 text-center shadow-card">
      <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-muted text-ink-muted">
        {icon}
      </span>
      <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
      <p className="mt-2 max-w-sm text-[15px] text-ink-muted">{detail}</p>
      <div className="mt-6">{action}</div>
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading meeting details">
      <div className="mb-5 h-5 w-16 rounded bg-surface-muted" />
      <div className="animate-pulse rounded-card bg-surface shadow-card">
        <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:justify-between sm:p-8">
          <div className="space-y-2">
            <div className="h-3 w-28 rounded bg-surface-muted" />
            <div className="h-8 w-64 max-w-full rounded bg-surface-muted" />
          </div>
          <div className="flex gap-2">
            <div className="h-10 w-44 rounded-xl bg-surface-muted" />
            <div className="h-10 w-28 rounded-lg bg-surface-muted" />
          </div>
        </div>
        <div className="space-y-5 px-5 py-6 sm:px-8">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:gap-6">
              <div className="h-3.5 w-20 rounded bg-surface-muted" />
              <div className="h-3.5 w-3/4 rounded bg-surface-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
