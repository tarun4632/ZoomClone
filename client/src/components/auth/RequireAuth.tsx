"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, type ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { useAuthToken } from "@/lib/auth";

/**
 * Renders `children` only for a signed-in user; anyone else is sent to /login and brought
 * back here afterwards. Signing out (here or in another tab) and a token the server stops
 * accepting (api.ts forgets it on a 401) both end up in the same place.
 *
 * This only decides what the browser shows. What a user may read or do is enforced by the
 * API, which checks the token on every request.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const token = useAuthToken();

  useEffect(() => {
    if (token !== null) return; // signed in, or not known yet (hydrating)
    // Read from the address bar, not a hook: usePathname / useSearchParams would suspend
    // prerendering of every page wrapped in this.
    const here = window.location.pathname + window.location.search;
    router.replace(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
  }, [token, router]);

  if (!token) {
    return (
      <div className="flex flex-1 items-center justify-center bg-page py-24" aria-busy="true" aria-label="Loading">
        <Spinner className="size-7 text-zoom-blue" />
      </div>
    );
  }
  // Keyed by token: signing in as someone else starts the page fresh, so one account's
  // meetings are never shown, even briefly, under another.
  return <Fragment key={token}>{children}</Fragment>;
}
