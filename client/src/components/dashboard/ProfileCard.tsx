"use client";

import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { User } from "@/lib/types";
import { useNow, type Resource } from "./hooks";

/** Live clock; its own component so only it re-renders every second. */
function Clock() {
  const now = useNow();
  return (
    <div className="shrink-0 sm:text-right">
      <time
        dateTime={now?.toISOString()}
        className="block text-4xl leading-none font-bold tracking-tight text-ink tabular-nums sm:text-[44px]"
      >
        {now ? format(now, "h:mm") : "--:--"}
        <span className="ml-1.5 text-xl font-semibold sm:text-2xl">{now ? format(now, "a") : ""}</span>
      </time>
      <p className="mt-2 text-[15px] text-ink-muted">{now ? format(now, "EEEE, MMMM d, yyyy") : " "}</p>
    </div>
  );
}

/** The signed-in (default) user, with the live clock and today's date on the right. */
export function ProfileCard({
  me,
  onRetry,
  className = "",
}: {
  me: Resource<User>;
  onRetry: () => void;
  className?: string;
}) {
  let identity;
  if (me.status === "ready") {
    identity = (
      <div className="min-w-0">
        <p className="truncate text-2xl leading-tight font-bold tracking-tight text-ink sm:text-[30px]">
          {me.data.name}
        </p>
        <p className="mt-1 truncate text-[15px] text-ink-muted">{me.data.email}</p>
      </div>
    );
  } else if (me.status === "loading") {
    identity = (
      <div aria-busy="true" aria-label="Loading profile" className="w-full max-w-60 animate-pulse space-y-3">
        <div className="h-7 w-4/5 rounded-md bg-surface-muted" />
        <div className="h-4 w-3/5 rounded-md bg-surface-muted" />
      </div>
    );
  } else {
    identity = (
      <div role="alert" className="min-w-0">
        <p className="text-lg font-bold text-ink">Couldn&apos;t load your profile</p>
        <Button variant="soft" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Card aria-label="Profile" className={`flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <div className="flex min-w-0 items-center gap-5">
        <Avatar
          size="xl"
          name={me.status === "ready" ? me.data.name : null}
          color={me.status === "ready" ? me.data.avatar_color : null}
        />
        {identity}
      </div>
      <Clock />
    </Card>
  );
}
