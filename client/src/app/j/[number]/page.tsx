"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Spinner } from "@/components/ui/Spinner";

// Invite link landing: /j/{number}?pwd=... -> /wc/{number}?pwd=... (same shape as Zoom's links).

function Redirecting() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-ink-muted">
      <Spinner className="size-7 text-zoom-blue" />
      <p className="text-sm">Opening meeting…</p>
    </main>
  );
}

function InviteRedirect() {
  const router = useRouter();
  const { number } = useParams<{ number: string }>();
  const pwd = useSearchParams().get("pwd");

  useEffect(() => {
    const query = pwd ? `?pwd=${encodeURIComponent(pwd)}` : "";
    router.replace(`/wc/${encodeURIComponent(number)}${query}`);
  }, [router, number, pwd]);

  return <Redirecting />;
}

export default function InviteLandingPage() {
  // useParams and useSearchParams suspend while prerendering under cacheComponents.
  return (
    <Suspense fallback={<Redirecting />}>
      <InviteRedirect />
    </Suspense>
  );
}
