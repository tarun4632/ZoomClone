from datetime import UTC, datetime


def utcnow() -> datetime:
    """Timezone-aware current time in UTC, whole seconds."""
    return datetime.now(UTC).replace(microsecond=0)


def as_utc(value: datetime | None) -> datetime | None:
    """Attach UTC to naive datetimes (SQLite drops tzinfo); convert aware ones to UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
