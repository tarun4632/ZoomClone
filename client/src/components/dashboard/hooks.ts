"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: T };

/**
 * Client-side fetch with loading / error / ready states.
 * `fetcher` must be stable (module-level or useCallback); a new identity refetches.
 * `reload()` shows the loading state again (Retry); `reload({ silent: true })` keeps the
 * current data on screen while refetching (e.g. after scheduling a meeting).
 */
export function useResource<T>(fetcher: () => Promise<T>) {
  const [state, setState] = useState<Resource<T>>({ status: "loading" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetcher, version]);

  const reload = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setState({ status: "loading" });
    setVersion((v) => v + 1);
  }, []);

  return [state, reload] as const;
}

// Live clock shared by every subscriber. The snapshot is floored to the second so it stays
// stable between ticks. On the server (and during hydration) it is null, so the current time
// is never read while prerendering.
function subscribeToClock(onTick: () => void) {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
}
const getClockSnapshot = () => Math.floor(Date.now() / 1000) * 1000;
const getServerClockSnapshot = () => null;

/** Current time, updated every second; null until mounted in the browser. */
export function useNow(): Date | null {
  const ms = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  return ms === null ? null : new Date(ms);
}

// Local midnight of the current day: only changes once a day, so subscribers re-render at
// midnight rather than every second.
const getTodaySnapshot = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Start of today in the browser's zone; null until mounted in the browser. */
export function useToday(): Date | null {
  const ms = useSyncExternalStore(subscribeToClock, getTodaySnapshot, getServerClockSnapshot);
  return ms === null ? null : new Date(ms);
}
