"""Backend tests for meetings: creating and listing, who may join and start, host controls,
and the rules that keep a meeting at exactly one host.

`client` is signed in as the demo user, who owns the meetings it creates. `guest` is not
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
    """`caller` decides who this is: the signed-in owner needs nothing else; anyone else
    needs a passcode or the invite link's token."""
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


def close_tab(caller, number, joined, fake_lk, db):
    """Leave as a closing tab does: the browser drops out of the LiveKit room and the leave
    request is sent, with no successor named."""
    fake_lk.rooms[room_of(db, number)].discard(joined["identity"])
    return leave(caller, number, joined)


def creds(joined):
    """Body for in-meeting actions: the caller's own identity + secret."""
    return {"identity": joined["identity"], "participant_secret": joined["participant_secret"]}


def host_action(caller, number, action, joined, target=None):
    path = f"/api/meetings/{number}/{action}" if target is None else (
        f"/api/meetings/{number}/participants/{target}/{action}"
    )
    return caller.post(path, json=creds(joined))


def sync(caller, number, joined):
    return caller.post(f"/api/meetings/{number}/sync", json=creds(joined))


def status_of(client, number):
    res = client.get(f"/api/meetings/{number}")
    assert res.status_code == 200
    return res.json()["status"]


def numbers(meetings):
    return {m["meeting_number"] for m in meetings}


def room_of(db, number):
    return db.scalar(select(Meeting.id).where(Meeting.meeting_number == number))


def row(db, identity):
    db.expire_all()
    return db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == identity))


def role(db, joined):
    return row(db, joined["identity"]).role


def hosts(db, number):
    """Identities that are host and in the meeting right now. The rule: never more than one."""
    db.expire_all()
    return list(
        db.scalars(
            select(MeetingParticipant.identity).where(
                MeetingParticipant.meeting_id == room_of(db, number),
                MeetingParticipant.role == "host",
                MeetingParticipant.status == "joined",
            )
        )
    )


def drop(db, fake_lk, number, *joined, minutes_in=5):
    """These browsers vanish (crash, network gone): LiveKit no longer lists them and no
    leave was sent. They joined `minutes_in` minutes ago, so they are not still connecting."""
    joined_at = utcnow() - timedelta(minutes=minutes_in)
    for j in joined:
        fake_lk.rooms[room_of(db, number)].discard(j["identity"])
        row(db, j["identity"]).joined_at = joined_at
        db.commit()  # per row: row() expires the session, which would drop a pending change
    # Nobody joins a meeting before it starts: move the start back with them.
    meeting = db.scalar(select(Meeting).where(Meeting.meeting_number == number))
    meeting.started_at = min(meeting.started_at, joined_at)
    db.commit()


def wait_out_host_grace(db, *joined):
    """Pretend these participants went a minute ago: past HOST_RETURN_GRACE."""
    for j in joined:
        r = row(db, j["identity"])
        assert r.left_at is not None, "this participant has not left"
        r.left_at = utcnow() - timedelta(minutes=1)
        db.commit()


def start_meeting(client, guest):
    """A live instant meeting: its owner as host, and three guests."""
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    host = join(client, number, name="Alex").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()
    g3 = join(guest, number, name="Guest 3", passcode=m["passcode"]).json()
    return m, number, host, g1, g2, g3


# ---------------------------------------------------------------- creating and listing


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
    assert m["scheduled_start_at"] is None
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


def test_unknown_meeting_returns_404(client, guest):
    assert guest.get("/api/meetings/12345678901").status_code == 404
    assert client.get("/api/meetings/12345678901/details").status_code == 404
    assert join(guest, "12345678901", passcode="abc123").status_code == 404
    assert guest.get("/api/meetings/12345678901").json() == {"detail": "Meeting not found"}


# ---------------------------------------------------------------- joining


