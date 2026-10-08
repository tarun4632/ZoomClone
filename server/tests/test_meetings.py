"""Backend tests for meetings: the 10 from PLAN.MD section 4, plus leave authorization and
host succession (11, 12).

`client` is signed in as the demo user, who hosts the meetings it creates. `guest` is not
signed in. LiveKit is replaced by FakeLiveKit; the real LiveKitService runs against a
stubbed client.
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


def join(caller, number, *, name="Guest", passcode=None, invite_token=None):
    """`caller` decides the role: the signed-in host needs nothing else; a guest needs a
    passcode or the invite link's token."""
    body = {"display_name": name}
    if passcode is not None:
        body["passcode"] = passcode
    if invite_token is not None:
        body["invite_token"] = invite_token
    return caller.post(f"/api/meetings/{number}/join", json=body)


def invite_token_of(meeting):
    """The ?pwd= value of the invite link."""
    return meeting["invite_url"].split("?pwd=")[1]


def leave(caller, number, joined, *, secret=None):
    # Form-encoded, exactly like navigator.sendBeacon(url, new URLSearchParams({...})).
    secret = joined["participant_secret"] if secret is None else secret
    return caller.post(
        f"/api/meetings/{number}/participants/{joined['identity']}/leave",
        data={"participant_secret": secret},
    )


def creds(joined):
    """Body for in-meeting host actions: the caller's own identity + secret."""
    return {"identity": joined["identity"], "participant_secret": joined["participant_secret"]}


def host_action(caller, number, action, joined, target=None):
    path = f"/api/meetings/{number}/{action}" if target is None else (
        f"/api/meetings/{number}/participants/{target}/{action}"
    )
    return caller.post(path, json=creds(joined))


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
    assert "host_key" not in m
    assert m["is_host"] is True
    assert m["title"] == "Alex Johnson's Zoom Meeting"
    assert m["meeting_type"] == "instant"
    assert m["status"] == "scheduled"
    assert m["host_name"] == "Alex Johnson"
    assert ISO_UTC.match(m["created_at"])
    assert len(numbers(bodies)) == 5

    # The invite link carries a random token, never the passcode.
    prefix = f"http://localhost:3000/j/{m['meeting_number']}?pwd="
    assert m["invite_url"].startswith(prefix)
    token = invite_token_of(m)
    assert len(token) >= 32
    assert m["passcode"] not in m["invite_url"]
    assert len({invite_token_of(b) for b in bodies}) == 5

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
    j = join(client, early["meeting_number"]).json()
    assert leave(client, early["meeting_number"], j).status_code == 204
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
    assert all(m["is_host"] for m in upcoming)

    assert status_of(client, stale.meeting_number) == "ended"
    recent = client.get("/api/meetings", params={"scope": "recent"}).json()
    assert stale.meeting_number in numbers(recent)


# 3
def test_unknown_meeting_returns_404(client, guest):
    assert guest.get("/api/meetings/12345678901").status_code == 404
    assert client.get("/api/meetings/12345678901/details").status_code == 404
    assert join(guest, "12345678901", passcode="abc123").status_code == 404
    assert guest.get("/api/meetings/12345678901").json() == {"detail": "Meeting not found"}


# 4
def test_join_needs_passcode_invite_token_or_host_account(client, guest):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]

    # A guest needs the passcode or the invite link's token. Neither can stand in for the other.
    assert join(guest, number, passcode="wrong1").status_code == 403
    assert join(guest, number).status_code == 403  # nothing at all
    assert join(guest, number, invite_token="not-the-token").status_code == 403
    assert join(guest, number, invite_token=m["passcode"]).status_code == 403
    assert join(guest, number, passcode=invite_token_of(m)).status_code == 403

    by_passcode = join(guest, number, passcode=m["passcode"])
    by_link = join(guest, number, invite_token=invite_token_of(m))
    assert by_passcode.status_code == 200 and by_link.status_code == 200
    assert by_passcode.json()["role"] == by_link.json()["role"] == "attendee"

    # The signed-in host needs neither.
    res = join(client, number, name="Alex")
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

    # Public info: no passcode, and is_host only for the host's own token.
    public = guest.get(f"/api/meetings/{number}").json()
    assert "passcode" not in public and "invite_url" not in public
    assert public["is_host"] is False
    assert client.get(f"/api/meetings/{number}").json()["is_host"] is True


