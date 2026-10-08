// Hand-off from the dashboard to /wc/[number] through sessionStorage (per tab).

const NAME_KEY = "zc:displayName";

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // storage blocked (private mode etc.); the name is simply typed again on pre-join
  }
}

/** Name typed in the Join modal, prefilled on pre-join. */
export const saveDisplayName = (name: string) => write(NAME_KEY, name);
export const getDisplayName = () => read(NAME_KEY);
