"use client";

import { Moon, Sun } from "lucide-react";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { followSystemTheme, getTheme, setTheme, subscribeTheme, syncTheme } from "@/lib/theme";

const getServerTheme = () => null;

/** Sun / moon button that switches between light and dark mode and remembers the choice. */
export function ThemeToggle() {
  // null on the server and during hydration; the icon itself is picked by CSS (dark: variant),
  // so it is right from the first paint whatever the inline script chose.
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);

  useLayoutEffect(() => {
    syncTheme();
    return followSystemTheme();
  }, []);

  const label =
    theme === "dark" ? "Switch to light mode" : theme === "light" ? "Switch to dark mode" : "Toggle dark mode";

  return (
    <button
      type="button"
      onClick={() => setTheme(getTheme() === "dark" ? "light" : "dark")}
      aria-label={label}
      title={label}
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink transition-colors outline-none hover:bg-surface-muted hover:text-zoom-blue focus-visible:ring-2 focus-visible:ring-zoom-blue dark:hover:text-zoom-blue-hover"
    >
      <Moon className="size-5 dark:hidden" aria-hidden="true" />
      <Sun className="hidden size-5 dark:block" aria-hidden="true" />
    </button>
  );
}
