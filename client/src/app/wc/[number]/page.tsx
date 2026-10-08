"use client";

import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
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

  if (stage.name === "room") {
    return <MeetingRoom meetingNumber={number} session={stage.session} />;
  }
  return (
    <PreJoin
      number={number}
      pwd={pwd}
      onJoined={(session) => setStage({ name: "room", session })}
    />
  );
}