def test_join_needs_passcode_invite_token_or_owner_account(client, guest):
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

    # The signed-in owner needs neither.
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

    # Public info: no passcode, and is_host only for the owner's own token.
    public = guest.get(f"/api/meetings/{number}").json()
    assert "passcode" not in public and "invite_url" not in public
    assert public["is_host"] is False
    assert client.get(f"/api/meetings/{number}").json()["is_host"] is True


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


def test_only_the_owner_can_start_a_scheduled_meeting(client, guest, db):
    s = schedule(client, start_in=timedelta(hours=1))
    number = s["meeting_number"]
    waiting = {"detail": "The host has not started this meeting yet"}
    assert guest.get(f"/api/meetings/{number}").json()["scheduled_start_at"] == s["scheduled_start_at"]

    # Not started: someone with the passcode or the link waits (409). Nothing starts.
    for attempt in (join(guest, number, passcode=s["passcode"]), join(guest, number, invite_token=invite_token_of(s))):
        assert attempt.status_code == 409 and attempt.json() == waiting
    assert status_of(client, number) == "scheduled"
    # A wrong passcode is still told so, rather than left waiting for ever.
    assert join(guest, number, passcode="wrong1").status_code == 403

    # The owner starts it; now others get in.
    host = join(client, number, name="Alex").json()
    assert host["role"] == "host" and status_of(client, number) == "live"
    g = join(guest, number, passcode=s["passcode"])
    assert g.status_code == 200 and g.json()["role"] == "attendee"

    # Everyone leaves: it has ended, but its time is not over. Others wait again; they
    # cannot restart it themselves. The owner can.
    leave(guest, number, g.json())
    leave(client, number, host)
    assert status_of(client, number) == "ended"
    assert join(guest, number, passcode=s["passcode"]).json() == waiting
    assert status_of(client, number) == "ended"
    assert join(client, number).json()["role"] == "host"
    assert join(guest, number, passcode=s["passcode"]).status_code == 200

    # Ended and its scheduled time is over: "ended" for others, the owner may still restart.
    now = utcnow()
    over = insert_meeting(
        db,
        status="ended",
        scheduled_start_at=now - timedelta(hours=2),
        duration_minutes=30,
        started_at=now - timedelta(hours=2),
        ended_at=now - timedelta(hours=1),
    )
    res = join(guest, over.meeting_number, passcode=over.passcode)
    assert res.status_code == 410 and res.json() == {"detail": "This meeting has ended"}
    assert join(client, over.meeting_number).status_code == 200

    # Never started and its time has passed: the owner may still start late, so others wait.
    missed = insert_meeting(db, scheduled_start_at=now - timedelta(hours=2), duration_minutes=30)
    assert join(guest, missed.meeting_number, passcode=missed.passcode).json() == waiting


def test_instant_meeting_start_and_restart_rules(client, guest, db, fake_lk):
    # Anyone with the passcode or link may open an instant meeting before its owner arrives...
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    early = join(guest, number, name="Early", passcode=m["passcode"])
    assert early.status_code == 200 and early.json()["role"] == "attendee"
    assert status_of(client, number) == "live"

    # ...but that never makes them host: the meeting has had no host to take over from, so
    # the "is anyone host?" check leaves the role for the owner.
    assert sync(guest, number, early.json()).status_code == 204
    row(db, early.json()["identity"]).joined_at = utcnow() - timedelta(minutes=10)
    db.commit()
    assert sync(guest, number, early.json()).status_code == 204
    assert hosts(db, number) == [] and fake_lk.role_updates == []
    host = join(client, number, name="Alex").json()
    assert host["role"] == "host" and hosts(db, number) == [host["identity"]]

    # Ended: only the owner can restart it.
    leave(guest, number, early.json())
    leave(client, number, host)
    assert status_of(client, number) == "ended"
    res = join(guest, number, passcode=m["passcode"])
    assert res.status_code == 410 and res.json() == {"detail": "This meeting has ended"}
    assert join(client, number).status_code == 200
    details = client.get(f"/api/meetings/{number}/details").json()
    assert details["status"] == "live"
    assert details["ended_at"] is None
    assert details["started_at"] is not None


