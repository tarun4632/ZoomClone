"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RoomAudioRenderer,
  RoomContext,
  useAudioPlayback,
  useParticipants,
} from "@livekit/components-react";
import { DisconnectReason, Room, RoomEvent } from "livekit-client";
import { LoaderCircle, VolumeX } from "lucide-react";
import { api, leaveUrl } from "@/lib/api";
import { DisconnectedScreen, type DisconnectKind } from "./DisconnectedScreen";
import { useRealUnmount } from "./hooks";
import { LeaveMenu } from "./LeaveMenu";
import { MeetingInfo } from "./MeetingInfo";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { Toolbar } from "./Toolbar";
import type { MeetingSession } from "./types";
import { VideoGrid } from "./VideoGrid";

interface MeetingRoomProps {
  meetingNumber: string;
  session: MeetingSession;
}

export function MeetingRoom({ meetingNumber, session }: MeetingRoomProps) {
  const router = useRouter();
  const [room] = useState(
    () => new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { simulcast: true } }),
  );
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<DisconnectKind | null>(null);

  const identity = session.join.identity;
  const connectStartedRef = useRef(false); // Strict Mode guard: connect once
  const leavingRef = useRef(false); // set for a client-initiated leave / end
  const leftRef = useRef(false); // the leave request has been sent

  const sendBeacon = useCallback(() => {
    // LiveKit also disconnects on pagehide; treat that as our own leave.
    leavingRef.current = true;
    leftRef.current = true;
    navigator.sendBeacon(leaveUrl(meetingNumber, identity));
  }, [meetingNumber, identity]);

  const stopPageHide = useCallback(() => {
    window.removeEventListener("pagehide", sendBeacon);
  }, [sendBeacon]);

  // Tab close / reload: tell the server we left (PLAN.MD section 4, "Meeting lifecycle").
  useEffect(() => {
    window.addEventListener("pagehide", sendBeacon);
    return () => window.removeEventListener("pagehide", sendBeacon);
  }, [sendBeacon]);

  // Server-driven disconnects: removed by the host, or the room was deleted (End for all).
  useEffect(() => {
    const onDisconnected = (reason?: DisconnectReason) => {
      stopPageHide();
      if (leavingRef.current) return;
      // Make sure the camera light goes off (stopping twice is harmless).
      room.localParticipant.trackPublications.forEach((pub) => pub.track?.stop());
      session.audioTrack?.stop();
      session.videoTrack?.stop();
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        leftRef.current = true; // the server already marked us removed
        setEnded("removed");
      } else if (reason === DisconnectReason.ROOM_DELETED) {
        leftRef.current = true; // the server already ended the meeting
        setEnded("ended");
      } else {
        if (!leftRef.current) {
          leftRef.current = true;
          void api.leave(meetingNumber, identity).catch(() => {});
        }
        setEnded("disconnected");
      }
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, session, meetingNumber, identity, stopPageHide]);

  // Connect, then publish the pre-join tracks (audio is already muted if the mic was off).
  useEffect(() => {
    if (connectStartedRef.current) return;
    connectStartedRef.current = true;
    const { join, audioTrack, videoTrack } = session;
    (async () => {
      try {
        await room.connect(join.livekit_url, join.token);
      } catch {
        if (leavingRef.current) return;
        stopPageHide();
        if (!leftRef.current) {
          leftRef.current = true;
          void api.leave(meetingNumber, identity).catch(() => {});
        }
        setEnded((current) => current ?? "failed");
        return;
      }
      try {
        if (audioTrack) await room.localParticipant.publishTrack(audioTrack);
        if (videoTrack) await room.localParticipant.publishTrack(videoTrack);
      } catch {
        // Publishing failed (e.g. disconnected meanwhile); the toolbar can retry via set*Enabled.
      }
      // Enable the toolbar only after publishing, so a quick click can't open a second mic/camera.
      setConnected(true);
    })();
  }, [room, session, meetingNumber, identity, stopPageHide]);

  // Real unmount (e.g. browser back): disconnect, release devices, send leave.
  useRealUnmount(() => {
    stopPageHide();
    leavingRef.current = true;
    void room.disconnect(true);
    session.audioTrack?.stop();
    session.videoTrack?.stop();
    if (!leftRef.current) {
      leftRef.current = true;
      void api.leave(meetingNumber, identity).catch(() => {});
    }
  });

  const leave = useCallback(async () => {
    leavingRef.current = true;
    stopPageHide();
    await room.disconnect(true);
    if (!leftRef.current) {
      leftRef.current = true;
      await api.leave(meetingNumber, identity).catch(() => {});
    }
    router.push("/");
  }, [room, meetingNumber, identity, router, stopPageHide]);

  if (ended) return <DisconnectedScreen kind={ended} />;

  return (
    <RoomContext value={room}>
      <RoomAudioRenderer />
      <RoomStage
        meetingNumber={meetingNumber}
        session={session}
        connected={connected}
        onLeave={leave}
        onEndForAll={async () => {
          if (!session.hostKey) return;
          leavingRef.current = true;
          try {
            await api.end(meetingNumber, session.hostKey);
          } catch (e) {
            leavingRef.current = false;
            throw e;
          }
          leftRef.current = true; // ending marks every participant as left
          stopPageHide();
          await room.disconnect(true);
          router.push("/");
        }}
      />
    </RoomContext>
  );
}

interface RoomStageProps {
  meetingNumber: string;
  session: MeetingSession;
  connected: boolean;
  onLeave: () => Promise<void>;
  onEndForAll: () => Promise<void>;
}

/** The visible meeting window; lives inside the room context. */
function RoomStage({ meetingNumber, session, connected, onLeave, onEndForAll }: RoomStageProps) {
  const participants = useParticipants();
  const { canPlayAudio, startAudio } = useAudioPlayback();
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const isHost = session.join.role === "host" && session.hostKey !== null;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  async function endForAll() {
    try {
      await onEndForAll();
    } catch {
      showNotice("Could not end the meeting. Please try again.");
    }
  }

  return (
    // Pinned to the viewport: the room never scrolls the page, so the toolbar stays on screen.
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-black text-white">
      <header className="flex h-11 shrink-0 items-center gap-2 bg-[#1a1a1a] px-2 sm:px-3">
        <MeetingInfo
          title={session.join.title}
          meetingNumber={session.join.meeting_number || meetingNumber}
          hostName={session.hostName}
          passcode={session.join.passcode}
          inviteUrl={session.join.invite_url}
        />
        {connected && !canPlayAudio && (
          <button
            type="button"
            onClick={() => void startAudio()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-zoom-blue px-2.5 py-1 text-xs font-medium whitespace-nowrap text-white transition-colors hover:bg-zoom-blue-hover"
          >
            <VolumeX className="size-3.5" aria-hidden />
            Click to enable audio
          </button>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {connected ? (
            <VideoGrid />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[#a6a6a6]">
              <LoaderCircle className="size-8 animate-spin" aria-hidden />
              <p className="text-sm">Connecting…</p>
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="absolute top-2 left-1/2 z-20 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-lg bg-black/80 px-3 py-2 text-center text-sm text-white shadow-lg"
            >
              {notice}
            </div>
          )}
        </main>
        {panelOpen && (
          <ParticipantsPanel
            meetingNumber={meetingNumber}
            hostKey={isHost ? session.hostKey : null}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>

      <Toolbar
        participantCount={participants.length}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        onError={showNotice}
        mediaDisabled={!connected}
        leaveControl={<LeaveMenu isHost={isHost} onLeave={onLeave} onEndForAll={endForAll} />}
      />
    </div>
  );
}
