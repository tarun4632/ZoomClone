"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Alert, Field, inputClass } from "@/components/ui/Field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { api, ApiError } from "@/lib/api";
import { parseMeetingInput } from "@/lib/parseMeetingInput";
import { saveDisplayName } from "@/lib/session";

type JoinError = "invalid" | "network" | null;

export function JoinMeetingModal({ defaultName, onClose }: { defaultName: string; onClose: () => void }) {
  const router = useRouter();
  const [meetingInput, setMeetingInput] = useState("");
  // null until the user edits it, so a name that loads after the modal opened is still used.
  const [nameInput, setName] = useState<string | null>(null);
  const name = nameInput ?? defaultName;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<JoinError>(null);

  const canJoin = meetingInput.trim() !== "" && name.trim() !== "";

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canJoin || busy) return;

    const parsed = parseMeetingInput(meetingInput);
    if (!parsed) {
      setError("invalid");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.getMeeting(parsed.number);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError && err.status === 404 ? "invalid" : "network");
      return;
    }

    saveDisplayName(name.trim());
    router.push(`/wc/${parsed.number}${parsed.pwd ? `?pwd=${encodeURIComponent(parsed.pwd)}` : ""}`);
    // Keep the busy state until the route changes and this modal unmounts.
  }

  return (
    <Modal title="Join meeting" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Meeting ID or invite link" htmlFor="join-meeting-id">
            <input
              id="join-meeting-id"
              data-autofocus
              value={meetingInput}
              onChange={(e) => {
                setMeetingInput(e.target.value);
                if (error) setError(null);
              }}
              placeholder="123 4567 8901"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error === "invalid" || undefined}
              aria-describedby={error ? "join-error" : undefined}
              className={inputClass}
            />
          </Field>
          <Field label="Your Name" htmlFor="join-name">
            <input
              id="join-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={64}
              className={inputClass}
            />
          </Field>
          {error && (
            <div id="join-error">
              {error === "invalid" ? (
                <Alert title="Invalid meeting ID">Please check the meeting ID or invite link and try again.</Alert>
              ) : (
                <Alert title="Unable to connect">Can&apos;t reach the server right now. Please try again.</Alert>
              )}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canJoin} loading={busy}>
            Join
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
