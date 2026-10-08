"use client";

import { Check, ChevronLeft, UserRound } from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { AuthIllustration } from "@/components/auth/AuthIllustration";
import { ThemeToggle } from "@/components/dashboard/ThemeToggle";
import { Alert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import { DEMO_ACCOUNT, safeNextPath, setToken, useAuthToken } from "@/lib/auth";
import type { AuthResponse } from "@/lib/types";

// Sign in and sign up, laid out like Zoom's own: a top bar that switches between the two, an
// illustrated panel on the left and one short form on the right. Only what this app really
// has is on the page: no birth-year step, no SSO or social sign-in, no support or language links.

const MIN_PASSWORD_LENGTH = 8; // same rule as the server (schemas.py)
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** signin: email + password. signup-email, then signup-details (name + password), as Zoom splits it. */
type Step = "signin" | "signup-email" | "signup-details";

// What an account gets you here. Every line is something the app does.
const BENEFITS = [
  "Start a meeting in one click, with real video and audio",
  "Schedule meetings and share an invite link",
  "Guests join from the browser, with no account",
  "Host controls: mute, remove and make host",
];

const linkClass =
  "rounded font-medium text-zoom-blue outline-none hover:underline focus-visible:ring-2 focus-visible:ring-zoom-blue disabled:opacity-50 dark:text-zoom-blue-hover";

/** The page frame: top bar, illustrated panel (desktop only), and the form area. */
function Frame({ topRight, children }: { topRight?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-surface">
      <header className="border-b border-line bg-surface">
        <div className="flex h-16 items-center gap-3 px-4 sm:h-20 sm:px-10 lg:px-[60px]">
          <Image
            src="/zoom-logo.png"
            alt="Zoom Clone"
            width={178}
            height={41}
            loading="eager"
            className="mr-auto h-6 w-auto shrink-0 sm:h-8"
          />
          {topRight}
          <ThemeToggle />
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,39fr)_minmax(0,61fr)]">
        <aside className="hidden flex-col items-center justify-center gap-8 bg-surface-muted px-10 py-12 lg:flex">
          <AuthIllustration className="h-auto w-full max-w-[440px]" />
          <div className="w-full max-w-[560px] rounded-[20px] bg-surface p-8 shadow-card dark:ring-1 dark:ring-line">
            <h2 className="text-[26px] leading-tight font-bold tracking-tight text-ink xl:text-[28px]">
              Create your free account
            </h2>
            <ul className="mt-6 space-y-5">
              {BENEFITS.map((benefit) => (
                <li key={benefit} className="flex items-start gap-3.5 text-[17px] leading-6 text-ink">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
                    <Check className="size-3.5" strokeWidth={3.5} aria-hidden="true" />
                  </span>
                  {benefit}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="flex flex-1 flex-col items-center justify-center px-5 py-12 sm:px-8">
          <div className="w-full max-w-[432px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams suspends while prerendering, so the screen sits inside <Suspense>.
  return (
    <Suspense
      fallback={
        <Frame>
          <div className="flex justify-center py-16" aria-busy="true" aria-label="Loading">
            <Spinner className="size-7 text-zoom-blue" />
          </div>
        </Frame>
      }
    >
      <AuthScreen />
    </Suspense>
  );
}

function AuthScreen() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const token = useAuthToken();

  const [step, setStep] = useState<Step>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"form" | "demo" | null>(null);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);

  // Signed in (just now, already, or in another tab): leave this page.
  useEffect(() => {
    if (token) router.replace(next);
  }, [token, next, router]);

  // Next.js keeps this page alive (hidden) after navigating away, and shows it again after a
  // sign-out. Start over each time: no typed password or previous person's details left in
  // it, no half-finished sign-up step, no button stuck on "busy".
  useLayoutEffect(() => {
    return () => {
      setStep("signin");
      setName("");
      setEmail("");
      setPassword("");
      setBusy(null);
      setError(null);
    };
  }, []);

  function go(to: Step) {
    setStep(to);
    setError(null);
    setPassword("");
  }

  async function run(kind: "form" | "demo", action: () => Promise<AuthResponse>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const { access_token } = await action();
      setToken(access_token); // the effect above then navigates; stay busy until it does
    } catch (err) {
      setBusy(null);
      if (!(err instanceof ApiError)) {
        setError({ title: "Unable to connect", detail: "Can't reach the server right now. Please try again." });
      } else if (err.status === 401) {
        setError({ title: "Incorrect email or password" });
      } else if (err.status === 409) {
        setError({ title: "This email already has an account", detail: "Sign in instead, or go back and use another email." });
      } else if (err.status === 422) {
        setError({ title: "Check your details", detail: "Enter a valid email and a password of at least 8 characters." });
      } else {
        setError({ title: "Something went wrong", detail: "Please try again." });
      }
    }
  }

  const trimmedEmail = email.trim();
  const emailOk = EMAIL.test(trimmedEmail);
  // Like Zoom, the button stays grey until the step can be submitted.
  const ready =
    step === "signin"
      ? emailOk && password !== ""
      : step === "signup-email"
        ? emailOk
        : name.trim() !== "" && password.length >= MIN_PASSWORD_LENGTH;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || busy) return;
    if (step === "signup-email") go("signup-details");
    else if (step === "signin") void run("form", () => api.login({ email: trimmedEmail, password }));
    else void run("form", () => api.signup({ name: name.trim(), email: trimmedEmail, password }));
  }

  const signingUp = step !== "signin";

  return (
    <Frame
      topRight={
        <p className="text-right text-sm text-ink sm:text-[17px]">
          <span className="hidden sm:inline">{signingUp ? "Already have an account? " : "New here? "}</span>
          <button
            type="button"
            onClick={() => go(signingUp ? "signin" : "signup-email")}
            disabled={busy !== null}
            className={linkClass}
          >
            {signingUp ? "Sign In" : "Sign Up Free"}
          </button>
        </p>
      }
    >
      <h1 className="text-center text-[34px] leading-tight font-bold tracking-tight text-ink sm:text-[40px]">
        {step === "signin" ? "Sign in" : step === "signup-email" ? "Sign up" : "Create your account"}
      </h1>
      {step === "signup-details" && (
        <p className="mt-3 text-center text-[15px] break-words text-ink-muted">{trimmedEmail}</p>
      )}

      <form onSubmit={handleSubmit} noValidate className="mt-9 space-y-4">
        {step !== "signup-details" && (
          <TextInput
            id="auth-email"
            label="Email address"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            maxLength={254}
          />
        )}
        {step === "signup-details" && (
          <TextInput id="auth-name" label="Your name" value={name} onChange={setName} autoComplete="name" maxLength={64} />
        )}
        {step !== "signup-email" && (
          <div>
            <TextInput
              id="auth-password"
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete={signingUp ? "new-password" : "current-password"}
              maxLength={128}
            />
            {signingUp && (
              <p className="mt-2 text-sm text-ink-muted">Use at least {MIN_PASSWORD_LENGTH} characters.</p>
            )}
          </div>
        )}

        {error && <Alert title={error.title}>{error.detail}</Alert>}

        <button
          type="submit"
          disabled={!ready || busy !== null}
          aria-busy={busy === "form" || undefined}
          className="flex h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-zoom-blue text-[17px] font-medium text-white transition-colors outline-none hover:bg-zoom-blue-hover focus-visible:ring-2 focus-visible:ring-zoom-blue focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-muted"
        >
          {busy === "form" && <Spinner className="size-4" />}
          {step === "signin" ? "Sign In" : "Continue"}
        </button>
      </form>

      {step === "signup-details" ? (
        <button
          type="button"
          onClick={() => go("signup-email")}
          disabled={busy !== null}
          className={`mx-auto mt-6 flex items-center gap-1 text-[15px] ${linkClass}`}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back
        </button>
      ) : (
        <>
          <div className="mt-10 flex items-center gap-4 text-[15px] text-ink-muted">
            <span className="h-px flex-1 bg-line" />
            {signingUp ? "Or continue with" : "Or sign in with"}
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => void run("demo", () => api.login(DEMO_ACCOUNT))}
              disabled={busy !== null}
              aria-label="Use the demo account"
              aria-busy={busy === "demo" || undefined}
              className="group flex flex-col items-center gap-2.5 rounded-xl p-1 text-[15px] text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-zoom-blue disabled:cursor-wait"
            >
              <span className="flex size-[60px] items-center justify-center rounded-2xl border border-line bg-surface text-ink shadow-[0_1px_4px_rgba(19,22,25,0.08)] transition-colors group-hover:bg-surface-muted">
                {busy === "demo" ? <Spinner className="size-6 text-zoom-blue" /> : <UserRound className="size-6" aria-hidden="true" />}
              </span>
              Demo account
            </button>
          </div>
          <p className="mt-6 text-center text-sm text-ink-muted">
            The demo account signs you in as Alex Johnson, with sample meetings already set up.
          </p>
        </>
      )}
    </Frame>
  );
}

/** Zoom's tall, rounded input. The label is the placeholder, and is also read out. */
function TextInput({
  id,
  label,
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange">) {
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        className="block h-[58px] w-full min-w-0 rounded-xl border border-ink-muted/45 bg-surface px-4 text-[17px] text-ink transition-colors outline-none placeholder:text-ink-muted hover:border-ink-muted focus:border-zoom-blue focus:ring-2 focus:ring-zoom-blue/20 dark:bg-page"
        {...rest}
      />
    </div>
  );
}
