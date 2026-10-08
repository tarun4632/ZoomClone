"""Accounts, bearer tokens, who may see which meetings, and upgrading an older database."""

import hashlib

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select, text

from app.database import migrate
from app.main import app
from app.models import AuthToken, MeetingParticipant, User
from app.seed import DEFAULT_USER_EMAIL, DEMO_PASSWORD
from app.services import auth_service
from tests.conftest import sign_in


def sign_up(client, *, name="Riya Patel", email="riya@example.com", password="correct-horse"):
    return client.post("/api/auth/signup", json={"name": name, "email": email, "password": password})


def new_account(**fields) -> TestClient:
    """A separate browser, signed up and signed in."""
    other = TestClient(app)
    res = sign_up(other, **fields)
    assert res.status_code == 201, res.text
    other.headers["Authorization"] = f"Bearer {res.json()['access_token']}"
    return other


def test_sign_up_sign_in_sign_out(client, guest, db):
    res = sign_up(guest, email="  Riya@Example.com ")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["name"] == "Riya Patel"
    assert body["user"]["email"] == "riya@example.com"  # trimmed and lower-cased
    assert "password" not in body["user"] and "password_hash" not in body["user"]
    token = body["access_token"]
    assert len(token) >= 32

    # Neither the password nor the token is stored as-is.
    user = db.scalar(select(User).where(User.email == "riya@example.com"))
    assert user.password_hash.startswith("scrypt$") and "correct-horse" not in user.password_hash
    stored = db.scalar(select(AuthToken).where(AuthToken.user_id == user.id))
    assert stored.token_hash == hashlib.sha256(token.encode()).hexdigest()

    auth = {"Authorization": f"Bearer {token}"}
    assert guest.get("/api/me", headers=auth).json()["email"] == "riya@example.com"

    # Sign in again, with the email in any case. Each sign-in gets its own token.
    res = guest.post("/api/auth/login", json={"email": "RIYA@example.com", "password": "correct-horse"})
    assert res.status_code == 200
    second = res.json()["access_token"]
    assert second != token

    # Signing out revokes only the token it was called with.
    assert guest.post("/api/auth/logout", headers=auth).status_code == 204
    assert guest.get("/api/me", headers=auth).status_code == 401
    assert guest.get("/api/me", headers={"Authorization": f"Bearer {second}"}).status_code == 200
    assert guest.post("/api/auth/logout").status_code == 204  # no token: nothing to do


