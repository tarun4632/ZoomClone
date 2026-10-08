"use client";

import { useRouter } from "next/navigation";
import { useCallback, useLayoutEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MeetingOwner, User } from "@/lib/types";
import { JoinMeetingModal } from "./JoinMeetingModal";
import { ScheduleMeetingModal } from "./ScheduleMeetingModal";

/**
 * Schedule / Join / New Meeting, shared by the navbar links and the dashboard's action card
 * (and the navbar on the details page). Render `modals` once in the page.
 */
export function useMeetingActions({
  me,
  onScheduled,
}: {
  me: User | null;
  /** Extra work after scheduling (e.g. refetch Upcoming); the details page opens either way. */
  onScheduled?: (meeting: MeetingOwner) => void;
}) {
  const router = useRouter();
  const [modal, setModal] = useState<"join" | "schedule" | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);

  // With cacheComponents, Next.js keeps a page alive (hidden in <Activity>) after navigating
  // away. Reset the transient UI when it is hidden, so coming back doesn't show a modal that
  // is still open or a New Meeting button stuck on "Starting…".
  useLayoutEffect(() => {
    return () => {
      setModal(null);
      setStarting(false);
      setStartError(false);
    };
  }, []);

  /**
   * Opens the user's own meeting in this tab. Nothing extra goes in the URL: the server
   * recognises the host by their sign-in.
   */
  const startAsHost = useCallback(
    (meeting: MeetingOwner) => {
      router.push(`/wc/${meeting.meeting_number}`);
    },
    [router],
  );

  async function newMeeting() {
    if (starting) return;
    setStarting(true);
    setStartError(false);
    try {
      startAsHost(await api.createInstant());
      // Busy stays on until the meeting page replaces this one.
    } catch {
      setStarting(false);
      setStartError(true);
    }
  }

  function handleScheduled(meeting: MeetingOwner) {
    onScheduled?.(meeting);
    router.push(`/meetings/${meeting.meeting_number}`);
  }

  const close = () => setModal(null);
  const modals = (
    <>
      {modal === "join" && <JoinMeetingModal defaultName={me?.name ?? ""} onClose={close} />}
      {modal === "schedule" && (
        <ScheduleMeetingModal hostName={me?.name ?? null} onClose={close} onScheduled={handleScheduled} />
      )}
    </>
  );

  return {
    openJoin: () => setModal("join"),
    openSchedule: () => setModal("schedule"),
    newMeeting,
    starting,
    startError,
    dismissStartError: () => setStartError(false),
    startAsHost,
    modals,
  };
}

export type MeetingActions = ReturnType<typeof useMeetingActions>;
