"""Meeting endpoints.

Every route is `async def`: with one worker, all database work then runs on the event loop
one request at a time, so join/leave/end state changes never interleave. The SQLite
queries are short, so running them inline is fine.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import HostKeyInput, JoinInput, JoinResponse, MeetingOwner, MeetingPublic, ScheduleMeetingInput
from ..seed import top_up_upcoming
from ..services import meeting_service as svc
from ..services.livekit_service import LiveKitService, get_livekit, is_not_found
from ..timeutil import utcnow

log = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _livekit_unavailable(exc: Exception) -> HTTPException:
    log.warning("LiveKit call failed: %r", exc)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not reach the media server")


@router.get("", response_model=list[MeetingOwner])
async def list_meetings(
    scope: Literal["upcoming", "recent"] = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    lk: LiveKitService = Depends(get_livekit),
) -> list[MeetingOwner]:
    now = utcnow()
    await svc.cleanup_stale_meetings(db, lk, now)
    if scope == "upcoming":
        top_up_upcoming(db, user, now)
        meetings = svc.list_upcoming(db, user, now)
    else:
        meetings = svc.list_recent(db, user)
    return [svc.to_owner(m, user) for m in meetings]


@router.post("/instant", response_model=MeetingOwner, status_code=status.HTTP_201_CREATED)
async def create_instant(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> MeetingOwner:
    return svc.to_owner(svc.create_instant(db, user), user)


@router.post("", response_model=MeetingOwner, status_code=status.HTTP_201_CREATED)
async def schedule_meeting(
    data: ScheduleMeetingInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MeetingOwner:
    return svc.to_owner(svc.create_scheduled(db, user, data), user)


@router.get("/{number}", response_model=MeetingPublic)
async def get_meeting(number: str, db: Session = Depends(get_db)) -> MeetingPublic:
    return svc.to_public(svc.get_meeting_or_404(db, number))


@router.get("/{number}/details", response_model=MeetingOwner)
async def get_details(
    number: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> MeetingOwner:
    return svc.to_owner(svc.get_meeting_or_404(db, number), user)


@router.post("/{number}/join", response_model=JoinResponse)
async def join_meeting(
    number: str,
    data: JoinInput,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> JoinResponse:
    meeting = svc.get_meeting_or_404(db, number)
    return svc.join(db, meeting, data, lk, utcnow())


@router.post(
    "/{number}/participants/{identity}/leave",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def leave_meeting(number: str, identity: str, db: Session = Depends(get_db)) -> Response:
    # No body and no Content-Type required, so navigator.sendBeacon can call it.
    meeting = svc.get_meeting_or_404(db, number)
    svc.leave(db, meeting, identity, utcnow())
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{number}/end", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def end_meeting(
    number: str,
    body: HostKeyInput,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_key(meeting, body.host_key)
    try:
        await lk.end_room(meeting.id)
    except Exception as exc:  # noqa: BLE001
        # No room (nobody connected) is fine. Otherwise still end it in the database:
        # the host's client disconnects itself, and stale cleanup is moot once ended.
        if not is_not_found(exc):
            log.warning("delete_room failed for %s: %r", meeting.id, exc)
    svc.end(db, meeting, utcnow())
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{number}/mute-all", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def mute_all(
    number: str,
    body: HostKeyInput,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_key(meeting, body.host_key)
    try:
        await lk.mute_all(meeting.id, svc.host_identities(db, meeting))
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):  # no room means nobody to mute
            raise _livekit_unavailable(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{number}/participants/{identity}/remove",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def remove_participant(
    number: str,
    identity: str,
    body: HostKeyInput,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_key(meeting, body.host_key)
    participant = svc.get_participant_or_404(db, meeting, identity)
    try:
        await lk.remove_participant(meeting.id, identity)
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):  # already gone from the room is fine
            raise _livekit_unavailable(exc) from exc
    svc.mark_removed(db, participant, utcnow())
    return Response(status_code=status.HTTP_204_NO_CONTENT)
