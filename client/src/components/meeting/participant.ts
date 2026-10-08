import type { Participant } from "livekit-client";
import type { ParticipantMetadata, Role } from "@/lib/types";

/** Role from the token metadata the server writes: {"role": "host" | "attendee"}. */
export function parseRole(metadata: string | undefined): Role {
  if (!metadata) return "attendee";
  try {
    const parsed = JSON.parse(metadata) as Partial<ParticipantMetadata>;
    return parsed.role === "host" ? "host" : "attendee";
  } catch {
    return "attendee";
  }
}

export function participantName(name: string | undefined, participant: Participant): string {
  return name?.trim() || participant.name?.trim() || participant.identity || "Guest";
}

/** "(Host)", "(me)", "(Host, me)" or "". */
export function roleSuffix(isHost: boolean, isMe: boolean): string {
  const parts = [isHost && "Host", isMe && "me"].filter(Boolean);
  return parts.length ? `(${parts.join(", ")})` : "";
}
