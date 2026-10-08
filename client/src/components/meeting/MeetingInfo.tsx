"use client";

import { useRef, useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { formatMeetingNumber } from "@/lib/format";
import { useClickOutside } from "./hooks";

interface MeetingInfoProps {
  title: string;
  meetingNumber: string;
  hostName: string | null;
  passcode: string;
  inviteUrl: string;
}

/** Green shield at the top-left; opens the meeting-info popover. */
export function MeetingInfo({ title, meetingNumber, hostName, passcode, inviteUrl }: MeetingInfoProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked; the link is still visible to copy by hand
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Meeting information"
        aria-expanded={open}
        className="flex size-8 items-center justify-center rounded-md text-secure transition-colors hover:bg-white/10"
      >
        <ShieldCheck className="size-5" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Meeting information"
          className="absolute top-full left-0 z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl bg-room-panel p-4 text-sm text-room-text shadow-2xl ring-1 ring-white/10"
        >
          <h2 className="mb-3 text-base font-semibold break-words">{title}</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-room-text-muted">Meeting ID</dt>
            <dd>{formatMeetingNumber(meetingNumber)}</dd>
            {hostName && (
              <>
                <dt className="text-room-text-muted">Host</dt>
                <dd className="break-words">{hostName}</dd>
              </>
            )}
            <dt className="text-room-text-muted">Passcode</dt>
            <dd>{passcode}</dd>
            <dt className="text-room-text-muted">Invite Link</dt>
            <dd className="break-all text-room-text">{inviteUrl}</dd>
          </dl>
          <button
            type="button"
            onClick={copyLink}
            className="mt-4 flex items-center gap-1.5 rounded-lg bg-zoom-blue px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zoom-blue-hover"
          >
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-room-text-muted">
            <ShieldCheck className="size-3.5 text-secure" aria-hidden />
            You are connected to a secure meeting
          </p>
        </div>
      )}
    </div>
  );
}
