"""Meeting business rules: create, list, join, leave (with host succession), end, cleanup."""

import asyncio
import logging
import secrets
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from urllib.parse import quote

from fastapi import HTTPException, status
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Meeting, MeetingParticipant, User
from ..schemas import (
    MAX_DURATION_MINUTES,
    JoinInput,
    JoinResponse,
    MeetingOwner,
    MeetingPublic,
    ParticipantCredentials,
    ScheduleMeetingInput,
)
from .ids import (
    generate_invite_token,
    generate_meeting_number,
    generate_participant_secret,
    generate_passcode,
    hash_secret,
    secret_matches,
)
from .livekit_service import LIST_ROOMS_TIMEOUT_SECONDS, LiveKitService

log = logging.getLogger(__name__)

MAX_NUMBER_ATTEMPTS = 5
# Gap between /join and LiveKit actually creating the room.
STALE_GRACE = timedelta(minutes=2)
# Gap between /join and that browser showing up in the LiveKit room. A row this new is never
# treated as "dropped without leaving", even if LiveKit doesn't list it yet.
CONNECT_GRACE = timedelta(seconds=30)
RECENT_LIMIT = 50


# ---------- views ----------


def invite_url(meeting: Meeting) -> str:
    """The link carries the random invite token, never the passcode itself."""
    return f"{settings.public_origin}/j/{meeting.meeting_number}?pwd={quote(meeting.invite_token)}"


def is_host_user(meeting: Meeting, user: User | None) -> bool:
    return user is not None and meeting.host_id == user.id


def to_public(meeting: Meeting, user: User | None) -> MeetingPublic:
    return MeetingPublic(
        meeting_number=meeting.meeting_number,
        title=meeting.title,
        host_name=meeting.host.name,
        meeting_type=meeting.meeting_type,
        status=meeting.status,
        host_video_on=meeting.host_video_on,
        participant_video_on=meeting.participant_video_on,
        is_host=is_host_user(meeting, user),
    )


def to_owner(meeting: Meeting, user: User) -> MeetingOwner:
    return MeetingOwner(
        **to_public(meeting, user).model_dump(),
        description=meeting.description,
        scheduled_start_at=meeting.scheduled_start_at,
        duration_minutes=meeting.duration_minutes,
        started_at=meeting.started_at,
        ended_at=meeting.ended_at,
        created_at=meeting.created_at,
        passcode=meeting.passcode,
        invite_url=invite_url(meeting),
    )


# ---------- lookup / checks ----------


def get_meeting_or_404(db: Session, number: str) -> Meeting:
    meeting = db.scalar(select(Meeting).where(Meeting.meeting_number == number))
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    return meeting


def _matches(given: str | None, expected: str) -> bool:
    return given is not None and secrets.compare_digest(given.encode(), expected.encode())


def get_details_or_404(db: Session, number: str, user: User) -> Meeting:
    """The meeting, if `user` hosts it or attended it while signed in. Anything else is the
    same 404 as an unknown number, so the details page reveals nothing about other meetings.
    """
    meeting = get_meeting_or_404(db, number)
    if not is_host_user(meeting, user):
        attended = db.scalar(
            select(MeetingParticipant.id)
            .where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.user_id == user.id,
            )
            .limit(1)
        )
        if attended is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    return meeting


