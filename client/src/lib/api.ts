// Thin fetch wrappers, one per endpoint. Shared by the dashboard and the meeting room.
import type {
  JoinInput,
  JoinResponse,
  MeetingOwner,
  MeetingPublic,
  MeetingScope,
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

  end: (number: string, hostKey: string) => post<void>(`/meetings/${number}/end`, { host_key: hostKey }),
  muteAll: (number: string, hostKey: string) =>
    post<void>(`/meetings/${number}/mute-all`, { host_key: hostKey }),
  removeParticipant: (number: string, identity: string, hostKey: string) =>
    post<void>(`/meetings/${number}/participants/${identity}/remove`, { host_key: hostKey }),
};

/** URL for navigator.sendBeacon on pagehide. No body, so no CORS preflight. */
export const leaveUrl = (number: string, identity: string) =>
  `${API_URL}/api/meetings/${number}/participants/${identity}/leave`;
