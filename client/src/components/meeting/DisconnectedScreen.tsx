"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, LogOut, UserMinus } from "lucide-react";
import { StatusScreen } from "./StatusScreen";

export type DisconnectKind = "removed" | "ended" | "disconnected" | "failed";

const COPY: Record<DisconnectKind, { title: string; message?: string }> = {
  removed: { title: "You have been removed from this meeting by the host" },
  ended: { title: "This meeting has been ended by the host" },
  disconnected: {
    title: "You have been disconnected",
    message: "The connection to the meeting was lost.",
  },
  failed: {
    title: "Unable to connect to the meeting",
    message: "Check your network connection and try joining again.",
  },
};

const ICONS: Record<DisconnectKind, ReactNode> = {
  removed: <UserMinus className="size-10" aria-hidden />,
  ended: <LogOut className="size-10" aria-hidden />,
  disconnected: <CircleAlert className="size-10" aria-hidden />,
  failed: <CircleAlert className="size-10" aria-hidden />,
};

export function DisconnectedScreen({ kind }: { kind: DisconnectKind }) {
  const router = useRouter();
  const { title, message } = COPY[kind];
  return (
    <StatusScreen
      title={title}
      message={message}
      icon={ICONS[kind]}
      action={{ label: "Back to Home", onClick: () => router.push("/") }}
    />
  );
}
