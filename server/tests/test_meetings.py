"""Backend tests: the 8 from PLAN.MD section 4, plus Make Host (9) and Mute one (10).

LiveKit is replaced by FakeLiveKit; the real LiveKitService runs against a stubbed client.
"""

import asyncio
import hashlib
import json
import re
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import Meeting, MeetingParticipant
from app.services import livekit_service, meeting_service
from app.timeutil import utcnow
from tests.conftest import insert_meeting, parse_iso

ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def schedule(client, *, start_in=timedelta(hours=2), minutes=30, title="Test meeting"):
    res = client.post(
        "/api/meetings",
        json={
            "title": title,
            "description": None,
            "start_at": (utcnow() + start_in).isoformat().replace("+00:00", "Z"),
            "duration_minutes": minutes,
            "host_video_on": True,
            "participant_video_on": False,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def join(client, number, *, name="Guest", passcode=None, host_key=None):
    body = {"display_name": name}
    if passcode is not None:
        body["passcode"] = passcode
    if host_key is not None:
        body["host_key"] = host_key
    return client.post(f"/api/meetings/{number}/join", json=body)


def leave(client, number, identity):
    # No body and no Content-Type, exactly like navigator.sendBeacon(url).
    return client.post(f"/api/meetings/{number}/participants/{identity}/leave")


def creds(joined):
    """Body for in-meeting host actions: the caller's own identity + secret."""
    return {"identity": joined["identity"], "participant_secret": joined["participant_secret"]}


def host_action(client, number, action, caller, target=None):
    path = f"/api/meetings/{number}/{action}" if target is None else (
        f"/api/meetings/{number}/participants/{target}/{action}"
    )
    return client.post(path, json=creds(caller))


def status_of(client, number):
    res = client.get(f"/api/meetings/{number}")
    assert res.status_code == 200
    return res.json()["status"]


def numbers(meetings):
    return {m["meeting_number"] for m in meetings}


# 1
def test_create_instant_meeting(client, monkeypatch):
    created = [client.post("/api/meetings/instant") for _ in range(5)]
    assert all(r.status_code == 201 for r in created)
    bodies = [r.json() for r in created]

    m = bodies[0]
    assert re.fullmatch(r"[1-9]\d{10}", m["meeting_number"])
    assert re.fullmatch(r"[A-Za-z0-9]{6}", m["passcode"])
    assert m["host_key"] and len(m["host_key"]) >= 16
    assert m["is_host"] is True
    assert m["title"] == "Alex Johnson's Zoom Meeting"
    assert m["meeting_type"] == "instant"
    assert m["status"] == "scheduled"
    assert m["host_name"] == "Alex Johnson"
    assert m["invite_url"] == f"http://localhost:3000/j/{m['meeting_number']}?pwd={m['passcode']}"
    assert ISO_UTC.match(m["created_at"])
    assert len(numbers(bodies)) == 5

    # A colliding meeting number is rolled back and retried.
    taken = m["meeting_number"]
    fresh = iter([taken, taken, "98765432109"])
    monkeypatch.setattr(meeting_service, "generate_meeting_number", lambda: next(fresh))
    res = client.post("/api/meetings/instant")
    assert res.status_code == 201
    assert res.json()["meeting_number"] == "98765432109"

    # Scheduling in the past is a validation error.
    past = (utcnow() - timedelta(hours=1)).isoformat()
    res = client.post(
        "/api/meetings",
        json={"title": "Late", "start_at": past, "duration_minutes": 30},
    )
    assert res.status_code == 422


# 2
def test_upcoming_list(client, db, fake_lk):
    now = utcnow()
    future = schedule(client, title="Future")
    early = schedule(client, start_in=timedelta(days=1), title="Tested early")

    # Started and ended early: stays in Upcoming because its window is ahead.
    j = join(client, early["meeting_number"], host_key=early["host_key"]).json()
    assert leave(client, early["meeting_number"], j["identity"]).status_code == 204
    assert status_of(client, early["meeting_number"]) == "ended"

    # Live and running past its scheduled window: shown as "In progress".
    overran = insert_meeting(
        db,
        title="Overran",
        status="live",
        scheduled_start_at=now - timedelta(hours=3),
        duration_minutes=30,
        started_at=now - timedelta(hours=3),
    )
    fake_lk.rooms[overran.id] = {"someone"}  # its LiveKit room still exists

    # Window over: not upcoming.
    past = insert_meeting(
        db,
        title="Past",
        scheduled_start_at=now - timedelta(hours=2),
        duration_minutes=30,
    )

    # Live but its LiveKit room is gone (crashed clients): stale cleanup ends it.
    stale = insert_meeting(
        db, title="Stale", meeting_type="instant", status="live", started_at=now - timedelta(minutes=5)
    )

    res = client.get("/api/meetings", params={"scope": "upcoming"})
    assert res.status_code == 200
    upcoming = res.json()
    by_number = {m["meeting_number"]: m for m in upcoming}

    assert future["meeting_number"] in by_number
    assert early["meeting_number"] in by_number
    assert by_number[early["meeting_number"]]["status"] == "ended"
    assert by_number[overran.meeting_number]["status"] == "live"
    assert past.meeting_number not in by_number

    starts = [parse_iso(m["scheduled_start_at"]) for m in upcoming]
    assert starts == sorted(starts)
    assert all(ISO_UTC.match(m["scheduled_start_at"]) for m in upcoming)
    assert all(m["host_key"] and m["is_host"] for m in upcoming)

    assert status_of(client, stale.meeting_number) == "ended"
    recent = client.get("/api/meetings", params={"scope": "recent"}).json()
    assert stale.meeting_number in numbers(recent)


# 3
def test_unknown_meeting_returns_404(client):
    assert client.get("/api/meetings/12345678901").status_code == 404
    assert client.get("/api/meetings/12345678901/details").status_code == 404
    assert join(client, "12345678901", passcode="abc123").status_code == 404
    assert client.get("/api/meetings/12345678901").json() == {"detail": "Meeting not found"}


# 4
def test_join_passcode_and_host_key(client):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]

    assert join(client, number, passcode="wrong1").status_code == 403
    assert join(client, number).status_code == 403  # no passcode at all
    assert join(client, number, host_key="not-the-key").status_code == 403

    res = join(client, number, name="Alex", host_key=m["host_key"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["role"] == "host"
    assert body["passcode"] == m["passcode"]
    assert body["invite_url"] == m["invite_url"]
    assert body["meeting_number"] == number
    assert body["title"] == m["title"]
    assert body["livekit_url"] == "wss://fake.livekit.test"
    assert body["token"]
    assert len(body["participant_secret"]) >= 32

    public = client.get(f"/api/meetings/{number}").json()
    assert "passcode" not in public and "host_key" not in public


# 5
def test_join_roles_and_user_id(client, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]

    host = join(client, number, name="Alex", host_key=m["host_key"]).json()
    guest = join(client, number, name="Guest", passcode=m["passcode"]).json()
    assert host["role"] == "host"
    assert guest["role"] == "attendee"

    rows = {
        p.identity: p
        for p in db.scalars(select(MeetingParticipant).where(MeetingParticipant.identity.in_(
            [host["identity"], guest["identity"]]
        )))
    }
    me = client.get("/api/me").json()
    assert rows[host["identity"]].role == "host"
    assert rows[host["identity"]].user_id == me["id"]
    assert rows[guest["identity"]].role == "attendee"
    assert rows[guest["identity"]].user_id is None
    assert all(r.status == "joined" for r in rows.values())
    assert status_of(client, number) == "live"

    # Only the SHA-256 of the participant secret is stored.
    for joined in (host, guest):
        stored = rows[joined["identity"]].secret_hash
        assert stored == hashlib.sha256(joined["participant_secret"].encode()).hexdigest()
        assert stored != joined["participant_secret"]


# 6
def test_last_leave_ends_meeting_and_leave_is_idempotent(client, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, name="Alex", host_key=m["host_key"]).json()
    guest = join(client, number, name="Guest", passcode=m["passcode"]).json()

    assert leave(client, number, guest["identity"]).status_code == 204
    assert status_of(client, number) == "live"

    res = leave(client, number, host["identity"])
    assert res.status_code == 204 and res.content == b""
    assert status_of(client, number) == "ended"

    recent = client.get("/api/meetings", params={"scope": "recent"}).json()
    assert number in numbers(recent)

    meeting = db.scalar(select(Meeting).where(Meeting.meeting_number == number))
    host_row = db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == host["identity"]))
    ended_at, left_at = meeting.ended_at, host_row.left_at

    # Second call: 204, nothing changes.
    assert leave(client, number, host["identity"]).status_code == 204
    db.expire_all()
    assert meeting.status == "ended" and meeting.ended_at == ended_at
    assert host_row.status == "left" and host_row.left_at == left_at

    # The identity must belong to that meeting number.
    other = client.post("/api/meetings/instant").json()
    assert leave(client, other["meeting_number"], host["identity"]).status_code == 404
    assert leave(client, number, "no-such-identity").status_code == 404

    # A removed participant's leave never overwrites 'removed'.
    m2 = client.post("/api/meetings/instant").json()
    h2 = join(client, m2["meeting_number"], host_key=m2["host_key"]).json()
    g2 = join(client, m2["meeting_number"], passcode=m2["passcode"]).json()
    res = host_action(client, m2["meeting_number"], "remove", h2, target=g2["identity"])
    assert res.status_code == 204
    assert leave(client, m2["meeting_number"], g2["identity"]).status_code == 204
    g2_row = db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == g2["identity"]))
    assert g2_row.status == "removed"
    assert status_of(client, m2["meeting_number"]) == "live"  # host still there
    assert h2["role"] == "host"


