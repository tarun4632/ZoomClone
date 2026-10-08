import type { SVGProps } from "react";

// Zoom draws "muted" as the normal icon with a red slash across it.
// Paths are lucide's mic-off / video-off (ISC licence); only the slash is coloured.

type IconProps = SVGProps<SVGSVGElement>;

function SlashedIcon({ children, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
      <path d="m2 2 20 20" className="stroke-zoom-danger" strokeWidth={2.25} />
    </svg>
  );
}

export function MutedMicIcon(props: IconProps) {
  return (
    <SlashedIcon {...props}>
      <path d="M12 19v3" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M16.95 16.95A7 7 0 0 1 5 12v-2" />
      <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    </SlashedIcon>
  );
}

export function VideoOffIcon(props: IconProps) {
  return (
    <SlashedIcon {...props}>
      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196" />
      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
    </SlashedIcon>
  );
}
