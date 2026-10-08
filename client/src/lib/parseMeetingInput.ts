// Parses what a user types or pastes into the Join modal.
// Accepts "123 4567 8901", "12345678901", "123-4567-8901", or a full invite link
// "http(s)://host/j/{number}?pwd=..." (also "/wc/{number}", and links pasted without the scheme).

export interface ParsedMeetingInput {
  /** Bare 11 digits. */
  number: string;
  /** Passcode from the link's ?pwd=, or null. */
  pwd: string | null;
}

const MEETING_NUMBER = /^\d{11}$/;
const LINK_PATH = /^\/(?:j|wc)\/(\d{11})\/?$/;

export function parseMeetingInput(raw: string): ParsedMeetingInput | null {
  const input = raw.trim();
  if (!input) return null;

  const digits = input.replace(/[\s-]/g, "");
  if (MEETING_NUMBER.test(digits)) return { number: digits, pwd: null };

  if (!input.includes("/")) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const match = url.pathname.match(LINK_PATH);
  if (!match) return null;

  const pwd = url.searchParams.get("pwd");
  return { number: match[1], pwd: pwd ? pwd : null };
}
