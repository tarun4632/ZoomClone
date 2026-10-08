from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .database import get_db
from .models import User
from .services import auth_service
from .timeutil import utcnow

# auto_error=False: a missing header is handled below, so some routes can allow guests.
_bearer = HTTPBearer(auto_error=False)


def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User | None:
    """The signed-in user, or None for a guest. An unknown or expired token also counts as a
    guest, so the public join flow keeps working for someone whose sign-in has lapsed.
    """
    if credentials is None:
        return None
    return auth_service.user_for_token(db, credentials.credentials, utcnow())


def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Sign in to continue",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user
