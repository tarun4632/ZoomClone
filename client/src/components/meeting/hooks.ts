"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Runs `onUnmount` only when the component really unmounts.
 * React Strict Mode unmounts and remounts every effect once in development; the remount
 * cancels the pending call, so tracks and connections survive that simulated unmount.
 */
export function useRealUnmount(onUnmount: () => void) {
  const callbackRef = useRef(onUnmount);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    callbackRef.current = onUnmount;
  });

  useEffect(() => {
    if (pendingRef.current !== null) {
      window.clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    return () => {
      pendingRef.current = window.setTimeout(() => callbackRef.current(), 0);
    };
  }, []);
}

/** Calls `onOutside` on a pointer-down outside `ref` or on Escape, while `enabled`. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  enabled: boolean,
) {
  const callbackRef = useRef(onOutside);
  useEffect(() => {
    callbackRef.current = onOutside;
  });

  useEffect(() => {
    if (!enabled) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) callbackRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") callbackRef.current();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, enabled]);
}

/** Content-box size of an element, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The observer reports the initial size right after observe().
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
