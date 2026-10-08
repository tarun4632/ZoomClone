"use client";

import { CalendarDays, Plus, Video, type LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import type { User } from "@/lib/types";
import { ThemeToggle } from "./ThemeToggle";
import type { MeetingActions } from "./useMeetingActions";

function NavAction({
  label,
  icon: Icon,
  onClick,
  busy = false,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      aria-busy={busy || undefined}
      className="inline-flex h-10 items-center justify-center rounded-lg px-2.5 text-[18px] font-medium whitespace-nowrap text-ink transition-colors outline-none hover:text-zoom-blue focus-visible:ring-2 focus-visible:ring-zoom-blue disabled:cursor-wait disabled:text-ink-muted md:px-3"
    >
      {/* Text links from md up; icons on phones, where the action card repeats the same actions. */}
      <span className="hidden md:inline">{label}</span>
      <span className="md:hidden" aria-hidden="true">
        {busy ? <Spinner className="size-5" /> : <Icon className="size-5" />}
      </span>
    </button>
  );
}

export function Navbar({ me, actions }: { me: User | null; actions: MeetingActions }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface">
      <div className="mx-auto flex h-16 w-full max-w-[1350px] items-center gap-2 px-4 sm:h-20 sm:px-8">
        <Link
          href="/"
          aria-label="Zoom Clone home"
          className="mr-auto shrink-0 rounded-md p-1 text-zoom-blue outline-none focus-visible:ring-2 focus-visible:ring-zoom-blue"
        >
          <Image src="/zoom-logo.png" alt="Zoom" width={178} height={41} loading="eager" className="h-6 w-auto sm:h-7" />
        </Link>

        <nav aria-label="Meeting actions" className="flex items-center md:gap-4 lg:gap-6">
          <NavAction label="Schedule" icon={CalendarDays} onClick={actions.openSchedule} />
          <NavAction label="Join" icon={Plus} onClick={actions.openJoin} />
          <NavAction label="New Meeting" icon={Video} onClick={actions.newMeeting} busy={actions.starting} />
        </nav>

        <div className="ml-1 flex shrink-0 items-center gap-1 md:ml-4 md:gap-3">
          <ThemeToggle />
          <Avatar name={me?.name ?? null} color={me?.avatar_color} />
        </div>
      </div>
    </header>
  );
}
