from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_db
from .models import User
from .seed import DEFAULT_USER_EMAIL, seed_once


def get_current_user(db: Session = Depends(get_db)) -> User:
    """No login: every request acts as the seeded default user.

    Adding auth later only changes this function.
    """
    user = db.scalar(select(User).where(User.email == DEFAULT_USER_EMAIL))
    if user is None:  # database was wiped while running; re-seed
        seed_once(db)
        user = db.scalar(select(User).where(User.email == DEFAULT_USER_EMAIL))
    assert user is not None
    return user
