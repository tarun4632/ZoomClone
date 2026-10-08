import type { HTMLAttributes } from "react";

/** Portal card: surface colour, 16px radius, very soft shadow (plus a hairline ring in dark mode). */
export function Card({ className = "", ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={`rounded-card bg-surface p-5 shadow-card sm:p-8 dark:ring-1 dark:ring-line ${className}`} {...rest} />;
}

/** Big bold card heading ("Meetings", "Recent meetings"). */
export function CardTitle({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`text-2xl leading-tight font-bold tracking-tight text-ink sm:text-[28px] ${className}`} {...rest} />;
}