# 7
def test_restart_rules(client, db):
    # Ended instant meeting: attendee gets 410, host restarts it.
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, host_key=m["host_key"]).json()
    leave(client, number, host["identity"])
    assert status_of(client, number) == "ended"

    res = join(client, number, passcode=m["passcode"])
    assert res.status_code == 410
    assert res.json() == {"detail": "This meeting has ended"}

    assert join(client, number, host_key=m["host_key"]).status_code == 200
    details = client.get(f"/api/meetings/{number}/details").json()
    assert details["status"] == "live"
    assert details["ended_at"] is None
    assert details["started_at"] is not None

    # Ended scheduled meeting still inside its window: an attendee restarts it.
    s = schedule(client, start_in=timedelta(hours=1))
    g = join(client, s["meeting_number"], passcode=s["passcode"]).json()
    leave(client, s["meeting_number"], g["identity"])
    assert status_of(client, s["meeting_number"]) == "ended"
    res = join(client, s["meeting_number"], passcode=s["passcode"])
    assert res.status_code == 200
    assert res.json()["role"] == "attendee"
    assert status_of(client, s["meeting_number"]) == "live"

    # Ended scheduled meeting whose window is over: attendee 410, host may restart.
    now = utcnow()
    over = insert_meeting(
        db,
        status="ended",
        scheduled_start_at=now - timedelta(hours=2),
        duration_minutes=30,
        started_at=now - timedelta(hours=2),
        ended_at=now - timedelta(hours=1),
    )
    assert join(client, over.meeting_number, passcode=over.passcode).status_code == 410
    assert join(client, over.meeting_number, host_key=over.host_key).status_code == 200


