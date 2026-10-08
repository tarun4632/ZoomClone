"use client";

import { useCallback, useRef, useState } from "react";
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useRealUnmount } from "./hooks";

/**
 * Pre-join camera and mic preview (PLAN.MD "Mic and camera on/off"):
 * - camera off stops and releases the video track (light off); camera on creates a new one
 * - mic off mutes the audio track (device stays open); mic on unmutes it
 * Tracks are stopped on unmount unless they were handed off to the room.
 */
export function usePreviewTracks() {
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraPending, setCameraPending] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [micError, setMicError] = useState(false);

  const videoRef = useRef<LocalVideoTrack | null>(null);
  const audioRef = useRef<LocalAudioTrack | null>(null);
  const micOnRef = useRef(true);
  const startedRef = useRef(false); // Strict Mode guard: open the devices once
  const disposedRef = useRef(false);
  const handedOffRef = useRef(false);

  const startCamera = useCallback(async () => {
    setCameraPending(true);
    setCameraError(false);
    try {
      const track = await createLocalVideoTrack();
      if (disposedRef.current || handedOffRef.current) {
        track.stop();
        return;
      }
      videoRef.current?.stop();
      videoRef.current = track;
      setVideoTrack(track);
    } catch {
      if (!disposedRef.current) setCameraError(true);
    } finally {
      if (!disposedRef.current) setCameraPending(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    videoRef.current?.stop();
    videoRef.current = null;
    setVideoTrack(null);
  }, []);

  const startMic = useCallback(async () => {
    setMicPending(true);
    setMicError(false);
    try {
      const track = await createLocalAudioTrack();
      if (disposedRef.current || handedOffRef.current) {
        track.stop();
        return;
      }
      if (!micOnRef.current) await track.mute();
      audioRef.current = track;
      setAudioTrack(track);
    } catch {
      if (!disposedRef.current) setMicError(true);
    } finally {
      if (!disposedRef.current) setMicPending(false);
    }
  }, []);

  /** Opens the devices once. `cameraOn` is the meeting's host/participant video default. */
  const start = useCallback(
    (cameraOn: boolean) => {
      if (startedRef.current) return;
      startedRef.current = true;
      void startMic();
      if (cameraOn) void startCamera();
    },
    [startMic, startCamera],
  );

  const toggleCamera = useCallback(() => {
    if (videoRef.current) stopCamera();
    else void startCamera();
  }, [startCamera, stopCamera]);

  const toggleMic = useCallback(async () => {
    const track = audioRef.current;
    if (!track) {
      // Mic failed earlier: clicking retries with the mic on.
      micOnRef.current = true;
      setMicOn(true);
      await startMic();
      return;
    }
    const next = !micOnRef.current;
    micOnRef.current = next;
    setMicOn(next);
    if (next) await track.unmute();
    else await track.mute();
  }, [startMic]);

  /** Gives the tracks to the room; this hook no longer stops them. */
  const handOff = useCallback(() => {
    handedOffRef.current = true;
    return { audioTrack: audioRef.current, videoTrack: videoRef.current };
  }, []);

  /** Stops both tracks, e.g. when join answers "This meeting has ended". */
  const release = useCallback(() => {
    disposedRef.current = true;
    if (handedOffRef.current) return;
    videoRef.current?.stop();
    audioRef.current?.stop();
    videoRef.current = null;
    audioRef.current = null;
  }, []);

  useRealUnmount(release);

  return {
    videoTrack,
    audioTrack,
    micOn: micOn && audioTrack !== null,
    cameraOn: videoTrack !== null,
    cameraPending,
    micPending,
    cameraError,
    micError,
    start,
    toggleCamera,
    toggleMic,
    handOff,
    release,
  };
}
