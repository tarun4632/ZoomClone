"use client";

import { format } from "date-fns";
import { Globe } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Alert, Field, inputClass } from "@/components/ui/Field";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { api, ApiError } from "@/lib/api";
import { timeZoneName } from "@/lib/invitation";
import type { MeetingOwner } from "@/lib/types";

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const MINUTES = [0, 15, 30, 45];

/** 10:07 -> 10:30, 10:30 -> 11:00, 10:45 -> 11:00. */
function nextHalfHour(now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

/** "2026-10-08" + "10:30" in the browser's zone (date-time strings without an offset parse as local). */
function localDateTime(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Errors {
  topic?: string;
  when?: string;
  duration?: string;
  form?: { title: string; detail: string };
}

function OnOffRadios({
  legend,
  name,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  value: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <legend className="float-left w-24 text-[15px] text-ink">{legend}</legend>
      {[true, false].map((on) => (
        <label key={String(on)} className="inline-flex cursor-pointer items-center gap-2 text-[15px] text-ink">
          <input
            type="radio"
            name={name}
            checked={value === on}
            onChange={() => onChange(on)}
            className="size-4 cursor-pointer accent-zoom-blue"
          />
          {on ? "On" : "Off"}
        </label>
      ))}
    </fieldset>
  );
}

export function ScheduleMeetingModal({
  hostName,
  onClose,
  onScheduled,
}: {
  /** null while /me is loading or failed. */
  hostName: string | null;
  onClose: () => void;
  onScheduled: (meeting: MeetingOwner) => void;
}) {
  const id = useId();
  const [initial] = useState(() => {
    const start = nextHalfHour(new Date());
    return { date: format(start, "yyyy-MM-dd"), time: format(start, "HH:mm"), today: format(new Date(), "yyyy-MM-dd") };
  });

  // null until edited, so the default follows /me if it loads after the modal opened.
  const [topicInput, setTopic] = useState<string | null>(null);
  const topic = topicInput ?? (hostName ? `${hostName}'s Zoom Meeting` : "My Zoom Meeting");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [hours, setHours] = useState(1);
  const [minutes, setMinutes] = useState(0);
  const [hostVideo, setHostVideo] = useState(true);
  const [participantVideo, setParticipantVideo] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const start = localDateTime(date, time);
  const zoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneLabel = start ? timeZoneName(start, "long") : zoneId;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    const next: Errors = {};
    const title = topic.trim();
    const duration = hours * 60 + minutes;
    if (!title) next.topic = "Enter a topic for the meeting.";
    if (!start) next.when = "Enter a valid date and time.";
    else if (start.getTime() <= Date.now()) next.when = "Choose a start time in the future.";
    if (duration <= 0) next.duration = "The meeting must be at least 15 minutes long.";
    setErrors(next);
    if (next.topic || next.when || next.duration || !start) return;

    setBusy(true);
    try {
      const meeting = await api.scheduleMeeting({
        title,
        description: description.trim() || null,
        start_at: start.toISOString(),
        duration_minutes: duration,
        host_video_on: hostVideo,
        participant_video_on: participantVideo,
      });
      onScheduled(meeting);
      // Busy stays on until the details page replaces the dashboard.
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 422) {
        const serverMessage = /^unprocessable/i.test(err.message) || !err.message ? null : err.message;
        setErrors({
          when: serverMessage ?? "Check the date and time: a meeting can't start in the past.",
        });
      } else if (err instanceof ApiError) {
        setErrors({ form: { title: "Couldn't schedule the meeting", detail: err.message || "Please try again." } });
      } else {
        setErrors({ form: { title: "Unable to connect", detail: "Can't reach the server right now. Please try again." } });
      }
    }
  }

  const ids = {
    topic: `${id}-topic`,
    description: `${id}-description`,
    date: `${id}-date`,
    time: `${id}-time`,
    hours: `${id}-hours`,
    minutes: `${id}-minutes`,
  };

  return (
    <Modal title="Schedule meeting" onClose={onClose} closeDisabled={busy} widthClassName="max-w-lg">
      <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-5">
          <Field label="Topic" htmlFor={ids.topic} hint={errors.topic && <ErrorText>{errors.topic}</ErrorText>}>
            <input
              id={ids.topic}
              data-autofocus
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={200}
              aria-invalid={!!errors.topic || undefined}
              className={inputClass}
            />
          </Field>

          <Field label="Description (optional)" htmlFor={ids.description}>
            <textarea
              id={ids.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Add an agenda or notes"
              className={`${inputClass} resize-y`}
            />
          </Field>

          <div>
            <p className="mb-1.5 text-sm font-semibold text-ink">When</p>
            <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
              <label htmlFor={ids.date} className="sr-only">
                Date
              </label>
              <input
                id={ids.date}
                type="date"
                value={date}
                min={initial.today}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={!!errors.when || undefined}
                className={inputClass}
              />
              <label htmlFor={ids.time} className="sr-only">
                Time
              </label>
              <input
                id={ids.time}
                type="time"
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                aria-invalid={!!errors.when || undefined}
                className={inputClass}
              />
            </div>
            {errors.when && <ErrorText>{errors.when}</ErrorText>}
            <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
              <Globe className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Time zone: <span className="font-medium text-ink">{zoneLabel}</span>
                {zoneLabel !== zoneId && <span> ({zoneId})</span>}
              </span>
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-semibold text-ink">Duration</p>
            <div className="flex items-center gap-2">
              <label htmlFor={ids.hours} className="sr-only">
                Hours
              </label>
              <select
                id={ids.hours}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className={`${inputClass} w-20`}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span className="text-sm text-ink-muted">hr</span>
              <label htmlFor={ids.minutes} className="sr-only">
                Minutes
              </label>
              <select
                id={ids.minutes}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className={`${inputClass} w-20`}
              >
                {MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="text-sm text-ink-muted">min</span>
            </div>
            {errors.duration && <ErrorText>{errors.duration}</ErrorText>}
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-ink">Video</p>
            <div className="space-y-2">
              <OnOffRadios legend="Host" name={`${id}-host-video`} value={hostVideo} onChange={setHostVideo} />
              <OnOffRadios
                legend="Participant"
                name={`${id}-participant-video`}
                value={participantVideo}
                onChange={setParticipantVideo}
              />
            </div>
          </div>

          {errors.form && <Alert title={errors.form.title}>{errors.form.detail}</Alert>}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ErrorText({ children }: { children: string }) {
  return (
    <span role="alert" className="mt-1 block text-xs text-zoom-danger">
      {children}
    </span>
  );
}
