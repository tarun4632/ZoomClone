"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { LocalVideoTrack } from "livekit-client";
import { format } from "date-fns";
import { CircleAlert, LoaderCircle, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { initials } from "@/lib/format";
import { getToken } from "@/lib/auth";
import { getDisplayName, saveDisplayName } from "@/lib/session";
import type { MeetingPublic } from "@/lib/types";
import { StatusScreen } from "./StatusScreen";
import { usePreviewTracks } from "./usePreviewTracks";
import type { MeetingSession } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ended" }
  | { kind: "error" }
  | { kind: "ready"; meeting: MeetingPublic };

/** While waiting for the host to start a scheduled meeting: how often to look again. */
const WAIT_POLL_MS = 4000;

interface PreJoinProps {
  number: string;
  /** The invite link's ?pwd= token (random, not the passcode), or null. */
  pwd: string | null;
  onJoined: (session: MeetingSession) => void;
}

export function PreJoin({ number, pwd, onJoined }: PreJoinProps) {
  const router = useRouter();
  const preview = usePreviewTracks();
  const { start } = preview;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [askPasscode, setAskPasscode] = useState(false);
  const [joining, setJoining] = useState(false);
  // The owner has not started this scheduled meeting yet: keep the join request ready and
  // send it again once the meeting is live.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let meeting: MeetingPublic;
      try {
        meeting = await api.getMeeting(number);
      } catch (e) {
        if (cancelled) return;
        setLoad({ kind: e instanceof ApiError && e.status === 404 ? "invalid" : "error" });
        return;
      }
      if (cancelled) return;
      // `is_host`: the request carried the sign-in of this meeting's owner (see api.ts).
      const isHost = meeting.is_host;
      // An ended instant meeting can only be restarted by its owner. For a scheduled one the
      // server decides on join: wait for the owner (409) or, once its time is over, ended (410).
      if (meeting.status === "ended" && meeting.meeting_type === "instant" && !isHost) {
        setLoad({ kind: "ended" });
        return;
      }
      setLoad({ kind: "ready", meeting });
      setAskPasscode(!pwd && !isHost);
      start(isHost ? meeting.host_video_on : meeting.participant_video_on);

      // The name typed in the Join modal, else a signed-in user's own name; guests type one.
      let initialName = getDisplayName() ?? "";
      if (!initialName && getToken()) {
        try {
          initialName = (await api.me()).name;
        } catch {
          // leave it empty; the user types a name
        }
      }
      if (!cancelled && initialName) setName((current) => current || initialName);
    })();
    return () => {
      cancelled = true;
    };
  }, [number, pwd, start, reloadKey]);

  const trimmedName = name.trim();

  async function attemptJoin() {
    if (load.kind !== "ready") return;
    const { meeting } = load;
    setJoining(true);
    setError(null);
    try {
      // The signed-in owner needs no passcode. Others send the invite link's token; the
      // passcode field only appears without a link, or after a 403 (then the typed passcode
      // is sent instead).
      const response = await api.join(
        number,
        askPasscode
          ? { display_name: trimmedName, passcode: passcode.trim() }
          : meeting.is_host
            ? { display_name: trimmedName }
            : { display_name: trimmedName, invite_token: pwd ?? "" },
      );
      saveDisplayName(trimmedName);
      const tracks = preview.handOff();
      onJoined({
        join: response,
        hostName: meeting.host_name,
        displayName: trimmedName,
        ...tracks,
      });
    } catch (err) {
      setJoining(false);
      if (err instanceof ApiError && err.status === 409) {
        // Passcode or link accepted, but the owner has not started the meeting. Wait for it.
        setWaiting(true);
        return;
      }
      setWaiting(false);
      if (err instanceof ApiError && err.status === 403) {
        // A typed passcode was wrong; or the link's token was not accepted (an old or
        // mistyped link), in which case the passcode still gets the user in.
        setError(askPasscode ? "Incorrect passcode" : "This invite link isn't valid. Enter the meeting passcode.");
        setAskPasscode(true);
      } else if (err instanceof ApiError && err.status === 410) {
        preview.release();
        setLoad({ kind: "ended" });
      } else if (err instanceof ApiError && err.status === 404) {
        preview.release();
        setLoad({ kind: "invalid" });
      } else {
        setError("Could not join the meeting. Please try again.");
      }
    }
  }

  // The waiting loop below calls whatever attemptJoin is current, without restarting itself
  // on every render.
  const attemptJoinRef = useRef(attemptJoin);
  useEffect(() => {
    attemptJoinRef.current = attemptJoin;
  });

  // Waiting for the host: look every few seconds and join the moment the meeting is live.
  useEffect(() => {
    if (!waiting) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if ((await api.getMeeting(number)).status === "live") await attemptJoinRef.current();
      } catch {
        // offline for a moment: keep waiting
      } finally {
        busy = false;
      }
    }, WAIT_POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting, number]);

  if (load.kind === "loading") return <StatusScreen loading title="Loading meeting…" />;
  if (load.kind === "invalid")
    return (
      <StatusScreen
        title="Invalid meeting ID"
        message="Please check the meeting ID and try again."
        icon={<CircleAlert className="size-10" aria-hidden />}
        action={{ label: "Back to Home", onClick: () => router.push("/") }}
      />
    );
  if (load.kind === "ended")
    return (
      <StatusScreen
        title="This meeting has ended"
        icon={<CircleAlert className="size-10" aria-hidden />}
        action={{ label: "Back to Home", onClick: () => router.push("/") }}
      />
    );
  if (load.kind === "error")
    return (
      <StatusScreen
        title="Unable to load the meeting"
        message="Check your connection and try again."
        icon={<CircleAlert className="size-10" aria-hidden />}
        action={{
          label: "Try again",
          onClick: () => {
            setLoad({ kind: "loading" });
            setReloadKey((k) => k + 1);
          },
        }}
      />
    );

  const { meeting } = load;
  const mediaPending = preview.cameraPending || preview.micPending;
  const canJoin =
    trimmedName !== "" && (!askPasscode || passcode.trim() !== "") && !joining && !waiting && !mediaPending;
  // Only its owner can start a scheduled meeting; say so before the visitor clicks Join.
  const notStarted = meeting.meeting_type === "scheduled" && !meeting.is_host && meeting.status !== "live";

  function join(e: FormEvent) {
    e.preventDefault();
    if (canJoin) void attemptJoin();
  }

  return (
    // Pinned to the viewport like the room: `min-h-dvh` overshot the page height in some
    // browsers (Edge/Firefox), making the page scroll and showing the white body underneath.
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-room-bg text-room-text">
      <main className="flex flex-1 items-center justify-center px-4 py-6 sm:py-10">
        <div className="grid w-full max-w-4xl gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-center md:gap-10">
          <section aria-label="Camera preview">
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-room-tile">
              {preview.videoTrack ? (
                <PreviewVideo track={preview.videoTrack} />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  {preview.cameraPending ? (
                    <LoaderCircle className="size-8 animate-spin text-room-text-muted" aria-hidden />
                  ) : (
                    <>
                      <div className="flex size-16 items-center justify-center rounded-full bg-zoom-blue text-xl font-semibold text-white sm:size-20 sm:text-2xl">
                        {initials(trimmedName || "?")}
                      </div>
                      {trimmedName && <span className="text-sm text-room-text">{trimmedName}</span>}
                    </>
                  )}
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-3 bg-linear-to-t from-black/60 to-transparent p-3">
                <PreviewToggle
                  on={preview.micOn}
                  disabled={preview.micPending}
                  onClick={() => void preview.toggleMic()}
                  onLabel="Mute"
                  offLabel="Unmute"
                  OnIcon={Mic}
                  OffIcon={MicOff}
                />
                <PreviewToggle
                  on={preview.cameraOn}
                  disabled={preview.cameraPending}
                  onClick={preview.toggleCamera}
                  onLabel="Stop Video"
                  offLabel="Start Video"
                  OnIcon={Video}
                  OffIcon={VideoOff}
                />
              </div>
            </div>
            <div className="mt-2 min-h-5 space-y-1 text-sm text-amber-300" aria-live="polite">
              {preview.cameraError && <p>Cannot access camera. You can still join without video.</p>}
              {preview.micError && <p>Cannot access microphone. You can still join without audio.</p>}
            </div>
          </section>

          <form onSubmit={join} className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold break-words sm:text-2xl">{meeting.title}</h1>
              {meeting.host_name && (
                <p className="mt-1 text-sm text-room-text-muted">Hosted by {meeting.host_name}</p>
              )}
              {(notStarted || waiting) && meeting.scheduled_start_at && (
                <p className="mt-1 text-sm text-room-text-muted">
                  Scheduled for {format(new Date(meeting.scheduled_start_at), "EEE, MMM d · h:mm a")}
                </p>
              )}
              {notStarted && !waiting && (
                <p className="mt-3 text-sm text-amber-300">
                  The host hasn&apos;t started this meeting yet. Join now and you&apos;ll be let in when it starts.
                </p>
              )}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-room-text-muted">Your Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                autoComplete="name"
                placeholder="Enter your name"
                disabled={waiting}
                className="rounded-lg bg-room-tile px-3 py-2.5 text-room-text ring-1 ring-white/10 outline-none placeholder:text-room-text-muted/70 focus:ring-2 focus:ring-zoom-blue disabled:opacity-60"
              />
            </label>

            {askPasscode && (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-room-text-muted">Meeting Passcode</span>
                <input
                  value={passcode}
                  onChange={(e) => {
                    setPasscode(e.target.value);
                    setError(null);
                  }}
                  type="password"
                  autoComplete="off"
                  placeholder="Enter meeting passcode"
                  disabled={waiting}
                  aria-invalid={error === "Incorrect passcode"}
                  className="rounded-lg bg-room-tile px-3 py-2.5 text-room-text ring-1 ring-white/10 outline-none placeholder:text-room-text-muted/70 focus:ring-2 focus:ring-zoom-blue aria-invalid:ring-zoom-danger"
                />
              </label>
            )}

            {error && (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}

            {waiting ? (
              <div role="status" className="rounded-lg bg-room-tile px-4 py-3 ring-1 ring-white/10">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
                  Waiting for the host to start this meeting
                </p>
                <p className="mt-1 text-sm text-room-text-muted">You&apos;ll join automatically when it starts.</p>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!canJoin}
                className="flex items-center justify-center gap-2 rounded-lg bg-zoom-blue py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zoom-blue-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {joining && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                Join
              </button>
            )}
            {/* Back out without joining: release camera/mic first so the light goes off at once. */}
            <button
              type="button"
              disabled={joining && !waiting}
              onClick={() => {
                preview.release();
                router.push("/");
              }}
              className="rounded-lg py-2.5 text-sm font-semibold text-room-text ring-1 ring-white/15 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

/** Attaches the local preview track to a mirrored <video>, like Zoom's self view. */
function PreviewVideo({ track }: { track: LocalVideoTrack }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
    />
  );
}

interface PreviewToggleProps {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  onLabel: string;
  offLabel: string;
  OnIcon: typeof Mic;
  OffIcon: typeof Mic;
}

function PreviewToggle({ on, disabled, onClick, onLabel, offLabel, OnIcon, OffIcon }: PreviewToggleProps) {
  const Icon = on ? OnIcon : OffIcon;
  const label = on ? onLabel : offLabel;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex size-11 items-center justify-center rounded-full transition-colors disabled:opacity-60 ${
        on ? "bg-white/15 text-white hover:bg-white/25" : "bg-zoom-danger text-white hover:bg-zoom-danger-hover"
      }`}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}
