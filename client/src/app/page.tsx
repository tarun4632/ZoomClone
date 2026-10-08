"use client";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { ActionCard } from "@/components/dashboard/ActionCard";
import { useResource } from "@/components/dashboard/hooks";
import { RecentList, UpcomingList } from "@/components/dashboard/MeetingList";
import { Navbar } from "@/components/dashboard/Navbar";
import { ProfileCard } from "@/components/dashboard/ProfileCard";
import { useMeetingActions } from "@/components/dashboard/useMeetingActions";
import { api } from "@/lib/api";

// Module-level so useResource sees stable fetchers.
const fetchMe = () => api.me();
const fetchUpcoming = () => api.listMeetings("upcoming");
const fetchRecent = () => api.listMeetings("recent");

export default function DashboardPage() {
  return (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  );
}

function Dashboard() {
  const [meResource, reloadMe] = useResource(fetchMe);
  const [upcoming, reloadUpcoming] = useResource(fetchUpcoming);
  const [recent, reloadRecent] = useResource(fetchRecent);
  const me = meResource.status === "ready" ? meResource.data : null;

  const actions = useMeetingActions({ me, onScheduled: () => reloadUpcoming({ silent: true }) });

  function retryLists(reload: (opts?: { silent?: boolean }) => void) {
    reload();
    if (meResource.status === "error") reloadMe();
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      <Navbar me={me} actions={actions} />

      {/*
        Desktop: two columns (about 2/3 + 1/3). Phones: one column in the order
        actions, profile, meetings, recent. The column wrappers are `display: contents`
        below lg, so the cards' `order` applies across both columns there.
      */}
      <main className="mx-auto flex w-full max-w-[1350px] flex-1 flex-col gap-5 px-4 py-5 sm:gap-6 sm:px-8 sm:py-8 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-8 lg:py-12">
        <h1 className="sr-only">Home</h1>
        <div className="contents lg:flex lg:flex-col lg:gap-8">
          <ProfileCard me={meResource} onRetry={reloadMe} className="order-2" />
          <RecentList resource={recent} onRetry={() => retryLists(reloadRecent)} className="order-4" />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-8">
          <ActionCard actions={actions} className="order-1" />
          <UpcomingList
            resource={upcoming}
            onRetry={() => retryLists(reloadUpcoming)}
            onStart={actions.startAsHost}
            className="order-3"
          />
        </div>
      </main>

      {actions.modals}
    </div>
  );
}