# ---------------------------------------------------------------- leaving


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


# ---------------------------------------------------------------- host controls


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


@pytest.mark.parametrize("kind", ["instant", "scheduled"])
def test_muting_is_the_same_for_instant_and_scheduled_meetings(client, guest, fake_lk, db, kind):
    m = client.post("/api/meetings/instant").json() if kind == "instant" else schedule(client)
    number = m["meeting_number"]
    room = room_of(db, number)
    host = join(client, number, name="Alex").json()
    g1 = join(guest, number, name="Guest 1", passcode=m["passcode"]).json()
    g2 = join(guest, number, name="Guest 2", passcode=m["passcode"]).json()

    # Only the host can mute, one person or everyone.
    assert host_action(guest, number, "mute", g1, target=g2["identity"]).status_code == 403
    assert host_action(guest, number, "mute-all", g1).status_code == 403
    assert fake_lk.muted == set()

    assert host_action(client, number, "mute", host, target=g1["identity"]).status_code == 204
    assert fake_lk.muted_one == [(room, g1["identity"])]
    assert host_action(client, number, "mute-all", host).status_code == 204
    assert fake_lk.mute_calls == [(room, {host["identity"]})]  # everyone but the host
    assert fake_lk.muted == {g1["identity"], g2["identity"]}

    # Nobody can unmute anyone else: there is no such operation.
    res = client.post(f"/api/meetings/{number}/participants/{g1['identity']}/unmute", json=creds(host))
    assert res.status_code == 404


def test_mute_all(client, guest, fake_lk, db, real_lk):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    url = f"/api/meetings/{number}/mute-all"

    # Not a host, wrong secret, unknown identity: 403. No credentials at all: 422.
    assert host_action(guest, number, "mute-all", g1).status_code == 403
    wrong = {"identity": host["identity"], "participant_secret": "wrong"}
    assert guest.post(url, json=wrong).status_code == 403
    assert guest.post(url, json={**creds(host), "identity": "nobody"}).status_code == 403
    # Being signed in as the meeting's owner is not enough: authority is the participant row.
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json=creds(g1)).status_code == 403
    assert fake_lk.muted == set()

    res = host_action(client, number, "mute-all", host)
    assert res.status_code == 204 and res.content == b""
    assert fake_lk.mute_calls == [(room_of(db, number), {host["identity"]})]
    assert fake_lk.muted == {g1["identity"], g2["identity"], g3["identity"]}

    # A host who left has no authority.
    leave(client, number, host)
    assert host_action(client, number, "mute-all", host).status_code == 403

    # The real LiveKitService.mute_all skips host identities and already-muted/video tracks.
    asyncio.run(real_lk.mute_all("room-1", {"host-1"}))
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]

    # The real service reports who is connected and the role in their metadata.
    assert asyncio.run(real_lk.participant_roles("room-1")) == {
        "host-1": "host", "guest-1": None, "guest-2": None,
    }


