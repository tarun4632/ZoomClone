// Shared API contract between client/ and server/. Mirrors server/app/schemas.py.
// All datetimes are ISO 8601 strings with a UTC offset (e.g. "2026-10-08T09:30:00Z").
// meeting_number is always the bare 11 digits ("12345678901"); format it for display.

export type MeetingType = "instant" | "scheduled";
export type MeetingStatus = "scheduled" | "live" | "ended";
export type Role = "host" | "attendee";

export interface User {
  id: number;
  name: string;
  email: string;
  avatar_color: string | null;
}

/** Public info, safe for anyone with the meeting number. GET /meetings/{number} */
export interface MeetingPublic {
  meeting_number: string;
  title: string;
  host_name: string;
  meeting_type: MeetingType;
  status: MeetingStatus;
  host_video_on: boolean;
  participant_video_on: boolean;
}

/**
 * Owner view. Returned by GET /meetings (list items), GET /meetings/{number}/details,
 * POST /meetings/instant and POST /meetings.
 * host_key is null for meetings the default user attended but did not host (seeded Recent rows).
 */
export interface MeetingOwner extends MeetingPublic {
  description: string | null;
  scheduled_start_at: string | null;
  duration_minutes: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  passcode: string;
  host_key: string | null;
  invite_url: string;
  is_host: boolean;
}

export type MeetingScope = "upcoming" | "recent";

/** POST /meetings. start_at must be a UTC ISO string (Date.toISOString()). */
export interface ScheduleMeetingInput {
  title: string;
  description: string | null;
  start_at: string;
  duration_minutes: number;
  host_video_on: boolean;
  participant_video_on: boolean;
}

/** POST /meetings/{number}/join. Send host_key OR passcode. */
export interface JoinInput {
  display_name: string;
  passcode?: string;
  host_key?: string;
}

export interface JoinResponse {
  identity: string;
  /** Role at join time. It can change during the meeting (Make Host); read the live role from LiveKit metadata. */
  role: Role;
  token: string;
  livekit_url: string;
  meeting_number: string;
  title: string;
  passcode: string;
  invite_url: string;
  /**
   * Private to this participant. Proves "I am this participant" for in-meeting host actions.
   * Never share it: unlike `identity`, it is not visible to other people in the room.
   */
  participant_secret: string;
}

/**
 * Credentials for in-meeting host actions (end, mute all, mute one, remove, make host).
 * The server allows the action only if this participant's current role is "host".
 */
export interface ParticipantCredentials {
  identity: string;
  participant_secret: string;
}

/**
 * LiveKit participant metadata. The server writes it into the token at join and
 * updates it live when the host role moves (Make Host).
 */
export interface ParticipantMetadata {
  role: Role;
}
