// "Copy Invitation" text, in Zoom's format.
// No "One tap mobile" or dial-in sections: there is no phone dial-in.
import { format } from "date-fns";
import { formatMeetingNumber } from "./format";
import type { MeetingOwner } from "./types";

/**
 * Name of the browser's time zone at `date` (so daylight saving is right for that day).
 * "short" -> "PDT" / "GMT+5:30", "long" -> "Pacific Daylight Time" / "India Standard Time".
 */
export function timeZoneName(date: Date, style: "short" | "long"): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: style })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName");
    if (part) return part.value;
  } catch {
    // very old browser: fall through
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Oct 9, 2026 10:00 AM PDT" in the browser's time zone. */
function formatInvitationTime(iso: string): string {
  const start = new Date(iso);
  return `${format(start, "MMM d, yyyy h:mm a")} ${timeZoneName(start, "short")}`;
}

export function buildInvitation(meeting: MeetingOwner): string {
  const scheduled = meeting.scheduled_start_at !== null;
  const lines = [
    `${meeting.host_name} is inviting you to ${scheduled ? "a scheduled Zoom meeting." : "a Zoom meeting."}`,
    "",
    `Topic: ${meeting.title}`,
  ];
  if (meeting.scheduled_start_at) lines.push(`Time: ${formatInvitationTime(meeting.scheduled_start_at)}`);
  lines.push(
    "",
    "Join Zoom Meeting",
    meeting.invite_url,
    "",
    `Meeting ID: ${formatMeetingNumber(meeting.meeting_number)}`,
    `Passcode: ${meeting.passcode}`,
  );
  return lines.join("\n");
}
