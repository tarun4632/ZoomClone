// Light / dark mode. The theme lives in <html data-theme="light|dark">; globals.css re-themes
// every token from it. The user's explicit choice is saved in localStorage; with no saved
// choice the site follows the OS setting (prefers-color-scheme), live.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "zc:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Runs inline in <head> before first paint (see app/layout.tsx), so the page never flashes
 * the wrong theme. Keep it dependency-free ES5: it executes before any bundle loads.
 */
export const themeInitScript = `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=="light"&&t!=="dark"){try{t=window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches?"dark":"light"}catch(e){t="light"}}document.documentElement.setAttribute("data-theme",t)})()`;

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/** The saved explicit choice, or null when the user hasn't picked one (or storage is blocked). */
export function getSavedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function getSystemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The theme currently applied to the page (from <html data-theme>). */
export function getTheme(): Theme {
  const value = document.documentElement.getAttribute("data-theme");
  return isTheme(value) ? value : "light";
}

function applyTheme(theme: Theme): void {
  if (document.documentElement.getAttribute("data-theme") !== theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/** Explicit user choice: apply it and remember it. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage blocked: the choice still applies for this page view
  }
}

/**
 * Re-applies the resolved theme (saved choice, else OS). Needed in development, where React
 * Strict Mode's remount strips the attribute the inline script set on <html>.
 */
export function syncTheme(): void {
  applyTheme(getSavedTheme() ?? getSystemTheme());
}

/** Follows OS light/dark changes while there is no saved choice. Returns an unsubscribe. */
export function followSystemTheme(): () => void {
  let media: MediaQueryList;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  const onChange = () => {
    if (!getSavedTheme()) applyTheme(media.matches ? "dark" : "light");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Calls `onChange` whenever <html data-theme> changes (toggle, OS change, another tab). */
export function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // A choice made in another tab arrives as a storage event.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) syncTheme();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}