class StubLiveKitAPI:
    """Replaces livekit.api.LiveKitAPI to exercise the real LiveKitService logic."""

    calls: list = []

    def __init__(self, *args, **kwargs):
        self.room = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    @staticmethod
    def _participant(identity, *tracks):
        return SimpleNamespace(identity=identity, tracks=[
            SimpleNamespace(type=t, muted=muted, sid=sid) for t, muted, sid in tracks
        ])

    def _people(self):
        audio = livekit_service.api.TrackType.AUDIO
        video = livekit_service.api.TrackType.VIDEO
        return {
            "host-1": self._participant("host-1", (audio, False, "TR_h")),
            "guest-1": self._participant("guest-1", (audio, False, "TR_a1"), (video, False, "TR_v1")),
            "guest-2": self._participant("guest-2", (audio, True, "TR_a2")),
        }

    async def list_participants(self, req):
        return SimpleNamespace(participants=list(self._people().values()))

    async def get_participant(self, req):
        return self._people()[req.identity]

    async def mute_published_track(self, req):
        self.calls.append(("mute", req.room, req.identity, req.track_sid, req.muted))

    async def update_participant(self, req):
        self.calls.append(("update", req.room, req.identity, req.metadata))


@pytest.fixture
def real_lk(monkeypatch):
    StubLiveKitAPI.calls = []
    monkeypatch.setattr(livekit_service.api, "LiveKitAPI", StubLiveKitAPI)
    return livekit_service.LiveKitService("wss://x", "k", "s")


def start_meeting(client):
    """Instant meeting with two host tabs and two guests joined."""
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host_a = join(client, number, name="Alex", host_key=m["host_key"]).json()
    host_b = join(client, number, name="Alex (tab 2)", host_key=m["host_key"]).json()
    g1 = join(client, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(client, number, name="Guest 2", passcode=m["passcode"]).json()
    return m, number, host_a, host_b, g1, g2


def room_of(db, number):
    return db.scalar(select(Meeting.id).where(Meeting.meeting_number == number))


def row(db, identity):
    db.expire_all()
    return db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == identity))


