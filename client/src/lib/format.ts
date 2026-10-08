import { addMinutes, format } from "date-fns";

/** "12345678901" -> "123 4567 8901" (Zoom's 3-4-4 grouping). */
export function formatMeetingNumber(number: string): string {
  const d = number.replace(/\D/g, "");
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
}

/** "10:00 AM - 11:00 AM" in the browser's time zone. */
export function formatTimeRange(startIso: string, durationMinutes: number): string {
  const start = new Date(startIso);
  return `${format(start, "h:mm a")} - ${format(addMinutes(start, durationMinutes), "h:mm a")}`;
}

/** 90 -> "1 hr 30 min", 45 -> "45 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  return h ? `${h} hr` : `${m} min`;
}

/** Up to two initials for avatars and video-off tiles. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
