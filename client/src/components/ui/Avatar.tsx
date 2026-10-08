import { initials } from "@/lib/format";

// Rounded squares, like the avatars in Zoom's web portal.
const sizes = {
  md: "size-10 rounded-lg text-lg",
  xl: "size-20 rounded-2xl text-4xl sm:size-24 sm:text-5xl",
};

export interface AvatarProps {
  /** null while the user is still loading: renders a neutral placeholder. */
  name: string | null;
  color?: string | null;
  size?: keyof typeof sizes;
  className?: string;
}

export function Avatar({ name, color, size = "md", className = "" }: AvatarProps) {
  if (!name) {
    return <span aria-hidden="true" className={`inline-block shrink-0 bg-surface-muted ${sizes[size]} ${className}`} />;
  }
  // Zoom shows a single initial in the square.
  const letter = initials(name).charAt(0);
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={color ? { backgroundColor: color } : undefined}
      className={`inline-flex shrink-0 items-center justify-center bg-zoom-blue font-medium text-white select-none ${sizes[size]} ${className}`}
    >
      {letter}
    </span>
  );
}
