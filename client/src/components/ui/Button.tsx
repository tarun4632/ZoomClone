import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

/**
 * primary: solid Zoom blue ("Upgrade today" in Zoom's portal).
 * soft: light-blue pill with blue text ("Manage Plan" / "Test Audio and Video").
 * secondary: surface colour with a hairline border (Cancel in dialogs).
 */
export type ButtonVariant = "primary" | "soft" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "rounded-lg bg-zoom-blue text-white hover:bg-zoom-blue-hover",
  soft: "rounded-xl bg-zoom-blue-soft text-zoom-blue hover:bg-zoom-blue-soft-hover dark:text-zoom-blue-hover",
  secondary: "rounded-lg border border-line bg-surface text-ink hover:bg-surface-muted",
  ghost: "rounded-lg text-ink hover:bg-surface-muted",
  danger: "rounded-lg bg-zoom-danger text-white hover:bg-zoom-danger-hover",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-4 text-sm",
  md: "h-10 gap-2 px-5 text-[15px]",
  lg: "h-12 gap-2 px-6 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-zoom-blue focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}
