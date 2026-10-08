"""Accounts and bearer tokens: sign up, sign in, sign out, token lookup.

Passwords are hashed with scrypt (standard library, salted, memory-hard). Bearer tokens are
random and stored only as SHA-256 hashes, like participant secrets: a database leak exposes
neither passwords nor usable tokens, and signing out really revokes the token.
"""

import base64
import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import AuthToken, User
from ..schemas import LoginInput, SignupInput
from .ids import generate_auth_token, hash_secret

TOKEN_TTL = timedelta(days=30)

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_KEY_LENGTH = 32

AVATAR_COLORS = ["#0B5CFF", "#FF742E", "#12A150", "#8E44EC", "#E0338F", "#00A3BF"]


# ---------- passwords ----------


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=length)


def hash_password(password: str) -> str:
    """ "scrypt$n$r$p$salt$hash" with base64 salt and hash; the parameters travel with the hash."""
    salt = secrets.token_bytes(16)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_LENGTH)
    encode = lambda raw: base64.b64encode(raw).decode()
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${encode(salt)}${encode(digest)}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p), len(expected))
    except ValueError:
        return False
    return secrets.compare_digest(actual, expected)


# Checked when the email is unknown, so "no such account" takes as long as "wrong password".
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


# ---------- accounts ----------


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))


def signup(db: Session, data: SignupInput) -> User:
    if get_user_by_email(db, data.email) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    user = User(
        name=data.name,
        email=data.email,
        avatar_color=secrets.choice(AVATAR_COLORS),
        password_hash=hash_password(data.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:  # two sign-ups with the same email at once
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "An account with this email already exists"
        ) from exc
    return user


def login(db: Session, data: LoginInput) -> User:
    """Same 401 for an unknown email and a wrong password, so neither can be told apart."""
    user = get_user_by_email(db, data.email)
    if not verify_password(data.password, user.password_hash if user else _DUMMY_HASH) or not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    return user


# ---------- tokens ----------


def issue_token(db: Session, user: User, now: datetime) -> str:
    """Create a bearer token for `user`. Also drops that user's expired tokens."""
    db.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.expires_at <= now))
    token = generate_auth_token()
    db.add(AuthToken(user_id=user.id, token_hash=hash_secret(token), expires_at=now + TOKEN_TTL))
    db.commit()
    return token


def user_for_token(db: Session, token: str, now: datetime) -> User | None:
    row = db.scalar(select(AuthToken).where(AuthToken.token_hash == hash_secret(token)))
    if row is None or row.expires_at <= now:
        return None
    return row.user


def revoke_token(db: Session, token: str) -> None:
    db.execute(delete(AuthToken).where(AuthToken.token_hash == hash_secret(token)))
    db.commit()
