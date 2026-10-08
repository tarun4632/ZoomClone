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

/** POST /auth/signup */
export interface SignupInput {
  name: string;
  email: string;
  password: string;
}

/** POST /auth/login */
export interface LoginInput {
  email: string;
  password: string;
}

/** Sign-up / sign-in result. `access_token` goes back as `Authorization: Bearer <token>`. */
export interface AuthResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
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
  /**
   * True when the request was made by the signed-in owner of this meeting (who created it).
   * Their role inside the meeting can differ: it is in JoinResponse.role, and live in
   * LiveKit metadata, because the host role can pass to someone else.
   */
  is_host: boolean;
  /** Start time of a scheduled meeting; null for an instant one. */
  scheduled_start_at: string | null;
}

/**
 * Owner view, for signed-in users. Returned by GET /meetings (list items),
 * GET /meetings/{number}/details, POST /meetings/instant and POST /meetings.
 * `is_host` is false for meetings the user attended but does not own (they appear in Recent).
 */
export interface MeetingOwner extends MeetingPublic {
  description: string | null;
  duration_minutes: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  passcode: string;
  /** `{origin}/j/{meeting_number}?pwd={invite token}`. The token is random, not the passcode. */
  invite_url: string;
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

/**
 * POST /meetings/{number}/join. The meeting's signed-in owner needs only a name. Anyone else
 * sends the passcode (typed) or the invite link's ?pwd= token.
 * 409 means a scheduled meeting its owner has not started yet: wait and try again once
 * GET /meetings/{number} says "live". 410 means it has ended.
 */
export interface JoinInput {
  display_name: string;
  passcode?: string;
  invite_token?: string;
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
   * Private to this participant. Proves "I am this participant" for leave and host actions.
   * Never share it: unlike `identity`, it is not visible to other people in the room.
   */
  participant_secret: string;
}

/**
 * The caller's own identity + secret from the join response. Needed to leave, and for the
 * host actions (end, mute all, mute one, remove, make host), which the server allows only
 * while this participant's current role is "host".
 */
export interface ParticipantCredentials {
  identity: string;
  participant_secret: string;
}

/**
 * LiveKit participant metadata. The server writes it into the token at join and
 * updates it live when the host role moves (Make Host, or the last host leaving).
 */
export interface ParticipantMetadata {
  role: Role;
}