# 5
def test_join_roles_and_user_id(client, guest, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]

    host = join(client, number, name="Alex").json()
    visitor = join(guest, number, name="Guest", passcode=m["passcode"]).json()
    assert host["role"] == "host"
    assert visitor["role"] == "attendee"

    rows = {
        p.identity: p
        for p in db.scalars(select(MeetingParticipant).where(MeetingParticipant.identity.in_(
            [host["identity"], visitor["identity"]]
        )))
    }
    me = client.get("/api/me").json()
    assert rows[host["identity"]].role == "host"
    assert rows[host["identity"]].user_id == me["id"]
    assert rows[visitor["identity"]].role == "attendee"
    assert rows[visitor["identity"]].user_id is None
    assert all(r.status == "joined" for r in rows.values())
    assert status_of(client, number) == "live"

    # Only the SHA-256 of the participant secret is stored.
    for joined in (host, visitor):
        stored = rows[joined["identity"]].secret_hash
        assert stored == hashlib.sha256(joined["participant_secret"].encode()).hexdigest()
        assert stored != joined["participant_secret"]


# 6
def test_last_leave_ends_meeting_and_leave_is_idempotent(client, guest, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, name="Alex").json()
    visitor = join(guest, number, name="Guest", passcode=m["passcode"]).json()

    assert leave(guest, number, visitor).status_code == 204
    assert status_of(client, number) == "live"

    res = leave(client, number, host)
    assert res.status_code == 204 and res.content == b""
    assert status_of(client, number) == "ended"

    recent = client.get("/api/meetings", params={"scope": "recent"}).json()
    assert number in numbers(recent)

    meeting = db.scalar(select(Meeting).where(Meeting.meeting_number == number))
    host_row = db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == host["identity"]))
    ended_at, left_at = meeting.ended_at, host_row.left_at

    # Second call: 204, nothing changes.
    assert leave(client, number, host).status_code == 204
    db.expire_all()
    assert meeting.status == "ended" and meeting.ended_at == ended_at
    assert host_row.status == "left" and host_row.left_at == left_at

    # The identity must belong to that meeting number.
    other = client.post("/api/meetings/instant").json()
    assert leave(client, other["meeting_number"], host).status_code == 404
    unknown = {"identity": "no-such-identity", "participant_secret": "x"}
    assert leave(client, number, unknown).status_code == 404

    # A removed participant's leave never overwrites 'removed'.
    m2 = client.post("/api/meetings/instant").json()
    h2 = join(client, m2["meeting_number"]).json()
    g2 = join(guest, m2["meeting_number"], passcode=m2["passcode"]).json()
    res = host_action(client, m2["meeting_number"], "remove", h2, target=g2["identity"])
    assert res.status_code == 204
    assert leave(guest, m2["meeting_number"], g2).status_code == 204
    g2_row = db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == g2["identity"]))
    assert g2_row.status == "removed"
    assert status_of(client, m2["meeting_number"]) == "live"  # host still there
    assert h2["role"] == "host"


# 7
def test_restart_rules(client, guest, db):
    # Ended instant meeting: attendee gets 410, host restarts it.
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number).json()
    leave(client, number, host)
    assert status_of(client, number) == "ended"

    res = join(guest, number, passcode=m["passcode"])
    assert res.status_code == 410
    assert res.json() == {"detail": "This meeting has ended"}

    assert join(client, number).status_code == 200
    details = client.get(f"/api/meetings/{number}/details").json()
    assert details["status"] == "live"
    assert details["ended_at"] is None
    assert details["started_at"] is not None

    # Ended scheduled meeting still inside its window: an attendee restarts it.
    s = schedule(client, start_in=timedelta(hours=1))
    g = join(guest, s["meeting_number"], passcode=s["passcode"]).json()
    leave(guest, s["meeting_number"], g)
    assert status_of(client, s["meeting_number"]) == "ended"
    res = join(guest, s["meeting_number"], passcode=s["passcode"])
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
    assert join(guest, over.meeting_number, passcode=over.passcode).status_code == 410
    assert join(client, over.meeting_number).status_code == 200


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
        people = self._people()
        for identity, metadata in [("host-1", '{"role": "host"}'), ("guest-1", "not json"), ("guest-2", "")]:
            people[identity].metadata = metadata
        return SimpleNamespace(participants=list(people.values()))

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