def test_sign_up_and_sign_in_are_validated(client, guest):
    assert sign_up(guest).status_code == 201
    res = sign_up(guest, email="RIYA@example.com")  # same address, different case
    assert res.status_code == 409
    assert res.json() == {"detail": "An account with this email already exists"}

    assert sign_up(guest, email="b@example.com", password="short").status_code == 422
    assert sign_up(guest, email="not-an-email").status_code == 422
    assert sign_up(guest, email="c@example.com", name="   ").status_code == 422

    # A wrong password and an unknown email give the same answer.
    wrong = guest.post("/api/auth/login", json={"email": "riya@example.com", "password": "nope-nope"})
    unknown = guest.post("/api/auth/login", json={"email": "nobody@example.com", "password": "nope-nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "Incorrect email or password"}


def test_dashboard_routes_need_a_valid_token(client, guest, db):
    for method, path in [
        ("get", "/api/me"),
        ("get", "/api/meetings?scope=upcoming"),
        ("get", "/api/meetings?scope=recent"),
        ("post", "/api/meetings/instant"),
        ("post", "/api/meetings"),
        ("get", "/api/meetings/12345678901/details"),
    ]:
        res = getattr(guest, method)(path)
        assert res.status_code == 401, (method, path, res.text)
        assert res.headers["www-authenticate"] == "Bearer"
        assert getattr(guest, method)(path, headers={"Authorization": "Bearer made-up"}).status_code == 401

    # An expired token stops working.
    token = client.headers["Authorization"].removeprefix("Bearer ")
    row = db.scalar(
        select(AuthToken).where(AuthToken.token_hash == hashlib.sha256(token.encode()).hexdigest())
    )
    row.expires_at = row.created_at
    db.commit()
    assert client.get("/api/me").status_code == 401

    # The public join flow treats a stale token as a guest instead of failing.
    sign_in(client, DEFAULT_USER_EMAIL, DEMO_PASSWORD)
    m = client.post("/api/meetings/instant").json()
    stale = {"Authorization": "Bearer made-up"}
    assert guest.get(f"/api/meetings/{m['meeting_number']}", headers=stale).json()["is_host"] is False
    res = guest.post(
        f"/api/meetings/{m['meeting_number']}/join",
        json={"display_name": "Late", "passcode": m["passcode"]},
        headers=stale,
    )
    assert res.status_code == 200 and res.json()["role"] == "attendee"


def test_each_account_sees_only_its_own_meetings(client, db):
    riya = new_account()

    # A new account starts empty: the demo meetings belong to the demo account.
    assert riya.get("/api/meetings", params={"scope": "upcoming"}).json() == []
    assert riya.get("/api/meetings", params={"scope": "recent"}).json() == []
    assert len(client.get("/api/meetings", params={"scope": "upcoming"}).json()) >= 3

    mine = riya.post("/api/meetings/instant").json()
    assert mine["host_name"] == "Riya Patel" and mine["is_host"] is True
    alexs = client.post("/api/meetings/instant").json()

    # The details page (passcode, invite link) is closed to other accounts: same 404 as unknown.
    assert riya.get(f"/api/meetings/{alexs['meeting_number']}/details").status_code == 404
    assert client.get(f"/api/meetings/{mine['meeting_number']}/details").status_code == 404
    assert riya.get(f"/api/meetings/{mine['meeting_number']}/details").json()["passcode"] == mine["passcode"]

    # Owning an account doesn't make you host of someone else's meeting.
    assert riya.get(f"/api/meetings/{alexs['meeting_number']}").json()["is_host"] is False
    url = f"/api/meetings/{alexs['meeting_number']}/join"
    assert riya.post(url, json={"display_name": "Riya"}).status_code == 403
    joined = riya.post(url, json={"display_name": "Riya", "passcode": alexs["passcode"]}).json()
    assert joined["role"] == "attendee"

    # A signed-in attendee's join is tied to their account, so the meeting shows up in their
    # Recent list once it ends, and its details open for them (without making them host).
    row = db.scalar(select(MeetingParticipant).where(MeetingParticipant.identity == joined["identity"]))
    assert row.user_id == riya.get("/api/me").json()["id"]
    leave = riya.post(
        f"/api/meetings/{alexs['meeting_number']}/participants/{joined['identity']}/leave",
        data={"participant_secret": joined["participant_secret"]},
    )
    assert leave.status_code == 204
    recent = riya.get("/api/meetings", params={"scope": "recent"}).json()
    assert [m["meeting_number"] for m in recent] == [alexs["meeting_number"]]
    assert recent[0]["is_host"] is False
    details = riya.get(f"/api/meetings/{alexs['meeting_number']}/details")
    assert details.status_code == 200 and details.json()["is_host"] is False


def test_password_hashing():
    stored = auth_service.hash_password("s3cret-password")
    assert stored != auth_service.hash_password("s3cret-password")  # salted
    assert auth_service.verify_password("s3cret-password", stored)
    assert not auth_service.verify_password("S3cret-password", stored)
    assert not auth_service.verify_password("s3cret-password", None)
    assert not auth_service.verify_password("s3cret-password", "not-a-hash")


def test_migrate_upgrades_a_database_from_before_accounts(tmp_path):
    """A database created by the previous version: host_key column, no invite tokens, no
    passwords. migrate() must bring it forward without losing meetings, and be safe to rerun."""
    old = create_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    with old.begin() as conn:
        conn.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,"
            " avatar_color TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ))
        conn.execute(text(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, meeting_number TEXT NOT NULL UNIQUE,"
            " host_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL,"
            " passcode TEXT NOT NULL, host_key TEXT NOT NULL)"
        ))
        conn.execute(text(
            "CREATE TABLE meeting_participants (id INTEGER PRIMARY KEY, meeting_id TEXT NOT NULL,"
            " identity TEXT NOT NULL UNIQUE)"
        ))
        conn.execute(text("INSERT INTO users (id, name, email) VALUES (1, 'Alex', 'alex@example.com')"))
        for i in (1, 2):
            conn.execute(text(
                "INSERT INTO meetings (id, meeting_number, host_id, title, passcode, host_key)"
                f" VALUES ('m{i}', '1000000000{i}', 1, 'Old {i}', 'abc12{i}', 'key{i}')"
            ))

    migrate(old)
    migrate(old)  # idempotent

    columns = lambda table: {c["name"] for c in inspect(old).get_columns(table)}
    assert "host_key" not in columns("meetings")
    assert "invite_token" in columns("meetings")
    assert "password_hash" in columns("users")
    assert "secret_hash" in columns("meeting_participants")
    with old.connect() as conn:
        rows = conn.execute(text("SELECT title, passcode, invite_token FROM meetings ORDER BY id")).all()
    assert [(r.title, r.passcode) for r in rows] == [("Old 1", "abc121"), ("Old 2", "abc122")]
    tokens = [r.invite_token for r in rows]
    assert all(t and len(t) >= 32 for t in tokens) and len(set(tokens)) == 2
    old.dispose()
