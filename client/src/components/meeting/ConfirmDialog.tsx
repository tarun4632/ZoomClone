"use client";

import { useState } from "react";

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** May reject; the dialog stays open and the caller shows the error. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** Small centred confirmation used by host actions (Remove, Mute All). Render it only while open. */
export function ConfirmDialog({ message, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="presentation"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        className="w-full max-w-sm rounded-xl bg-room-panel p-5 text-room-text shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm leading-relaxed">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-room-text ring-1 ring-white/15 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            autoFocus
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60 ${
              danger ? "bg-zoom-danger hover:bg-zoom-danger-hover" : "bg-zoom-blue hover:bg-zoom-blue-hover"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
