"""Meeting endpoints.

Every route is `async def`: with one worker, database work runs on the event loop and the
stretches between awaits never interleave. The SQLite queries are short, so running them
inline is fine.

Authorization:
- `host_key` (join only) means "I may join as host".
- In-meeting host actions take the caller's own `{identity, participant_secret}` and are
  allowed only while that participant row is joined and its current role is "host".
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import (
    JoinInput,
    JoinResponse,
    MeetingOwner,
    MeetingPublic,
    ParticipantCredentials,
    ScheduleMeetingInput,
)
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
    me: ParticipantCredentials,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_participant(db, meeting, me)
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
    me: ParticipantCredentials,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_participant(db, meeting, me)
    try:
        # Skips every joined row whose current role is host (including the caller).
        await lk.mute_all(meeting.id, svc.host_identities(db, meeting))
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):  # no room means nobody to mute
            raise _livekit_unavailable(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{number}/participants/{target}/mute",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def mute_participant(
    number: str,
    target: str,
    me: ParticipantCredentials,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_participant(db, meeting, me)
    svc.get_participant_or_404(db, meeting, target)
    try:
        await lk.mute_participant_audio(meeting.id, target)
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):  # not in the room means nothing to mute
            raise _livekit_unavailable(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{number}/participants/{target}/remove",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def remove_participant(
    number: str,
    target: str,
    me: ParticipantCredentials,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    svc.require_host_participant(db, meeting, me)
    participant = svc.get_participant_or_404(db, meeting, target)
    if participant.role == "host":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A host can't be removed")
    try:
        await lk.remove_participant(meeting.id, target)
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):  # already gone from the room is fine
            raise _livekit_unavailable(exc) from exc
    svc.mark_removed(db, participant, utcnow())
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{number}/participants/{target}/make-host",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def make_host(
    number: str,
    target: str,
    me: ParticipantCredentials,
    db: Session = Depends(get_db),
    lk: LiveKitService = Depends(get_livekit),
) -> Response:
    meeting = svc.get_meeting_or_404(db, number)
    caller = svc.require_host_participant(db, meeting, me)
    new_host = svc.get_participant_or_404(db, meeting, target)
    svc.check_can_become_host(new_host)  # 409 if not joined or already a host

    # LiveKit first (target, then caller); the database only changes if both succeed.
    # "Participant not found" in LiveKit is tolerated, as elsewhere: the database row is
    # the authority for host actions, and metadata only drives the "(Host)" label.
    try:
        await lk.set_participant_role(meeting.id, new_host.identity, "host")
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):
            raise _livekit_unavailable(exc) from exc
    try:
        await lk.set_participant_role(meeting.id, caller.identity, "attendee")
    except Exception as exc:  # noqa: BLE001
        if not is_not_found(exc):
            # Best-effort undo of the target's metadata so LiveKit matches the database.
            try:
                await lk.set_participant_role(meeting.id, new_host.identity, "attendee")
            except Exception as undo_exc:  # noqa: BLE001
                log.warning("could not undo role metadata for %s: %r", new_host.identity, undo_exc)
            raise _livekit_unavailable(exc) from exc

    svc.hand_over_host(db, caller, new_host)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
