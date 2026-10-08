"""Sign up, sign in, sign out.

Plain `def` routes: FastAPI runs them in its thread pool, so hashing a password (tens of
milliseconds by design) never blocks the event loop the meeting routes run on.
"""

from fastapi import APIRouter, Depends, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..schemas import AuthOut, LoginInput, SignupInput, UserOut
from ..services import auth_service
from ..timeutil import utcnow

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)


def _signed_in(db: Session, user: User) -> AuthOut:
    token = auth_service.issue_token(db, user, utcnow())
    return AuthOut(access_token=token, user=UserOut.model_validate(user))


@router.post("/signup", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
def signup(data: SignupInput, db: Session = Depends(get_db)) -> AuthOut:
    return _signed_in(db, auth_service.signup(db, data))


@router.post("/login", response_model=AuthOut)
def login(data: LoginInput, db: Session = Depends(get_db)) -> AuthOut:
    return _signed_in(db, auth_service.login(db, data))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> Response:
    # Revokes the token it was called with. Fine to call with no token or an expired one.
    if credentials is not None:
        auth_service.revoke_token(db, credentials.credentials)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
