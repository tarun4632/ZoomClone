"use client";

import { Suspense } from "react";
import { useResource } from "@/components/dashboard/hooks";
import { Navbar } from "@/components/dashboard/Navbar";
import { useMeetingActions } from "@/components/dashboard/useMeetingActions";
import { Alert } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { DetailsSkeleton, MeetingDetails } from "./MeetingDetails";

const fetchMe = () => api.me();

export default function MeetingDetailsPage() {
  const [meResource] = useResource(fetchMe);
  const me = meResource.status === "ready" ? meResource.data : null;
  // The navbar's Schedule / Join / New Meeting links work here too.
  const actions = useMeetingActions({ me });

  return (
    <div className="flex flex-1 flex-col bg-surface">
      <Navbar me={me} actions={actions} />
      <main className="mx-auto w-full max-w-[960px] flex-1 px-4 py-5 sm:px-8 sm:py-8 lg:py-12">
        {actions.startError && (
          <div className="mb-5">
            <Alert title="Couldn't start a new meeting">
              Make sure you&apos;re online and the server is running, then try again.
            </Alert>
          </div>
        )}
        {/* useParams suspends while prerendering a dynamic route under cacheComponents. */}
        <Suspense fallback={<DetailsSkeleton />}>
          <MeetingDetails onStart={actions.startAsHost} />
        </Suspense>
      </main>
      {actions.modals}
    </div>
  );
}