# 8
def test_mute_all(client, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client)
    url = f"/api/meetings/{number}/mute-all"

    # Not a host, wrong secret, unknown identity: 403. The old host_key body: 422.
    assert host_action(client, number, "mute-all", g1).status_code == 403
    wrong = {"identity": host_a["identity"], "participant_secret": "wrong"}
    assert client.post(url, json=wrong).status_code == 403
    assert client.post(url, json={**creds(host_a), "identity": "nobody"}).status_code == 403
    assert client.post(url, json={"host_key": m["host_key"]}).status_code == 422
    assert fake_lk.muted == set()

    res = host_action(client, number, "mute-all", host_a)
    assert res.status_code == 204 and res.content == b""
    assert fake_lk.mute_calls == [(room_of(db, number), {host_a["identity"], host_b["identity"]})]
    assert fake_lk.muted == {g1["identity"], g2["identity"]}

    # A host who left loses authority.
    leave(client, number, host_b["identity"])
    assert host_action(client, number, "mute-all", host_b).status_code == 403

    # The real LiveKitService.mute_all skips host identities and already-muted/video tracks.
    asyncio.run(real_lk.mute_all("room-1", {"host-1"}))
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]


# 9
def test_make_host(client, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client)
    room = room_of(db, number)
    g1_user_id = row(db, g1["identity"]).user_id

    # Attendees can't hand out the host role; unknown target is 404; a host target is 409.
    assert host_action(client, number, "make-host", g2, target=g1["identity"]).status_code == 403
    assert host_action(client, number, "make-host", host_a, target="nobody").status_code == 404
    assert host_action(client, number, "make-host", host_a, target=host_b["identity"]).status_code == 409

    # LiveKit failure: 502 and the database is unchanged.
    fake_lk.fail_role_update_for[g1["identity"]] = RuntimeError("livekit down")
    assert host_action(client, number, "make-host", host_a, target=g1["identity"]).status_code == 502
    assert row(db, g1["identity"]).role == "attendee"
    assert row(db, host_a["identity"]).role == "host"
    fake_lk.fail_role_update_for.clear()

    res = host_action(client, number, "make-host", host_a, target=g1["identity"])
    assert res.status_code == 204
    assert fake_lk.role_updates == [
        (room, g1["identity"], "host"),
        (room, host_a["identity"], "attendee"),
    ]
    assert row(db, g1["identity"]).role == "host"
    assert row(db, g1["identity"]).user_id == g1_user_id  # unchanged
    assert row(db, host_a["identity"]).role == "attendee"

    # Authority follows the role: the old host is refused, the new host is allowed.
    assert host_action(client, number, "mute-all", host_a).status_code == 403
    assert host_action(client, number, "mute-all", g1).status_code == 204
    assert g1["identity"] not in fake_lk.muted  # hosts are skipped
    assert host_a["identity"] in fake_lk.muted  # now an attendee

    # A participant who already left can't be made host.
    leave(client, number, g2["identity"])
    assert host_action(client, number, "make-host", g1, target=g2["identity"]).status_code == 409

    # The real service writes {"role": ...} metadata through update_participant.
    asyncio.run(real_lk.set_participant_role("room-1", "guest-1", "host"))
    assert StubLiveKitAPI.calls == [("update", "room-1", "guest-1", json.dumps({"role": "host"}))]


# 10
def test_mute_one_participant(client, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client)
    room = room_of(db, number)

    assert host_action(client, number, "mute", g1, target=g2["identity"]).status_code == 403
    assert fake_lk.muted_one == []

    assert host_action(client, number, "mute", host_a, target=g2["identity"]).status_code == 204
    assert fake_lk.muted_one == [(room, g2["identity"])]
    assert host_action(client, number, "mute", host_a, target="nobody").status_code == 404

    # Remove: a host can't be removed; unknown target is 404; an attendee can't remove.
    assert host_action(client, number, "remove", host_a, target=host_b["identity"]).status_code == 400
    assert row(db, host_b["identity"]).status == "joined"
    assert host_action(client, number, "remove", host_a, target="nobody").status_code == 404
    assert host_action(client, number, "remove", g1, target=g2["identity"]).status_code == 403
    assert host_action(client, number, "remove", host_a, target=g2["identity"]).status_code == 204
    assert row(db, g2["identity"]).status == "removed"
    assert fake_lk.removed == [(room, g2["identity"])]

    # End needs host credentials too.
    assert host_action(client, number, "end", g1).status_code == 403
    assert host_action(client, number, "end", host_b).status_code == 204
    assert status_of(client, number) == "ended"

    # The real service mutes only the unmuted audio tracks of that one participant.
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-1"))
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-2"))  # already muted
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]
