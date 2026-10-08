// The signed-in user's bearer token. The server returns it once on sign-up / sign-in and
// api.ts sends it back as `Authorization: Bearer <token>`.
//
// It lives in localStorage, so it survives reloads and is shared by every tab. The API is on
// another origin, where a cookie would be a third-party cookie that browsers increasingly
// block; the cost is that script running on this page could read the token, so nothing here
// renders untrusted HTML.

import { useSyncExternalStore } from "react";

const TOKEN_KEY = "zc:authToken";
const CHANGE_EVENT = "zc:auth-change";

/**
 * The seeded demo account (server/app/seed.py). Its password is public on purpose: the
 * sign-in page offers it as "Use the demo account" so a visitor can try the app at once.
 */
export const DEMO_ACCOUNT = { email: "alex.johnson@example.com", password: "zoomclone-demo" };

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked: behave as signed out
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked (private mode etc.): the sign-in can't be kept
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored, nothing to clear
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  // `storage` fires for a sign-in or sign-out in another tab; CHANGE_EVENT for this one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const getServerToken = () => undefined;

/**
 * The current token, live: a string when signed in, null when signed out, and undefined on
 * the server and during hydration (when it can't be known yet).
 */
export function useAuthToken(): string | null | undefined {
  return useSyncExternalStore(subscribe, getToken, getServerToken);
}

/** Where to go after signing in: only a path inside this site, never another origin. */
export function safeNextPath(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
