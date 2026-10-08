"""The 8 backend tests from PLAN.MD section 4. LiveKit is replaced by FakeLiveKit."""

import asyncio
import re
from datetime import timedelta
from types import SimpleNamespace

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
    res = client.post(
        f"/api/meetings/{m2['meeting_number']}/participants/{g2['identity']}/remove",
        json={"host_key": m2["host_key"]},
    )
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


# 8
def test_mute_all(client, fake_lk, db, monkeypatch):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host_a = join(client, number, name="Alex", host_key=m["host_key"]).json()
    host_b = join(client, number, name="Alex (tab 2)", host_key=m["host_key"]).json()
    g1 = join(client, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(client, number, name="Guest 2", passcode=m["passcode"]).json()

    url = f"/api/meetings/{number}/mute-all"
    assert client.post(url, json={"host_key": "wrong"}).status_code == 403
    assert client.post(url, json={}).status_code == 422
    assert fake_lk.muted == set()

    res = client.post(url, json={"host_key": m["host_key"]})
    assert res.status_code == 204
    room = db.scalar(select(Meeting.id).where(Meeting.meeting_number == number))
    assert fake_lk.mute_calls == [(room, {host_a["identity"], host_b["identity"]})]
    assert fake_lk.muted == {g1["identity"], g2["identity"]}

    # The real LiveKitService.mute_all skips host identities and already-muted/video tracks.
    calls: list = []

    class StubRoom:
        async def list_participants(self, req):
            assert req.room == "room-1"
            audio = livekit_service.api.TrackType.AUDIO
            video = livekit_service.api.TrackType.VIDEO

            def p(identity, *tracks):
                return SimpleNamespace(identity=identity, tracks=[
                    SimpleNamespace(type=t, muted=muted, sid=sid) for t, muted, sid in tracks
                ])

            return SimpleNamespace(participants=[
                p("host-1", (audio, False, "TR_h")),
                p("guest-1", (audio, False, "TR_a1"), (video, False, "TR_v1")),
                p("guest-2", (audio, True, "TR_a2")),
            ])

        async def mute_published_track(self, req):
            calls.append((req.identity, req.track_sid, req.muted))

    class StubAPI:
        def __init__(self, *args, **kwargs):
            self.room = StubRoom()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    real = livekit_service.LiveKitService("wss://x", "k", "s")
    monkeypatch.setattr(livekit_service.api, "LiveKitAPI", StubAPI)
    asyncio.run(real.mute_all("room-1", {"host-1"}))
    assert calls == [("guest-1", "TR_a1", True)]
