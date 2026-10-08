// Thin fetch wrappers, one per endpoint. Shared by the dashboard and the meeting room.
import type {
  JoinInput,
  JoinResponse,
  MeetingOwner,
  MeetingPublic,
  MeetingScope,
  ParticipantCredentials,
  ScheduleMeetingInput,
  User,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

/** Non-2xx response. `status` lets callers branch on 403 / 404 / 410. */
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
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
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
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => request<User>("/me"),

  listMeetings: (scope: MeetingScope) => request<MeetingOwner[]>(`/meetings?scope=${scope}`),
  createInstant: () => post<MeetingOwner>("/meetings/instant"),
  scheduleMeeting: (input: ScheduleMeetingInput) => post<MeetingOwner>("/meetings", input),

  getMeeting: (number: string) => request<MeetingPublic>(`/meetings/${number}`),
  getDetails: (number: string) => request<MeetingOwner>(`/meetings/${number}/details`),

  join: (number: string, input: JoinInput) => post<JoinResponse>(`/meetings/${number}/join`, input),
  leave: (number: string, identity: string) =>
    post<void>(`/meetings/${number}/participants/${identity}/leave`),

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

/** URL for navigator.sendBeacon on pagehide. No body, so no CORS preflight. */
export const leaveUrl = (number: string, identity: string) =>
  `${API_URL}/api/meetings/${number}/participants/${identity}/leave`;
