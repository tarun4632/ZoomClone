// Hand-offs from the dashboard to /wc/[number] through sessionStorage (per tab).
// The host key never goes in the URL: a host who shared the address bar would make every guest a host.

const hostKeyKey = (number: string) => `zc:hostKey:${number}`;
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
    // storage blocked (private mode etc.); the flow still works as an attendee
  }
}

export const saveHostKey = (number: string, hostKey: string) => write(hostKeyKey(number), hostKey);
export const getHostKey = (number: string) => read(hostKeyKey(number));

/** Name typed in the Join modal, prefilled on pre-join. */
export const saveDisplayName = (name: string) => write(NAME_KEY, name);
export const getDisplayName = () => read(NAME_KEY);