def test_make_host(client, guest, fake_lk, db, real_lk):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)
    g1_user_id = row(db, g1["identity"]).user_id

    # Attendees can't hand out the host role; unknown target is 404; the host themself is 409.
    assert host_action(guest, number, "make-host", g2, target=g1["identity"]).status_code == 403
    assert host_action(client, number, "make-host", host, target="nobody").status_code == 404
    assert host_action(client, number, "make-host", host, target=host["identity"]).status_code == 409

    # LiveKit failure: 502 and the database is unchanged.
    fake_lk.fail_role_update_for[g1["identity"]] = RuntimeError("livekit down")
    assert host_action(client, number, "make-host", host, target=g1["identity"]).status_code == 502
    assert role(db, g1) == "attendee" and role(db, host) == "host"
    fake_lk.fail_role_update_for.clear()

    res = host_action(client, number, "make-host", host, target=g1["identity"])
    assert res.status_code == 204
    assert fake_lk.role_updates == [
        (room, g1["identity"], "host"),
        (room, host["identity"], "attendee"),
    ]
    assert hosts(db, number) == [g1["identity"]]
    assert row(db, g1["identity"]).user_id == g1_user_id  # unchanged
    assert role(db, host) == "attendee"

    # Authority follows the role: the old host is refused, the new host is allowed.
    assert host_action(client, number, "mute-all", host).status_code == 403
    assert host_action(guest, number, "mute-all", g1).status_code == 204
    assert g1["identity"] not in fake_lk.muted  # the host is skipped
    assert host["identity"] in fake_lk.muted  # now an attendee

    # A participant who already left can't be made host.
    leave(guest, number, g2)
    assert host_action(guest, number, "make-host", g1, target=g2["identity"]).status_code == 409

    # The real service writes {"role": ...} metadata through update_participant.
    asyncio.run(real_lk.set_participant_role("room-1", "guest-1", "host"))
    assert StubLiveKitAPI.calls == [("update", "room-1", "guest-1", json.dumps({"role": "host"}))]


def test_mute_one_remove_and_end(client, guest, fake_lk, db, real_lk):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)

    assert host_action(guest, number, "mute", g1, target=g2["identity"]).status_code == 403
    assert fake_lk.muted_one == []

    assert host_action(client, number, "mute", host, target=g2["identity"]).status_code == 204
    assert fake_lk.muted_one == [(room, g2["identity"])]
    assert host_action(client, number, "mute", host, target="nobody").status_code == 404

    # Remove: the host can't be removed; unknown target is 404; an attendee can't remove.
    assert host_action(client, number, "remove", host, target=host["identity"]).status_code == 400
    assert row(db, host["identity"]).status == "joined"
    assert host_action(client, number, "remove", host, target="nobody").status_code == 404
    assert host_action(guest, number, "remove", g1, target=g2["identity"]).status_code == 403
    assert host_action(client, number, "remove", host, target=g2["identity"]).status_code == 204
    assert row(db, g2["identity"]).status == "removed"
    assert fake_lk.removed == [(room, g2["identity"])]

    # End needs host credentials too.
    assert host_action(guest, number, "end", g1).status_code == 403

    # LiveKit can't delete the room: 502, and the meeting is not marked ended while people
    # are still connected.
    fake_lk.fail_end_room = RuntimeError("livekit down")
    assert host_action(client, number, "end", host).status_code == 502
    assert status_of(client, number) == "live"
    assert row(db, g1["identity"]).status == "joined"
    fake_lk.fail_end_room = None

    assert host_action(client, number, "end", host).status_code == 204
    assert status_of(client, number) == "ended"
    assert fake_lk.ended_rooms == [room]

    # The real service mutes only the unmuted audio tracks of that one participant.
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-1"))
    asyncio.run(real_lk.mute_participant_audio("room-1", "guest-2"))  # already muted
    assert StubLiveKitAPI.calls == [("mute", "room-1", "guest-1", "TR_a1", True)]


# ---------------------------------------------------------------- one host at a time


def test_host_assigns_a_successor_and_does_not_get_the_role_back(client, guest, fake_lk, db):
    """What the "Assign a new host" box does: Make Host, then leave."""
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)

    assert host_action(client, number, "make-host", host, target=g2["identity"]).status_code == 204
    assert leave(client, number, host).status_code == 204
    assert hosts(db, number) == [g2["identity"]]
    assert status_of(client, number) == "live"

    # The owner comes back: the role has passed on, so they are an attendee like anyone.
    # They still need no passcode: it is their meeting.
    back = join(client, number, name="Alex (back)")
    assert back.status_code == 200 and back.json()["role"] == "attendee"
    assert hosts(db, number) == [g2["identity"]]
    assert host_action(client, number, "mute-all", back.json()).status_code == 403
    assert host_action(client, number, "end", back.json()).status_code == 403
    assert host_action(guest, number, "mute-all", g2).status_code == 204

    # Nothing the returning owner's client asks for changes that.
    assert sync(client, number, back.json()).status_code == 204
    assert hosts(db, number) == [g2["identity"]]

    # The new host can hand the role back if they choose.
    assert host_action(guest, number, "make-host", g2, target=back.json()["identity"]).status_code == 204
    assert hosts(db, number) == [back.json()["identity"]]
    assert fake_lk.role_updates[-2:] == [
        (room, back.json()["identity"], "host"),
        (room, g2["identity"], "attendee"),
    ]