def start_meeting(client, guest):
    """Instant meeting with two host tabs and two guests joined."""
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host_a = join(client, number, name="Alex").json()
    host_b = join(client, number, name="Alex (tab 2)").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()
    return m, number, host_a, host_b, g1, g2


def room_of(db, number):
    return db.scalar(select(Meeting.id).where(Meeting.meeting_number == number))


def row(db, identity):
    db.expire_all()
    return db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == identity))


# 8
def test_mute_all(client, guest, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client, guest)
    url = f"/api/meetings/{number}/mute-all"

    # Not a host, wrong secret, unknown identity: 403. No credentials at all: 422.
    assert host_action(guest, number, "mute-all", g1).status_code == 403
    wrong = {"identity": host_a["identity"], "participant_secret": "wrong"}
    assert guest.post(url, json=wrong).status_code == 403
    assert guest.post(url, json={**creds(host_a), "identity": "nobody"}).status_code == 403
    # Being signed in as the meeting's owner is not enough: authority is the participant row.
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json=creds(g1)).status_code == 403
    assert fake_lk.muted == set()

    res = host_action(client, number, "mute-all", host_a)
    assert res.status_code == 204 and res.content == b""
    assert fake_lk.mute_calls == [(room_of(db, number), {host_a["identity"], host_b["identity"]})]
    assert fake_lk.muted == {g1["identity"], g2["identity"]}

    # A host who left loses authority.
    leave(client, number, host_b)
    assert host_action(client, number, "mute-all", host_b).status_code == 403

    # The real LiveKitService.mute_all skips host identities and already-muted/video tracks.
    asyncio.run(real_lk.mute_all("room-1", {"host-1"}))
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]

    # The real service lists who is connected (used to pick a successor host).
    assert asyncio.run(real_lk.participant_identities("room-1")) == {"host-1", "guest-1", "guest-2"}
    assert asyncio.run(real_lk.participant_roles("room-1")) == {
        "host-1": "host", "guest-1": None, "guest-2": None,
    }


# 9
def test_make_host(client, guest, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client, guest)
    room = room_of(db, number)
    g1_user_id = row(db, g1["identity"]).user_id

    # Attendees can't hand out the host role; unknown target is 404; a host target is 409.
    assert host_action(guest, number, "make-host", g2, target=g1["identity"]).status_code == 403
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
    assert host_action(guest, number, "mute-all", g1).status_code == 204
    assert g1["identity"] not in fake_lk.muted  # hosts are skipped
    assert host_a["identity"] in fake_lk.muted  # now an attendee

    # A participant who already left can't be made host.
    leave(guest, number, g2)
    assert host_action(guest, number, "make-host", g1, target=g2["identity"]).status_code == 409

    # The real service writes {"role": ...} metadata through update_participant.
    asyncio.run(real_lk.set_participant_role("room-1", "guest-1", "host"))
    assert StubLiveKitAPI.calls == [("update", "room-1", "guest-1", json.dumps({"role": "host"}))]


# 10
def test_mute_one_participant(client, guest, fake_lk, db, real_lk):
    m, number, host_a, host_b, g1, g2 = start_meeting(client, guest)
    room = room_of(db, number)

    assert host_action(guest, number, "mute", g1, target=g2["identity"]).status_code == 403
    assert fake_lk.muted_one == []

    assert host_action(client, number, "mute", host_a, target=g2["identity"]).status_code == 204
    assert fake_lk.muted_one == [(room, g2["identity"])]
    assert host_action(client, number, "mute", host_a, target="nobody").status_code == 404

    # Remove: a host can't be removed; unknown target is 404; an attendee can't remove.
    assert host_action(client, number, "remove", host_a, target=host_b["identity"]).status_code == 400
    assert row(db, host_b["identity"]).status == "joined"
    assert host_action(client, number, "remove", host_a, target="nobody").status_code == 404
    assert host_action(guest, number, "remove", g1, target=g2["identity"]).status_code == 403
    assert host_action(client, number, "remove", host_a, target=g2["identity"]).status_code == 204
    assert row(db, g2["identity"]).status == "removed"
    assert fake_lk.removed == [(room, g2["identity"])]

    # End needs host credentials too.
    assert host_action(guest, number, "end", g1).status_code == 403

    # LiveKit can't delete the room: 502, and the meeting is not marked ended while people
    # are still connected.
    fake_lk.fail_end_room = RuntimeError("livekit down")
    assert host_action(client, number, "end", host_b).status_code == 502
    assert status_of(client, number) == "live"
    assert row(db, g1["identity"]).status == "joined"
    fake_lk.fail_end_room = None

    assert host_action(client, number, "end", host_b).status_code == 204
    assert status_of(client, number) == "ended"
    assert fake_lk.ended_rooms == [room]

    # The real service mutes only the unmuted audio tracks of that one participant.
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-1"))
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-2"))  # already muted
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]


