import os
import shutil
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import pytest

# Point the app at a throwaway SQLite file and dummy LiveKit settings BEFORE importing it.
_TMP_DIR = Path(tempfile.mkdtemp(prefix="zoomclone-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP_DIR / 'test.db').as_posix()}"
os.environ["CLIENT_ORIGIN"] = "http://localhost:3000,http://127.0.0.1:3000"
os.environ["LIVEKIT_URL"] = "wss://fake.livekit.test"
os.environ["LIVEKIT_API_KEY"] = "testkey"
os.environ["LIVEKIT_API_SECRET"] = "testsecret-testsecret-testsecret-testsecret"

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Meeting  # noqa: E402
from app.seed import default_user  # noqa: E402
from app.services.ids import generate_host_key, generate_meeting_number, generate_passcode  # noqa: E402
from app.services.livekit_service import get_livekit  # noqa: E402


class FakeLiveKit:
    """Stands in for LiveKitService. A minted token counts as 'connected to the room'."""

    def __init__(self) -> None:
        self.rooms: dict[str, set[str]] = {}
        self.muted: set[str] = set()
        self.mute_calls: list[tuple[str, set[str]]] = []
        self.removed: list[tuple[str, str]] = []
        self.ended_rooms: list[str] = []
        self.muted_one: list[tuple[str, str]] = []
        self.role_updates: list[tuple[str, str, str]] = []
        # Set to an exception to make set_participant_role fail for that identity.
        self.fail_role_update_for: dict[str, Exception] = {}

    def create_token(self, room: str, identity: str, name: str, is_host: bool) -> str:
        self.rooms.setdefault(room, set()).add(identity)
        return f"fake-token:{room}:{identity}:{'host' if is_host else 'attendee'}"

    async def mute_all(self, room: str, host_identities: set[str]) -> None:
        self.mute_calls.append((room, set(host_identities)))
        for identity in self.rooms.get(room, set()):
            if identity not in host_identities:
                self.muted.add(identity)

    async def mute_participant_audio(self, room: str, identity: str) -> None:
        self.muted_one.append((room, identity))
        self.muted.add(identity)

    async def set_participant_role(self, room: str, identity: str, role: str) -> None:
        if identity in self.fail_role_update_for:
            raise self.fail_role_update_for[identity]
        self.role_updates.append((room, identity, role))

    async def remove_participant(self, room: str, identity: str) -> None:
        self.removed.append((room, identity))
        self.rooms.get(room, set()).discard(identity)

    async def end_room(self, room: str) -> None:
        self.ended_rooms.append(room)
        self.rooms.pop(room, None)

    async def active_room_names(self) -> set[str]:
        return set(self.rooms)


@pytest.fixture
def fake_lk() -> FakeLiveKit:
    return FakeLiveKit()


@pytest.fixture
def client(fake_lk: FakeLiveKit):
    # Fresh schema per test; the app's lifespan re-creates tables and seeds.
    Base.metadata.drop_all(bind=engine)
    app.dependency_overrides[get_livekit] = lambda: fake_lk
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def insert_meeting(db, **fields) -> Meeting:
    """Insert a meeting for the default user directly (e.g. with past times)."""
    user = default_user(db)
    values = dict(
        id=str(uuid.uuid4()),
        meeting_number=generate_meeting_number(),
        host_id=user.id,
        title="Direct insert",
        meeting_type="scheduled",
        status="scheduled",
        passcode=generate_passcode(),
        host_key=generate_host_key(),
    )
    values.update(fields)
    meeting = Meeting(**values)
    db.add(meeting)
    db.commit()
    return meeting


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def pytest_sessionfinish(session, exitstatus) -> None:  # noqa: ANN001
    engine.dispose()
    shutil.rmtree(_TMP_DIR, ignore_errors=True)
