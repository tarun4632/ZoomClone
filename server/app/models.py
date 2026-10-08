import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from .database import Base
from .timeutil import as_utc, utcnow


class UTCDateTime(TypeDecorator):
    """Stores naive UTC (SQLite has no timezone); always returns timezone-aware UTC."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        return as_utc(value).replace(tzinfo=None)

    def process_result_value(self, value, dialect):  # noqa: ANN001, ANN201
        if value is None:
            return None
        return value.replace(tzinfo=UTC)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    avatar_color: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=utcnow, server_default=func.current_timestamp()
    )


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (
        CheckConstraint("meeting_type IN ('instant','scheduled')", name="ck_meetings_type"),
        CheckConstraint("status IN ('scheduled','live','ended')", name="ck_meetings_status"),
        CheckConstraint("duration_minutes > 0", name="ck_meetings_duration_positive"),
        CheckConstraint(
            "meeting_type = 'instant' OR scheduled_start_at IS NOT NULL",
            name="ck_meetings_scheduled_has_start",
        ),
        Index("ix_meetings_host_status_start", "host_id", "status", "scheduled_start_at"),
    )

    # UUID; also the LiveKit room name.
    id: Mapped[str] = mapped_column(Text, primary_key=True, default=lambda: str(uuid.uuid4()))
    # 11 digits, shown as "123 4567 8901".
    meeting_number: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    host_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    meeting_type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    scheduled_start_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    duration_minutes: Mapped[int | None] = mapped_column(Integer)
    passcode: Mapped[str] = mapped_column(Text, nullable=False)
    host_key: Mapped[str] = mapped_column(Text, nullable=False)
    host_video_on: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("1")
    )
    participant_video_on: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("1")
    )
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=utcnow, server_default=func.current_timestamp()
    )

    host: Mapped[User] = relationship(lazy="joined")
    participants: Mapped[list["MeetingParticipant"]] = relationship(
        back_populates="meeting", passive_deletes=True
    )

    @property
    def window_end(self) -> datetime | None:
        """Scheduled end time (start + duration), or None for instant meetings."""
        if self.scheduled_start_at is None or self.duration_minutes is None:
            return None
        return self.scheduled_start_at + timedelta(minutes=self.duration_minutes)


class MeetingParticipant(Base):
    """One row per join. user_id is set for host joins; NULL means a guest."""

    __tablename__ = "meeting_participants"
    __table_args__ = (
        CheckConstraint("role IN ('host','attendee')", name="ck_participants_role"),
        CheckConstraint("status IN ('joined','left','removed')", name="ck_participants_status"),
        Index("ix_participants_meeting_status", "meeting_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    meeting_id: Mapped[str] = mapped_column(
        Text, ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL")
    )
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Random UUID; the LiveKit identity.
    identity: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # Current role. Can move during the meeting (Make Host).
    role: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 hex of the participant secret returned once by /join. It proves "I am this
    # participant" for in-meeting host actions. NULL for seeded history rows.
    secret_hash: Mapped[str | None] = mapped_column(Text)
    joined_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=utcnow, server_default=func.current_timestamp()
    )
    left_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    meeting: Mapped[Meeting] = relationship(back_populates="participants")
