"""Request/response models. Mirrors client/src/lib/types.ts exactly.

Datetimes always go out timezone-aware in UTC (pydantic renders them as "...Z").
"""

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


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    avatar_color: str | None


class MeetingPublic(BaseModel):
    meeting_number: str
    title: str
    host_name: str
    meeting_type: MeetingType
    status: MeetingStatus
    host_video_on: bool
    participant_video_on: bool


class MeetingOwner(MeetingPublic):
    description: str | None
    scheduled_start_at: UTCDatetime | None
    duration_minutes: int | None
    started_at: UTCDatetime | None
    ended_at: UTCDatetime | None
    created_at: UTCDatetime
    passcode: str
    host_key: str | None
    invite_url: str
    is_host: bool


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
    display_name: str = Field(min_length=1, max_length=64)
    passcode: str | None = None
    host_key: str | None = None

    @field_validator("display_name", mode="before")
    @classmethod
    def _strip_name(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("passcode", "host_key", mode="before")
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


class HostKeyInput(BaseModel):
    host_key: str


class HealthOut(BaseModel):
    status: str
