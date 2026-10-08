import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** Shared look for text inputs, selects and textareas. */
export const inputClass =
  "block w-full min-w-0 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-muted outline-none dark:bg-page transition-colors hover:border-ink-muted/60 focus:border-zoom-blue focus:ring-2 focus:ring-zoom-blue/20 disabled:bg-surface-muted aria-invalid:border-zoom-danger aria-invalid:focus:ring-zoom-danger/20";

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className = "",
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Inline error box, announced to screen readers. */
export function Alert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-xl border border-zoom-danger/25 bg-zoom-danger/5 px-3.5 py-3 text-sm dark:border-zoom-danger/40 dark:bg-zoom-danger/10">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-zoom-danger dark:text-red-400" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium text-zoom-danger dark:text-red-400">{title}</p>
        {children && <p className="mt-0.5 text-ink-muted">{children}</p>}
      </div>
    </div>
  );
}
