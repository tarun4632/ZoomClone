"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

interface StatusScreenProps {
  title: string;
  message?: string;
  loading?: boolean;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
}

/** Full-screen dark state: loading, invalid ID, ended, removed, connection errors. */
export function StatusScreen({ title, message, loading, icon, action }: StatusScreenProps) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center overflow-y-auto bg-room-bg px-4 text-center text-room-text">
      {loading ? (
        <LoaderCircle className="mb-4 size-8 animate-spin text-room-text-muted" aria-hidden />
      ) : (
        icon && <div className="mb-4 text-room-text-muted">{icon}</div>
      )}
      <h1 className="text-lg font-semibold sm:text-xl">{title}</h1>
      {message && <p className="mt-2 max-w-sm text-sm text-room-text-muted">{message}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 rounded-lg bg-zoom-blue px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zoom-blue-hover"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
