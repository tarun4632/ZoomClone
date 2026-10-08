// Thin fetch wrappers, one per endpoint. Shared by the dashboard and the meeting room.
import { clearToken, getToken } from "./auth";
import type {
  AuthResponse,
  JoinInput,
  JoinResponse,
  LoginInput,
  MeetingOwner,
  MeetingPublic,
  MeetingScope,
  ParticipantCredentials,
  ScheduleMeetingInput,
  SignupInput,
  User,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

/** Non-2xx response. `status` lets callers branch on 401 / 403 / 404 / 410. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Signed-in requests carry the bearer token; guests (invite-link joins) send none.
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_URL}/api${path}`, { ...init, headers });
  if (!res.ok) {
    // The server no longer accepts this token (expired, or signed out elsewhere): forget it.
    // Pages that need a signed-in user notice and send the user to /login.
    if (res.status === 401 && token && getToken() === token) clearToken();
    let message = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(
    path,
    body === undefined
      ? { method: "POST" }
      : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );

/**
 * Body of the leave request. Form-encoded, not JSON: navigator.sendBeacon may send that
 * cross-origin without a CORS preflight, which would not finish while the tab is closing.
 */
export const leaveBody = (secret: string) => new URLSearchParams({ participant_secret: secret });

export const api = {
  signup: (input: SignupInput) => post<AuthResponse>("/auth/signup", input),
  login: (input: LoginInput) => post<AuthResponse>("/auth/login", input),
  /** Revokes the current token on the server. The caller then forgets it (clearToken). */
  logout: () => post<void>("/auth/logout"),
  me: () => request<User>("/me"),

  listMeetings: (scope: MeetingScope) => request<MeetingOwner[]>(`/meetings?scope=${scope}`),
  createInstant: () => post<MeetingOwner>("/meetings/instant"),
  scheduleMeeting: (input: ScheduleMeetingInput) => post<MeetingOwner>("/meetings", input),

  getMeeting: (number: string) => request<MeetingPublic>(`/meetings/${number}`),
  getDetails: (number: string) => request<MeetingOwner>(`/meetings/${number}/details`),

  join: (number: string, input: JoinInput) => post<JoinResponse>(`/meetings/${number}/join`, input),
  /** `me` proves the caller is that participant: nobody can "leave" on someone else's behalf. */
  leave: (number: string, me: ParticipantCredentials) =>
    request<void>(`/meetings/${number}/participants/${me.identity}/leave`, {
      method: "POST",
      body: leaveBody(me.participant_secret),
    }),

  /**
   * Asks the server to re-check who is really connected (it asks LiveKit). This is how a
   * host whose browser crashed, and so never sent a leave, gets replaced.
   */
  syncParticipants: (number: string, me: ParticipantCredentials) => post<void>(`/meetings/${number}/sync`, me),

  // In-meeting host actions. `me` is the caller's own identity + secret from the join response;
  // the server checks that the caller's current role is "host" (403 otherwise).
  end: (number: string, me: ParticipantCredentials) => post<void>(`/meetings/${number}/end`, me),
  muteAll: (number: string, me: ParticipantCredentials) => post<void>(`/meetings/${number}/mute-all`, me),
  muteParticipant: (number: string, target: string, me: ParticipantCredentials) =>
    post<void>(`/meetings/${number}/participants/${target}/mute`, me),
  removeParticipant: (number: string, target: string, me: ParticipantCredentials) =>
    post<void>(`/meetings/${number}/participants/${target}/remove`, me),
  /** Hands the host role to `target`; the caller becomes an attendee. */
  makeHost: (number: string, target: string, me: ParticipantCredentials) =>
    post<void>(`/meetings/${number}/participants/${target}/make-host`, me),
};

/** URL for navigator.sendBeacon on pagehide; send `leaveBody(secret)` with it. */
export const leaveUrl = (number: string, identity: string) =>
  `${API_URL}/api/meetings/${number}/participants/${identity}/leave`;