def test_host_who_closes_the_tab_is_replaced_after_a_grace(client, guest, fake_lk, db):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)

    # No goodbye, no successor named (tab closed, page refreshed). Nobody is promoted yet:
    # the host may be on their way back.
    assert close_tab(client, number, host, fake_lk, db).status_code == 204
    assert sync(guest, number, g1).status_code == 204
    assert hosts(db, number) == [] and fake_lk.role_updates == []
    assert status_of(client, number) == "live"

    # They are: back within the grace, and host again.
    back = join(client, number, name="Alex").json()
    assert back["role"] == "host" and hosts(db, number) == [back["identity"]]

    # This time they stay away. Once the grace is over the system picks: Guest 1 has been
    # here longest but their browser is gone from the LiveKit room, so it is Guest 2.
    close_tab(client, number, back, fake_lk, db)
    wait_out_host_grace(db, host, back)  # both of the owner's sessions ended over a minute ago
    fake_lk.rooms[room].discard(g1["identity"])
    assert sync(guest, number, g2).status_code == 204
    assert hosts(db, number) == [g2["identity"]]
    assert fake_lk.role_updates == [(room, g2["identity"], "host")]

    # Everyone's client asks at about the same time: still exactly one host.
    assert sync(guest, number, g3).status_code == 204
    assert hosts(db, number) == [g2["identity"]]
    assert fake_lk.role_updates == [(room, g2["identity"], "host")]

    # Too late for the owner now: they come back as an attendee.
    late = join(client, number, name="Alex (late)").json()
    assert late["role"] == "attendee" and hosts(db, number) == [g2["identity"]]

    # If the system has to pick again and the owner is in the call, it picks the owner.
    close_tab(guest, number, g2, fake_lk, db)
    wait_out_host_grace(db, g2)
    assert sync(guest, number, g3).status_code == 204
    assert hosts(db, number) == [late["identity"]]


def test_owner_in_a_second_tab_takes_the_role_from_the_first(client, guest, fake_lk, db):
    m = client.post("/api/meetings/instant").json()
    number = m["meeting_number"]
    room = room_of(db, number)
    tab1 = join(client, number, name="Alex").json()
    g = join(guest, number, passcode=m["passcode"]).json()

    # Same account again while the first session still holds the role (a second tab, or
    # the first tab died and its leave never arrived): the new session is the host.
    tab2 = join(client, number, name="Alex (tab 2)").json()
    assert tab2["role"] == "host"
    assert hosts(db, number) == [tab2["identity"]]
    assert role(db, tab1) == "attendee"
    assert fake_lk.role_updates == [(room, tab1["identity"], "attendee")]
    assert host_action(client, number, "mute-all", tab1).status_code == 403
    assert host_action(client, number, "mute-all", tab2).status_code == 204
    assert role(db, g) == "attendee"