# 11
def test_leave_needs_the_participants_own_secret(client, guest, fake_lk, db):
    """Identities are visible to everyone in the room, so they must not be enough to make
    someone else "leave": that would strip a host of their role and end the meeting."""
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, name="Alex").json()
    visitor = join(guest, number, passcode=m["passcode"]).json()
    url = f"/api/meetings/{number}/participants/{host['identity']}/leave"

    assert guest.post(url).status_code == 403  # no body, as the endpoint used to accept
    assert leave(guest, number, host, secret="wrong").status_code == 403
    assert leave(guest, number, host, secret=visitor["participant_secret"]).status_code == 403
    # JSON is not the format: the secret is not picked up from it.
    assert guest.post(url, json={"participant_secret": host["participant_secret"]}).status_code == 403

    # Nothing changed: the host is still in the meeting and still the host.
    assert row(db, host["identity"]).status == "joined"
    assert host_action(client, number, "mute-all", host).status_code == 204
    assert status_of(client, number) == "live"
    assert fake_lk.role_updates == []

    # With their own secret, anyone may leave, signed in or not.
    assert leave(guest, number, visitor).status_code == 204
    assert row(db, visitor["identity"]).status == "left"


# 12
def test_last_host_leaving_hands_the_role_on(client, guest, fake_lk, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    room = room_of(db, number)
    host_a = join(client, number, name="Alex").json()
    host_b = join(client, number, name="Alex (tab 2)").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()
    g3 = join(guest, number, name="Guest 3", passcode=m["passcode"]).json()

    # Another host remains: nobody is promoted.
    assert leave(client, number, host_a).status_code == 204
    assert fake_lk.role_updates == []
    assert [row(db, g["identity"]).role for g in (g1, g2, g3)] == ["attendee"] * 3

    # An attendee leaving never promotes anyone either.
    assert leave(guest, number, g3).status_code == 204
    assert fake_lk.role_updates == []

    # The last host leaves. Guest 1 has been here longest but their browser is gone from the
    # LiveKit room (crashed without a leave), so Guest 2, who is connected, becomes host.
    fake_lk.rooms[room].discard(g1["identity"])
    assert leave(client, number, host_b).status_code == 204
    assert row(db, g2["identity"]).role == "host"
    assert row(db, g1["identity"]).role == "attendee"
    assert fake_lk.role_updates == [(room, g2["identity"], "host")]
    assert status_of(client, number) == "live"

    # The new host really has the host's authority; the old one has none.
    assert host_action(client, number, "mute-all", host_b).status_code == 403
    assert host_action(guest, number, "mute-all", g2).status_code == 204
    assert host_action(guest, number, "end", g2).status_code == 204
    assert status_of(client, number) == "ended"


def test_host_succession_survives_livekit_being_down(client, guest, fake_lk, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, name="Alex").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()

    # LiveKit can't say who is connected and can't take the metadata update. Leaving still
    # works, and the longest-present participant is host in the database.
    fake_lk.fail_list_participants = RuntimeError("livekit down")
    fake_lk.fail_role_update_for[g1["identity"]] = RuntimeError("livekit down")
    assert leave(client, number, host).status_code == 204
    assert row(db, host["identity"]).status == "left"
    assert row(db, g1["identity"]).role == "host"
    assert row(db, g2["identity"]).role == "attendee"
    assert host_action(guest, number, "mute-all", g1).status_code == 204


def sync(caller, number, joined):
    return caller.post(f"/api/meetings/{number}/sync", json=creds(joined))


def drop(db, fake_lk, number, *joined, minutes_in=5):
    """These browsers vanish (crash, network gone): LiveKit no longer lists them and no
    leave was sent. They joined `minutes_in` minutes ago, so they are not still connecting."""
    for j in joined:
        fake_lk.rooms[room_of(db, number)].discard(j["identity"])
        row(db, j["identity"]).joined_at = utcnow() - timedelta(minutes=minutes_in)
        db.commit()  # per row: row() expires the session, which would drop a pending change


# 13
def test_host_who_vanishes_without_leaving_is_replaced(client, guest, fake_lk, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    room = room_of(db, number)
    host = join(client, number, name="Alex").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()

    # Nobody dropped: the check changes nothing.
    assert sync(guest, number, g2).status_code == 204
    assert row(db, host["identity"]).status == "joined" and row(db, host["identity"]).role == "host"
    assert fake_lk.role_updates == []

    # The host's browser crashes. A guest still in the call asks for the check.
    drop(db, fake_lk, number, host)
    assert sync(guest, number, g2).status_code == 204
    old = row(db, host["identity"])
    assert (old.status, old.role) == ("left", "attendee") and old.left_at is not None
    assert row(db, g1["identity"]).role == "host"  # longest-present of those connected
    assert row(db, g2["identity"]).role == "attendee"
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]
    assert status_of(client, number) == "live"

    # Everyone's client asks at once: the second check finds a host and changes nothing.
    assert sync(guest, number, g1).status_code == 204
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]

    # Authority moved with the role.
    assert host_action(client, number, "mute-all", host).status_code == 403
    assert host_action(guest, number, "mute-all", g1).status_code == 204

    # The old host's connection recovers after all (same identity back in the room). They
    # are back in the meeting as an attendee, and LiveKit is told so.
    fake_lk.rooms[room].add(host["identity"])
    assert sync(client, number, host).status_code == 204
    back = row(db, host["identity"])
    assert (back.status, back.role, back.left_at) == ("joined", "attendee", None)
    assert fake_lk.role_updates[-1] == (room, host["identity"], "attendee")
    assert row(db, g1["identity"]).role == "host"

    # A label that is out of step with the database (an update LiveKit missed) is repaired
    # by the next check, without changing who the host is.
    fake_lk.roles[g1["identity"]] = "attendee"
    assert sync(guest, number, g2).status_code == 204
    assert fake_lk.role_updates[-1] == (room, g1["identity"], "host")
    assert row(db, g1["identity"]).role == "host" and row(db, g2["identity"]).role == "attendee"


