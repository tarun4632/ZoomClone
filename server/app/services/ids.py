import hashlib
import secrets
import string


def generate_meeting_number() -> str:
    # 11 digits, never starting with 0. If the UNIQUE constraint fails,
    # the caller rolls back the session and retries.
    return secrets.choice("123456789") + "".join(secrets.choice(string.digits) for _ in range(10))


def generate_passcode() -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(6))


def generate_invite_token() -> str:
    """The ?pwd= value of the invite link. Random, so it reveals nothing about the passcode."""
    return secrets.token_urlsafe(24)


def generate_auth_token() -> str:
    """Bearer token returned once by sign-up / sign-in; only its hash is stored."""
    return secrets.token_urlsafe(32)


def generate_participant_secret() -> str:
    """Returned once by /join; only its hash is stored."""
    return secrets.token_urlsafe(24)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def secret_matches(secret: str, stored_hash: str | None) -> bool:
    if stored_hash is None:
        return False
    return secrets.compare_digest(hash_secret(secret), stored_hash)