def test_host_who_vanishes_without_leaving_is_replaced(client, guest, fake_lk, db):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)

    # Nobody dropped: the check changes nothing.
    assert sync(guest, number, g2).status_code == 204
    assert hosts(db, number) == [host["identity"]] and fake_lk.role_updates == []

    # The host's browser crashes. A guest still in the call asks for the check: the host is
    # written off, and the grace for their return starts.
    drop(db, fake_lk, number, host)
    assert sync(guest, number, g2).status_code == 204
    assert row(db, host["identity"]).status == "left"
    assert hosts(db, number) == [] and fake_lk.role_updates == []

    # Still gone after the grace: the longest-present connected participant takes over.
    wait_out_host_grace(db, host)
    assert sync(guest, number, g2).status_code == 204
    assert hosts(db, number) == [g1["identity"]]
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]
    assert host_action(client, number, "mute-all", host).status_code == 403
    assert host_action(guest, number, "mute-all", g1).status_code == 204

    # The old host's connection recovers after all (same identity back in the room). They
    # are back in the meeting, but the role has moved on: one host, and LiveKit is told.
    fake_lk.rooms[room].add(host["identity"])
    assert sync(client, number, host).status_code == 204
    back = row(db, host["identity"])
    assert (back.status, back.role, back.left_at) == ("joined", "attendee", None)
    assert fake_lk.role_updates[-1] == (room, host["identity"], "attendee")
    assert hosts(db, number) == [g1["identity"]]

    # A label that is out of step with the database (an update LiveKit missed) is repaired
    # by the next check, without changing who the host is.
    fake_lk.roles[g1["identity"]] = "attendee"
    assert sync(guest, number, g2).status_code == 204
    assert fake_lk.role_updates[-1] == (room, g1["identity"], "host")
    assert hosts(db, number) == [g1["identity"]]


def test_host_whose_connection_recovers_in_time_keeps_the_role(client, guest, fake_lk, db):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)

    drop(db, fake_lk, number, host)
    assert sync(guest, number, g1).status_code == 204
    assert row(db, host["identity"]).status == "left" and hosts(db, number) == []

    # Back before anyone was promoted: still the host, nothing to tell LiveKit.
    fake_lk.rooms[room].add(host["identity"])
    assert sync(client, number, host).status_code == 204
    assert hosts(db, number) == [host["identity"]]
    assert fake_lk.role_updates == []


def test_sync_is_careful_about_who_it_writes_off(client, guest, fake_lk, db):
    m, number, host, g1, g2, g3 = start_meeting(client, guest)
    room = room_of(db, number)
    url = f"/api/meetings/{number}/sync"

    # It needs the caller's own secret.
    assert guest.post(url, json={"identity": g1["identity"], "participant_secret": "wrong"}).status_code == 403
    assert guest.post(url, json={"identity": "nobody", "participant_secret": "x"}).status_code == 404

    # Someone who joined a moment ago but is not in the LiveKit room yet is still connecting.
    fake_lk.rooms[room].discard(host["identity"])
    assert sync(guest, number, g1).status_code == 204
    assert row(db, host["identity"]).status == "joined" and role(db, host) == "host"

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
    fake_lk.rooms[room].add(host["identity"])
    assert host_action(client, number, "remove", host, target=g3["identity"]).status_code == 204
    fake_lk.rooms[room].add(g3["identity"])
    fake_lk.rooms[room].discard(host["identity"])

    # Now a connected guest asks. The host and Guest 2 are written off.
    assert sync(guest, number, g1).status_code == 204
    assert row(db, host["identity"]).status == "left"
    assert row(db, g2["identity"]).status == "left"
    assert row(db, g3["identity"]).status == "removed"
    assert hosts(db, number) == []  # the grace for the host's return has only just begun

    wait_out_host_grace(db, host)
    assert sync(guest, number, g1).status_code == 204
    assert hosts(db, number) == [g1["identity"]]
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]

    # A non-host dropping never moves the host role.
    g4 = join(guest, number, name="Guest 4", passcode=m["passcode"]).json()
    drop(db, fake_lk, number, g4)
    assert sync(guest, number, g1).status_code == 204
    assert row(db, g4["identity"]).status == "left"
    assert hosts(db, number) == [g1["identity"]]
    assert fake_lk.role_updates == [(room, g1["identity"], "host")]