def test_sync_is_careful_about_who_it_writes_off(client, guest, fake_lk, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    room = room_of(db, number)
    host = join(client, number, name="Alex").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()
    url = f"/api/meetings/{number}/sync"

    # It needs the caller's own secret.
    assert guest.post(url, json={"identity": g1["identity"], "participant_secret": "wrong"}).status_code == 403
    assert guest.post(url, json={"identity": "nobody", "participant_secret": "x"}).status_code == 404

    # Someone who joined a moment ago but is not in the LiveKit room yet is still connecting.
    fake_lk.rooms[room].discard(host["identity"])
    assert sync(guest, number, g1).status_code == 204
    assert row(db, host["identity"]).status == "joined" and row(db, host["identity"]).role == "host"

    # A caller who is not connected themselves is not trusted to trigger anything.
    drop(db, fake_lk, number, host, g2)
    assert sync(guest, number, g2).status_code == 204
    assert row(db, host["identity"]).status == "joined"

    # LiveKit is down: 502 and nothing changes.
    fake_lk.fail_list_participants = RuntimeError("livekit down")
    assert sync(guest, number, g1).status_code == 502
    assert row(db, host["identity"]).status == "joined"
    fake_lk.fail_list_participants = None

    # A removed participant is never brought back, even if LiveKit still lists them.
    g3 = join(guest, number, name="Guest 3", passcode=m["passcode"]).json()
    fake_lk.rooms[room].add(host["identity"])
    assert host_action(client, number, "remove", host, target=g3["identity"]).status_code == 204
    fake_lk.rooms[room].add(g3["identity"])
    fake_lk.rooms[room].discard(host["identity"])

    # Now a connected guest asks. Host and Guest 2 are written off, Guest 1 takes over.
    assert sync(guest, number, g1).status_code == 204
    assert row(db, host["identity"]).status == "left"
    assert row(db, g2["identity"]).status == "left"
    assert row(db, g3["identity"]).status == "removed"
    assert row(db, g1["identity"]).role == "host"
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]

    # A non-host dropping never moves the host role.
    g4 = join(guest, number, name="Guest 4", passcode=m["passcode"]).json()
    drop(db, fake_lk, number, g4)
    assert sync(guest, number, g1).status_code == 204
    assert row(db, g4["identity"]).status == "left"
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]
