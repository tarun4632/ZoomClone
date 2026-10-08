"use client";

import { useRef, useState } from "react";
import { Check, Copy, Info } from "lucide-react";
import { formatMeetingNumber } from "@/lib/format";
import { useClickOutside } from "./hooks";

interface MeetingInfoProps {
  title: string;
  meetingNumber: string;
  hostName: string | null;
  passcode: string;
  inviteUrl: string;
}

/** Zoom's top-left "ⓘ Meeting title" pill; opens the meeting-info popover. */
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
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Meeting information: ${title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-sm font-semibold text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-zoom-blue"
      >
        <Info className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Meeting information"
          className="absolute top-full left-0 z-40 mt-1.5 w-[min(22rem,calc(100vw-1rem))] rounded-lg bg-[#2b2b2b] p-4 text-sm text-white shadow-2xl ring-1 ring-white/10"
        >
          <h2 className="mb-3 text-base font-semibold break-words">{title}</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-[#a6a6a6]">Meeting ID</dt>
            <dd>{formatMeetingNumber(meetingNumber)}</dd>
            {hostName && (
              <>
                <dt className="text-[#a6a6a6]">Host</dt>
                <dd className="break-words">{hostName}</dd>
              </>
            )}
            <dt className="text-[#a6a6a6]">Passcode</dt>
            <dd>{passcode}</dd>
            <dt className="text-[#a6a6a6]">Invite Link</dt>
            <dd className="break-all">{inviteUrl}</dd>
          </dl>
          <button
            type="button"
            onClick={copyLink}
            className="mt-4 flex items-center gap-1.5 rounded-md bg-zoom-blue px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zoom-blue-hover"
          >
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}
