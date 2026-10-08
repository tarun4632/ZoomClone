"""Request/response models. Mirrors client/src/lib/types.ts exactly.

Datetimes always go out timezone-aware in UTC (pydantic renders them as "...Z").
"""

import re
from datetime import datetime, timedelta
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from .timeutil import as_utc, utcnow

UTCDatetime = Annotated[datetime, AfterValidator(as_utc)]

MeetingType = Literal["instant", "scheduled"]
MeetingStatus = Literal["scheduled", "live", "ended"]
Role = Literal["host", "attendee"]

# A start time picked "for now" in a minute-granularity picker is up to a minute old by the
# time it arrives; allow a small grace before calling it "in the past".
START_AT_GRACE = timedelta(minutes=5)
MAX_DURATION_MINUTES = 24 * 60
MIN_PASSWORD_LENGTH = 8
# Deliberately loose: something@something.tld. Real proof of an address would be a mail to it.
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    avatar_color: str | None


def _normalize_email(v: object) -> object:
    return v.strip().lower() if isinstance(v, str) else v


class SignupInput(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, v: object) -> object:
        return _normalize_email(v)

    @field_validator("email")
    @classmethod
    def _looks_like_email(cls, v: str) -> str:
        if not EMAIL_PATTERN.match(v):
            raise ValueError("Enter a valid email address")
        return v


class LoginInput(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, v: object) -> object:
        return _normalize_email(v)


class AuthOut(BaseModel):
    """Sign-up / sign-in result. Send the token back as `Authorization: Bearer <token>`."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserOut


class MeetingPublic(BaseModel):
    meeting_number: str
    title: str
    host_name: str
    meeting_type: MeetingType
    status: MeetingStatus
    host_video_on: bool
    participant_video_on: bool
    # True when the request carries the bearer token of this meeting's host.
    is_host: bool


class MeetingOwner(MeetingPublic):
    description: str | None
    scheduled_start_at: UTCDatetime | None
    duration_minutes: int | None
    started_at: UTCDatetime | None
    ended_at: UTCDatetime | None
    created_at: UTCDatetime
    passcode: str
    invite_url: str


class ScheduleMeetingInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    start_at: UTCDatetime
    duration_minutes: int = Field(gt=0, le=MAX_DURATION_MINUTES)
    host_video_on: bool = True
    participant_video_on: bool = True

    @field_validator("title", mode="before")
    @classmethod
    def _strip_title(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("description", mode="before")
    @classmethod
    def _blank_description_is_none(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("start_at")
    @classmethod
    def _not_in_past(cls, v: datetime) -> datetime:
        # Naive input is treated as UTC by as_utc; aware input is converted to UTC.
        if v < utcnow() - START_AT_GRACE:
            raise ValueError("start_at must not be in the past")
        return v.replace(microsecond=0)


class JoinInput(BaseModel):
    """The meeting's host (by bearer token) needs neither; anyone else sends one of the two."""

    display_name: str = Field(min_length=1, max_length=64)
    # Typed by hand.
    passcode: str | None = Field(default=None, max_length=64)
    # The ?pwd= value of an invite link.
    invite_token: str | None = Field(default=None, max_length=128)

    @field_validator("display_name", mode="before")
    @classmethod
    def _strip_name(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("passcode", "invite_token", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v


class JoinResponse(BaseModel):
    identity: str
    role: Role
    token: str
    livekit_url: str
    meeting_number: str
    title: str
    passcode: str
    invite_url: str
    # Private to this participant; proves identity for leave and in-meeting host actions.
    participant_secret: str


class ParticipantCredentials(BaseModel):
    """The caller's own identity + secret from /join. Body of every in-meeting host action."""

    identity: str = Field(min_length=1, max_length=128)
    participant_secret: str = Field(min_length=1, max_length=256)


class HealthOut(BaseModel):
    status: str
