"use client";

import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useRealUnmount } from "@/components/meeting/hooks";
import { MeetingRoom } from "@/components/meeting/MeetingRoom";
import { PreJoin } from "@/components/meeting/PreJoin";
import { StatusScreen } from "@/components/meeting/StatusScreen";
import type { MeetingSession } from "@/components/meeting/types";

/**
 * /wc/[number]: pre-join stage, then the meeting room stage, on one page, so the name,
 * mic/camera choices and preview tracks pass straight into the room.
 * With cacheComponents, both useParams (no generateStaticParams) and useSearchParams
 * suspend during prerendering, so everything that reads them sits inside <Suspense>.
 */
export default function MeetingPage() {
  return (
    <Suspense fallback={<StatusScreen loading title="Loading meeting…" />}>
      <MeetingStages />
    </Suspense>
  );
}

type Stage = { name: "prejoin" } | { name: "room"; session: MeetingSession };

function MeetingStages() {
  const { number } = useParams<{ number: string }>();
  const pwd = useSearchParams().get("pwd");
  const [stage, setStage] = useState<Stage>({ name: "prejoin" });
  const [visit, setVisit] = useState(0);

  // Next.js keeps this page alive (hidden) after navigating away, and shows it again as it
  // was on browser Back. What it was is a meeting the user has already left (leaving
  // disconnects), or an "ended" notice: a dead screen with nothing to click. So when the page
  // is hidden, go back to a fresh pre-join stage. Coming back then offers to join again and
  // re-checks the meeting. (`key` also resets PreJoin itself: its form, errors, camera.)
  useRealUnmount(() => {
    setStage({ name: "prejoin" });
    setVisit((v) => v + 1);
  });

  if (stage.name === "room") {
    return <MeetingRoom meetingNumber={number} session={stage.session} />;
  }
  return (
    <PreJoin
      key={visit}
      number={number}
      pwd={pwd}
      onJoined={(session) => setStage({ name: "room", session })}
    />
  );
}