def require_host_participant(
    db: Session, meeting: Meeting, creds: ParticipantCredentials
) -> MeetingParticipant:
    """In-meeting authority: the caller's row in this meeting is joined, currently a host,
    and the secret matches. Any failure is the same 403, so nothing leaks about why.
    """
    caller = db.scalar(
        select(MeetingParticipant).where(
            MeetingParticipant.identity == creds.identity,
            MeetingParticipant.meeting_id == meeting.id,
        )
    )
    if (
        caller is None
        or not secret_matches(creds.participant_secret, caller.secret_hash)
        or caller.status != "joined"
        or caller.role != "host"
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the host can do that")
    return caller


def get_participant_or_404(db: Session, meeting: Meeting, identity: str) -> MeetingParticipant:
    participant = db.scalar(
        select(MeetingParticipant).where(
            MeetingParticipant.identity == identity,
            MeetingParticipant.meeting_id == meeting.id,
        )
    )
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found")
    return participant


def require_own_participant(
    db: Session, meeting: Meeting, identity: str, secret: str | None
) -> MeetingParticipant:
    """The caller's own row. The identity alone proves nothing (everyone in the room can see
    it), so the secret from /join must match. 404 for an unknown identity, 403 otherwise.
    """
    participant = get_participant_or_404(db, meeting, identity)
    if not secret or not secret_matches(secret, participant.secret_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid participant secret")
    return participant


# ---------- create ----------


def save_new_meeting(db: Session, build: Callable[[str], Meeting]) -> Meeting:
    """Insert a meeting built by `build(meeting_number)`.

    On a meeting-number collision (UNIQUE constraint) roll back and retry with a new number.
    """
    for attempt in range(1, MAX_NUMBER_ATTEMPTS + 1):
        meeting = build(generate_meeting_number())
        db.add(meeting)
        try:
            db.commit()
            return meeting
        except IntegrityError as exc:
            db.rollback()
            if "meeting_number" not in str(exc.orig) or attempt == MAX_NUMBER_ATTEMPTS:
                raise
            log.info("meeting number collision, retrying (attempt %s)", attempt)
    raise RuntimeError("unreachable")


def create_instant(db: Session, user: User) -> Meeting:
    def build(number: str) -> Meeting:
        return Meeting(
            id=str(uuid.uuid4()),
            meeting_number=number,
            host_id=user.id,
            title=f"{user.name}'s Zoom Meeting",
            meeting_type="instant",
            # "Not started yet"; becomes live on the first join.
            status="scheduled",
            passcode=generate_passcode(),
            invite_token=generate_invite_token(),
        )

    return save_new_meeting(db, build)


def create_scheduled(db: Session, user: User, data: ScheduleMeetingInput) -> Meeting:
    def build(number: str) -> Meeting:
        return Meeting(
            id=str(uuid.uuid4()),
            meeting_number=number,
            host_id=user.id,
            title=data.title,
            description=data.description,
            meeting_type="scheduled",
            status="scheduled",
            scheduled_start_at=data.start_at,
            duration_minutes=data.duration_minutes,
            passcode=generate_passcode(),
            invite_token=generate_invite_token(),
            host_video_on=data.host_video_on,
            participant_video_on=data.participant_video_on,
        )

    return save_new_meeting(db, build)


# ---------- lists ----------


def scheduled_meetings_near_or_after(db: Session, user: User, now: datetime) -> list[Meeting]:
    """The host's scheduled meetings whose window could still be open, plus live ones.

    No duration exceeds MAX_DURATION_MINUTES, so anything that started earlier than that
    has certainly finished; the exact window check is done in Python.
    """
    earliest = now - timedelta(minutes=MAX_DURATION_MINUTES)
    return list(
        db.scalars(
            select(Meeting).where(
                Meeting.host_id == user.id,
                Meeting.meeting_type == "scheduled",
                or_(Meeting.status == "live", Meeting.scheduled_start_at > earliest),
            )
        )
    )


def list_upcoming(db: Session, user: User, now: datetime) -> list[Meeting]:
    """Decided by the schedule window, not by status (plus live meetings that overran)."""
    rows = [
        m
        for m in scheduled_meetings_near_or_after(db, user, now)
        if m.status == "live" or (m.window_end is not None and m.window_end > now)
    ]
    return sorted(rows, key=lambda m: m.scheduled_start_at)


def list_recent(db: Session, user: User) -> list[Meeting]:
    attended = select(MeetingParticipant.meeting_id).where(MeetingParticipant.user_id == user.id)
    return list(
        db.scalars(
            select(Meeting)
            .where(
                Meeting.status == "ended",
                or_(Meeting.host_id == user.id, Meeting.id.in_(attended)),
            )
            .order_by(Meeting.ended_at.desc())
            .limit(RECENT_LIMIT)
        )
    )


# ---------- lifecycle ----------


def _end_meeting(db: Session, meeting: Meeting, now: datetime) -> None:
    """Mark ended and close every open participant row. Caller commits."""
    if meeting.status != "ended":
        meeting.status = "ended"
        meeting.ended_at = now
    db.execute(
        update(MeetingParticipant)
        .where(MeetingParticipant.meeting_id == meeting.id, MeetingParticipant.status == "joined")
        .values(status="left", left_at=now)
    )


def _joined(db: Session, meeting: Meeting) -> list[MeetingParticipant]:
    """Everyone currently in the meeting, longest-present first."""
    return list(
        db.scalars(
            select(MeetingParticipant)
            .where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.status == "joined",
            )
            .order_by(MeetingParticipant.joined_at, MeetingParticipant.id)
        )
    )


def join(
    db: Session,
    meeting: Meeting,
    data: JoinInput,
    user: User | None,
    lk: LiveKitService,
    now: datetime,
) -> JoinResponse:
    """`user` is the signed-in caller, or None for a guest.

    The meeting's own host is recognised by their account and needs no passcode. Everyone
    else is an attendee and must send the passcode or the invite link's token.
    """
    is_host = is_host_user(meeting, user)
    if not is_host and not (
        _matches(data.passcode, meeting.passcode)
        or _matches(data.invite_token, meeting.invite_token)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid meeting passcode")

    if meeting.status == "ended":
        window_open = meeting.window_end is not None and meeting.window_end > now
        if not (is_host or (meeting.meeting_type == "scheduled" and window_open)):
            raise HTTPException(status.HTTP_410_GONE, "This meeting has ended")
        # Restart.
        meeting.status = "live"
        meeting.started_at = now
        meeting.ended_at = None
    elif meeting.status == "scheduled":
        # First join of a scheduled meeting or a new instant meeting.
        meeting.status = "live"
        meeting.started_at = now

    identity = str(uuid.uuid4())
    secret = generate_participant_secret()
    db.add(
        MeetingParticipant(
            meeting_id=meeting.id,
            # Signed-in joins are tied to the account (they show up in its Recent list).
            user_id=user.id if user else None,
            display_name=data.display_name,
            identity=identity,
            role="host" if is_host else "attendee",
            status="joined",
            secret_hash=hash_secret(secret),
            joined_at=now,
        )
    )
    db.commit()

    return JoinResponse(
        identity=identity,
        role="host" if is_host else "attendee",
        token=lk.create_token(meeting.id, identity, data.display_name, is_host),
        livekit_url=settings.LIVEKIT_URL,
        meeting_number=meeting.meeting_number,
        title=meeting.title,
        passcode=meeting.passcode,
        invite_url=invite_url(meeting),
        participant_secret=secret,
    )


def check_can_become_host(target: MeetingParticipant) -> None:
    if target.status != "joined":
        raise HTTPException(status.HTTP_409_CONFLICT, "Participant is not in the meeting")
    if target.role == "host":
        raise HTTPException(status.HTTP_409_CONFLICT, "Participant is already a host")


def hand_over_host(
    db: Session, caller: MeetingParticipant, target: MeetingParticipant
) -> None:
    """Target becomes host, caller becomes attendee. user_id is left as it is."""
    target.role = "host"
    caller.role = "attendee"
    db.commit()


def is_last_host(db: Session, meeting: Meeting, participant: MeetingParticipant) -> bool:
    """True if this participant leaving would leave other people in the meeting with no host."""
    if participant.status != "joined" or participant.role != "host":
        return False
    others = [p for p in _joined(db, meeting) if p.id != participant.id]
    return bool(others) and not any(p.role == "host" for p in others)


def leave(
    db: Session,
    meeting: Meeting,
    participant: MeetingParticipant,
    now: datetime,
    present: set[str] | None = None,
) -> MeetingParticipant | None:
    """Idempotent. Never overwrites 'removed'. Ends the meeting when nobody is left.

    Host succession: if the last host leaves while others remain, the participant who has
    been in the meeting longest becomes host, so a meeting is never left without one.
    `present` is the set of identities connected to the LiveKit room right now (None if
    unknown); someone actually connected is preferred over a row whose browser may have
    crashed without sending a leave. Returns the new host, or None. The caller updates that
    participant's LiveKit metadata.
    """
    # The caller may have awaited LiveKit since loading these; read the current state.
    db.refresh(participant)
    db.refresh(meeting)
    if participant.status != "joined":
        return None
    was_host = participant.role == "host"
    participant.status = "left"
    participant.left_at = now
    db.flush()

    promoted: MeetingParticipant | None = None
    remaining = _joined(db, meeting)
    if not remaining:
        if meeting.status == "live":
            _end_meeting(db, meeting, now)
    elif was_host:
        promoted = _promote_if_hostless(remaining, present)
    db.commit()
    return promoted


def _promote_if_hostless(
    remaining: list[MeetingParticipant], present: set[str] | None
) -> MeetingParticipant | None:
    """If nobody in `remaining` (longest-present first) is a host, make one of them host:
    the first who is connected to LiveKit, else simply the first. Caller commits.
    """
    if not remaining or any(p.role == "host" for p in remaining):
        return None
    connected = [p for p in remaining if present is not None and p.identity in present]
    promoted = (connected or remaining)[0]
    promoted.role = "host"
    return promoted


def reconcile(
    db: Session,
    meeting: Meeting,
    caller_identity: str,
    present: dict[str, str | None],
    now: datetime,
) -> list[MeetingParticipant]:
    """Bring the participant rows in line with who is really connected to the LiveKit room.

    This is what replaces a host who vanished: a crashed browser or a lost network sends no
    leave, so the row would stay "joined" and "host" forever. The people still in the call
    ask for this check when LiveKit tells them a host dropped.

    - A joined row LiveKit no longer lists has left, and gives up the host role. Rows newer
      than CONNECT_GRACE are spared: that browser may still be connecting.
    - A row marked left that LiveKit lists again has come back (its connection recovered
      after it was written off). It rejoins with the role it has now, i.e. as an attendee.
    - If that leaves nobody as host, the longest-present connected participant becomes host.

    `present` maps each identity connected to the LiveKit room to the role in its LiveKit
    metadata. Does nothing unless the caller is among them: the check is only trusted from
    inside the room. Returns the connected participants whose metadata disagrees with their
    row (a new host, someone who came back, or an earlier update that failed); the caller
    sets their metadata to the row's role, so labels and controls heal themselves.
    """
    # The caller awaited LiveKit before this; drop anything loaded earlier in the request.
    db.expire_all()
    if meeting.status != "live" or caller_identity not in present:
        return []

    rows = list(
        db.scalars(
            select(MeetingParticipant)
            .where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.status.in_(("joined", "left")),  # never revive 'removed'
            )
            .order_by(MeetingParticipant.joined_at, MeetingParticipant.id)
        )
    )
    for row in rows:
        if row.status == "joined" and row.identity not in present:
            if row.joined_at <= now - CONNECT_GRACE:
                row.status = "left"
                row.left_at = now
                row.role = "attendee"
        elif row.status == "left" and row.identity in present:
            row.status = "joined"
            row.left_at = None

    joined = [r for r in rows if r.status == "joined"]
    _promote_if_hostless(joined, set(present))
    db.commit()
    return [r for r in joined if r.identity in present and present[r.identity] != r.role]


def end(db: Session, meeting: Meeting, now: datetime) -> None:
    _end_meeting(db, meeting, now)
    db.commit()


def mark_removed(db: Session, participant: MeetingParticipant, now: datetime) -> None:
    participant.status = "removed"
    if participant.left_at is None:
        participant.left_at = now
    db.commit()


def host_identities(db: Session, meeting: Meeting) -> set[str]:
    """Every joined host row (covers a host with two tabs open)."""
    return set(
        db.scalars(
            select(MeetingParticipant.identity).where(
                MeetingParticipant.meeting_id == meeting.id,
                MeetingParticipant.role == "host",
                MeetingParticipant.status == "joined",
            )
        )
    )


async def cleanup_stale_meetings(db: Session, lk: LiveKitService, now: datetime) -> int:
    """End 'live' meetings that started over STALE_GRACE ago and have no LiveKit room.

    Best effort: if LiveKit is unreachable (or the keys are fake), do nothing.
    Returns the number of meetings ended.
    """
    candidates = list(
        db.scalars(
            select(Meeting).where(
                Meeting.status == "live",
                or_(Meeting.started_at.is_(None), Meeting.started_at < now - STALE_GRACE),
            )
        )
    )
    if not candidates:
        return 0
    try:
        active = await asyncio.wait_for(lk.active_room_names(), LIST_ROOMS_TIMEOUT_SECONDS + 1)
    except Exception as exc:  # noqa: BLE001 - never break the dashboard over LiveKit
        log.warning("stale-meeting cleanup skipped: LiveKit list_rooms failed: %r", exc)
        return 0
    ended = 0
    for meeting in candidates:
        if meeting.id not in active:
            _end_meeting(db, meeting, now)
            ended += 1
    if ended:
        db.commit()
    return ended
