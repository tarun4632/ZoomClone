"use client";

import { Check, LogOut, Moon, Settings, Sun, UserRound, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useClickOutside } from "@/components/meeting/hooks";
import { Avatar } from "@/components/ui/Avatar";
import { Modal, ModalBody } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { getTheme, setTheme, subscribeTheme, type Theme } from "@/lib/theme";
import type { User } from "@/lib/types";

const itemClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[16px] text-ink transition-colors outline-none hover:bg-surface-muted focus-visible:bg-surface-muted disabled:cursor-wait disabled:text-ink-muted";

function MenuItem({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={itemClass}>
      <Icon className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * The avatar in the navbar and the menu it opens, after Zoom's: who is signed in, then
 * Profile, Settings and Sign out. Zoom's other entries (plans and billing, help, switch
 * account, the upgrade card, the app download) are left out: this app has nothing behind them.
 */
export function AccountMenu({ me }: { me: User | null }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"profile" | "settings" | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open && !signingOut);

  // Next.js keeps the page alive (hidden) after navigating away; don't come back to an open
  // menu or dialog.
  useLayoutEffect(() => {
    return () => {
      setOpen(false);
      setDialog(null);
      setSigningOut(false);
    };
  }, []);

  function show(which: "profile" | "settings") {
    setOpen(false);
    setDialog(which);
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout(); // revoke the token on the server
    } catch {
      // Offline or already revoked: still sign out of this browser.
    } finally {
      clearToken(); // RequireAuth sees this and goes to /login
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={me ? `Account: ${me.name}` : "Account"}
        className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-zoom-blue focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <Avatar name={me?.name ?? null} color={me?.avatar_color} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute top-full right-0 z-30 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-2xl bg-surface p-2.5 shadow-[0_6px_28px_rgba(19,22,25,0.16)] ring-1 ring-line"
        >
          {me && (
            <>
              <div className="flex items-center gap-3 rounded-xl bg-surface-muted px-3 py-2.5">
                <Avatar name={me.name} color={me.avatar_color} />
                <div className="min-w-0">
                  <p className="truncate text-[17px] leading-snug text-ink">{me.name}</p>
                  <p className="truncate text-sm text-ink-muted">{me.email}</p>
                </div>
              </div>
              <hr className="my-2.5 border-line" />
            </>
          )}
          <MenuItem icon={UserRound} label="Profile" onClick={() => show("profile")} />
          <MenuItem icon={Settings} label="Settings" onClick={() => show("settings")} />
          <hr className="my-2.5 border-line" />
          <button type="button" role="menuitem" onClick={signOut} disabled={signingOut} className={itemClass}>
            {signingOut ? (
              <Spinner className="size-5 shrink-0" />
            ) : (
              <LogOut className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            )}
            Sign out
          </button>
        </div>
      )}

      {dialog === "profile" && me && <ProfileDialog me={me} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Read-only: this app has no profile editing. */
function ProfileDialog({ me, onClose }: { me: User; onClose: () => void }) {
  return (
    <Modal title="Profile" onClose={onClose}>
      <ModalBody className="pb-7 sm:pb-8">
        <div className="flex items-center gap-5">
          <Avatar size="xl" name={me.name} color={me.avatar_color} />
          <div className="min-w-0">
            <p className="text-2xl leading-tight font-bold tracking-tight break-words text-ink">{me.name}</p>
            <p className="mt-1 text-[15px] break-all text-ink-muted">{me.email}</p>
          </div>
        </div>
        <dl className="mt-6 divide-y divide-line border-t border-line">
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3.5 text-[15px]">
            <dt className="text-ink-muted">Name</dt>
            <dd className="break-words text-ink">{me.name}</dd>
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3.5 text-[15px]">
            <dt className="text-ink-muted">Sign-in email</dt>
            <dd className="break-all text-ink">{me.email}</dd>
          </div>
        </dl>
      </ModalBody>
    </Modal>
  );
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];
const getServerTheme = () => null;

/** The one setting the app has: light or dark mode (the same choice as the navbar's sun/moon button). */
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  return (
    <Modal title="Settings" onClose={onClose}>
      <ModalBody className="pb-7 sm:pb-8">
        <fieldset>
          <legend className="text-sm font-semibold text-ink">Appearance</legend>
          <p className="mt-1 text-sm text-ink-muted">The meeting room stays dark in both modes.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {THEMES.map(({ value, label, icon: Icon }) => {
              const selected = theme === value;
              return (
                <label
                  key={value}
                  className={`relative flex cursor-pointer flex-col items-center gap-2 rounded-xl border px-4 py-5 text-[15px] font-medium transition-colors focus-within:ring-2 focus-within:ring-zoom-blue ${
                    selected
                      ? "border-zoom-blue bg-zoom-blue-soft text-zoom-blue dark:text-zoom-blue-hover"
                      : "border-line text-ink hover:bg-surface-muted"
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={selected}
                    onChange={() => setTheme(value)}
                    className="sr-only"
                  />
                  <Icon className="size-6" aria-hidden="true" />
                  {label}
                  {selected && <Check className="absolute top-2.5 right-2.5 size-4" strokeWidth={3} aria-hidden="true" />}
                </label>
              );
            })}
          </div>
        </fieldset>
      </ModalBody>
    </Modal>
  );
}
