"use client";

import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  /** Called on Esc, the close button, or a click on the backdrop. The parent unmounts the modal. */
  onClose: () => void;
  /** Ignore close requests, e.g. while a request is in flight. */
  closeDisabled?: boolean;
  /** Tailwind max-width class for the panel. */
  widthClassName?: string;
  children: ReactNode;
}

/**
 * Accessible modal built on the native <dialog> element, opened with showModal():
 * the browser traps focus, makes the page behind inert, and renders the backdrop.
 * Render it only while open (`{open && <Modal …/>}`) so its contents reset each time.
 * Put `data-autofocus` on the element that should receive focus first.
 */
export function Modal({ title, onClose, closeDisabled = false, widthClassName = "max-w-md", children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pointerDownOnBackdrop = useRef(false);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";

    return () => {
      root.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  const requestClose = () => {
    if (!closeDisabled) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Esc: let React decide by unmounting, instead of the browser closing the dialog itself.
        e.preventDefault();
        requestClose();
      }}
      onMouseDown={(e) => {
        pointerDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // The dialog has no padding, so a click whose target is the dialog itself landed on the backdrop.
        if (pointerDownOnBackdrop.current && e.target === e.currentTarget) requestClose();
        pointerDownOnBackdrop.current = false;
      }}
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${widthClassName} overflow-hidden rounded-card bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/45 open:flex open:flex-col`}
    >
      <div className="flex shrink-0 items-center justify-between gap-4 px-5 pt-5 pb-4 sm:px-8 sm:pt-7">
        <h2 id={titleId} className="text-xl font-bold tracking-tight sm:text-[22px]">
          {title}
        </h2>
        <button
          type="button"
          onClick={requestClose}
          disabled={closeDisabled}
          aria-label="Close"
          className="-mr-2 inline-flex size-9 items-center justify-center rounded-full text-ink-muted transition-colors outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-zoom-blue disabled:opacity-50"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

/** Scrollable middle section. */
export function ModalBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-8 ${className}`}>{children}</div>;
}

/** Right-aligned action row. */
export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-4 sm:px-8 sm:py-5">{children}</div>
  );
}
