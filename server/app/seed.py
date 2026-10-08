"""Demo data.

- seed_once: users plus ended meetings (for Recent), only when the database is empty.
  Past data never goes stale.
- ensure_demo_passwords: lets the demo users sign in with DEMO_PASSWORD, also on a database
  seeded before accounts existed.
- top_up_upcoming: keeps the demo user at >= 3 scheduled meetings whose window is still
  ahead. Runs on startup and before the demo user's GET /meetings?scope=upcoming, so
  Upcoming stays filled even if the service runs for weeks. Other accounts get no demo data.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Meeting, MeetingParticipant, User
from .services import auth_service, meeting_service
from .services.ids import generate_invite_token, generate_passcode
from .timeutil import utcnow

log = logging.getLogger(__name__)

DEFAULT_USER_EMAIL = "alex.johnson@example.com"
# Public on purpose: the demo account is how a visitor tries the app without signing up.
# The sign-in page offers it as "Use the demo account" (client/src/lib/auth.ts).
DEMO_PASSWORD = "zoomclone-demo"
UPCOMING_TARGET = 3

USERS = [
    ("Alex Johnson", DEFAULT_USER_EMAIL, "#0B5CFF"),
    ("Priya Sharma", "priya.sharma@example.com", "#FF742E"),
    ("Marcus Lee", "marcus.lee@example.com", "#12A150"),
]


@dataclass(frozen=True)
class DemoSlot:
    title: str
    description: str
    hour: int
    minute: int
    duration_minutes: int


DEMO_SLOTS = [
    DemoSlot("Weekly Team Sync", "Status updates, blockers and priorities for the week.", 10, 0, 30),
    DemoSlot("Product Roadmap Review", "Walk through the Q4 roadmap and open questions.", 14, 0, 60),
    DemoSlot("1:1 with Priya", "Regular check-in.", 9, 30, 30),
    DemoSlot("Design Critique", "Review the latest dashboard mockups.", 15, 0, 45),
]
# Preferred day offsets for new demo meetings: tomorrow, in 3 days, in 7 days, then any day.
DEMO_DAY_OFFSETS = [1, 3, 7, *range(2, 61)]


def _participant(
    name: str, role: str, joined: datetime, left: datetime, user: User | None = None
) -> MeetingParticipant:
    return MeetingParticipant(
        user_id=user.id if user else None,
        display_name=name,
        identity=str(uuid.uuid4()),
        role=role,
        status="left",
        joined_at=joined,
        left_at=left,
    )


def seed_once(db: Session) -> bool:
    """Insert users and past meetings if there are no users yet. Returns True if it seeded."""
    if db.scalar(select(User.id).limit(1)) is not None:
        return False

    users = [User(name=n, email=e, avatar_color=c) for n, e, c in USERS]
    db.add_all(users)
    db.commit()
    alex, priya, marcus = users

    base = utcnow().replace(minute=0, second=0)

    def ended_meeting(
        host: User,
        title: str,
        meeting_type: str,
        days_ago: int,
        hour: int,
        minutes: int,
        guests: list[tuple[str, User | None]],
        description: str | None = None,
    ) -> None:
        start = (base - timedelta(days=days_ago)).replace(hour=hour)
        started = start + timedelta(minutes=2)
        ended = start + timedelta(minutes=minutes)

        def build(number: str) -> Meeting:
            meeting = Meeting(
                id=str(uuid.uuid4()),
                meeting_number=number,
                host_id=host.id,
                title=title,
                description=description,
                meeting_type=meeting_type,
                status="ended",
                scheduled_start_at=start if meeting_type == "scheduled" else None,
                duration_minutes=minutes if meeting_type == "scheduled" else None,
                passcode=generate_passcode(),
                invite_token=generate_invite_token(),
                started_at=started,
                ended_at=ended,
                created_at=start - timedelta(days=2) if meeting_type == "scheduled" else started,
            )
            meeting.participants.append(_participant(host.name, "host", started, ended, host))
            for i, (name, user) in enumerate(guests):
                meeting.participants.append(
                    _participant(name, "attendee", started + timedelta(minutes=i + 1), ended, user)
                )
            return meeting

        meeting_service.save_new_meeting(db, build)

    ended_meeting(
        alex, "Sprint Planning", "scheduled", 1, 15, 60,
        [("Priya Sharma", None), ("Marcus Lee", None)],
        "Plan the next two-week sprint.",
    )
    # Hosted by another user; the demo user attended (user_id set on the attendee row).
    ended_meeting(
        priya, "Marketing Sync", "scheduled", 2, 11, 30,
        [("Alex Johnson", alex), ("Jordan Kim", None)],
        "Campaign performance and next steps.",
    )
    ended_meeting(alex, "Alex Johnson's Zoom Meeting", "instant", 3, 16, 25, [("Sam Rivera", None)])
    ended_meeting(
        alex, "Client Demo Prep", "scheduled", 5, 13, 45,
        [("Marcus Lee", None)],
        "Dry run of the client demo.",
    )
    # Not involving the demo user, so it must not appear in their Recent list.
    ended_meeting(marcus, "Infra Office Hours", "instant", 4, 10, 40, [("Jordan Kim", None)])

    log.info("seeded demo users and past meetings")
    return True


def ensure_demo_passwords(db: Session) -> int:
    """Give every demo user without a password DEMO_PASSWORD. Returns how many were set."""
    emails = [email for _, email, _ in USERS]
    users = list(
        db.scalars(select(User).where(User.email.in_(emails), User.password_hash.is_(None)))
    )
    if users:
        # One hash for all of them: hashing is slow on purpose, and the password is public.
        password_hash = auth_service.hash_password(DEMO_PASSWORD)
        for user in users:
            user.password_hash = password_hash
        db.commit()
    return len(users)


def top_up_upcoming(db: Session, user: User, now: datetime | None = None) -> int:
    """Add demo meetings until the user has UPCOMING_TARGET scheduled meetings ahead."""
    now = now or utcnow()
    nearby = meeting_service.scheduled_meetings_near_or_after(db, user, now)
    ahead = [m for m in nearby if m.window_end is not None and m.window_end > now]
    needed = UPCOMING_TARGET - len(ahead)
    if needed <= 0:
        return 0

    taken_days = {m.scheduled_start_at.date() for m in nearby if m.scheduled_start_at}
    added = 0
    seen: set[int] = set()
    for offset in DEMO_DAY_OFFSETS:
        if added >= needed:
            break
        if offset in seen:
            continue
        seen.add(offset)
        day = now.date() + timedelta(days=offset)
        if day in taken_days:
            continue
        slot = DEMO_SLOTS[(len(ahead) + added) % len(DEMO_SLOTS)]
        start = datetime.combine(day, time(slot.hour, slot.minute), tzinfo=UTC)

        def build(number: str, slot: DemoSlot = slot, start: datetime = start) -> Meeting:
            return Meeting(
                id=str(uuid.uuid4()),
                meeting_number=number,
                host_id=user.id,
                title=slot.title,
                description=slot.description,
                meeting_type="scheduled",
                status="scheduled",
                scheduled_start_at=start,
                duration_minutes=slot.duration_minutes,
                passcode=generate_passcode(),
                invite_token=generate_invite_token(),
            )

        meeting_service.save_new_meeting(db, build)
        taken_days.add(day)
        added += 1
    if added:
        log.info("added %s demo upcoming meeting(s)", added)
    return added


def default_user(db: Session) -> User | None:
    return db.scalar(select(User).where(User.email == DEFAULT_USER_EMAIL))


def run_startup_seed(db: Session) -> None:
    seed_once(db)
    ensure_demo_passwords(db)
    user = default_user(db)
    if user is not None:
        top_up_upcoming(db, user)
