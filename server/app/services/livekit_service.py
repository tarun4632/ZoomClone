"""The only module that talks to LiveKit.

Routes get the service through the `get_livekit` dependency, so tests can override it
with a fake. Names checked against livekit-api 1.2.1.
"""

import asyncio
import json
import logging
from datetime import timedelta

import aiohttp
from livekit import api

from ..config import settings

log = logging.getLogger(__name__)

TOKEN_TTL = timedelta(hours=4)
# Short timeout for best-effort calls made while serving the dashboard.
LIST_ROOMS_TIMEOUT_SECONDS = 3.0
DEFAULT_TIMEOUT_SECONDS = 10.0


def role_metadata(role: str) -> str:
    """Participant metadata clients read to show "(Host)". Same shape in tokens and updates."""
    return json.dumps({"role": role})


def _metadata_role(metadata: str | None) -> str | None:
    try:
        role = json.loads(metadata or "").get("role")
    except (ValueError, AttributeError):
        return None
    return role if isinstance(role, str) else None


def is_not_found(exc: BaseException) -> bool:
    """True for LiveKit's 'room/participant does not exist' error."""
    return isinstance(exc, api.ServerError) and exc.code == api.ServerErrorCode.NOT_FOUND


class LiveKitService:
    def __init__(self, url: str, api_key: str, api_secret: str) -> None:
        self.url = url
        self.api_key = api_key
        self.api_secret = api_secret

    def _client(self, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> api.LiveKitAPI:
        return api.LiveKitAPI(
            self.url,
            self.api_key,
            self.api_secret,
            timeout=aiohttp.ClientTimeout(total=timeout),
        )

    def create_token(self, room: str, identity: str, name: str, is_host: bool) -> str:
        return (
            api.AccessToken(self.api_key, self.api_secret)
            .with_identity(identity)
            .with_name(name)
            # Other clients read this to show "(Host)" in the participants panel.
            .with_metadata(role_metadata("host" if is_host else "attendee"))
            # No room_admin, even for hosts: every host action goes through this server,
            # which checks the current role. An admin grant would outlive a role change.
            .with_grants(
                api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True)
            )
            .with_ttl(TOKEN_TTL)
            .to_jwt()
        )

    async def mute_all(self, room: str, host_identities: set[str]) -> None:
        """Force-mute every published audio track except those of host identities."""
        async with self._client() as lk:
            res = await lk.room.list_participants(api.ListParticipantsRequest(room=room))
            # All at once: one slow call must not hold up muting everyone else.
            await asyncio.gather(
                *(
                    lk.room.mute_published_track(
                        api.MuteRoomTrackRequest(
                            room=room, identity=p.identity, track_sid=t.sid, muted=True
                        )
                    )
                    for p in res.participants
                    if p.identity not in host_identities
                    for t in p.tracks
                    if t.type == api.TrackType.AUDIO and not t.muted
                )
            )

    async def mute_participant_audio(self, room: str, identity: str) -> None:
        """Force-mute one participant's published audio tracks. Never unmutes."""
        async with self._client() as lk:
            p = await lk.room.get_participant(
                api.RoomParticipantIdentity(room=room, identity=identity)
            )
            for t in p.tracks:
                if t.type == api.TrackType.AUDIO and not t.muted:
                    await lk.room.mute_published_track(
                        api.MuteRoomTrackRequest(
                            room=room, identity=identity, track_sid=t.sid, muted=True
                        )
                    )

    async def set_participant_role(self, room: str, identity: str, role: str) -> None:
        """Update the role in live participant metadata; every client sees the change."""
        async with self._client() as lk:
            await lk.room.update_participant(
                api.UpdateParticipantRequest(
                    room=room, identity=identity, metadata=role_metadata(role)
                )
            )

    async def participant_roles(self, room: str) -> dict[str, str | None]:
        """Everyone connected to the room right now, with the role in their metadata
        (None if the metadata carries no role)."""
        async with self._client() as lk:
            res = await lk.room.list_participants(api.ListParticipantsRequest(room=room))
            return {p.identity: _metadata_role(p.metadata) for p in res.participants}

    async def remove_participant(self, room: str, identity: str) -> None:
        async with self._client() as lk:
            await lk.room.remove_participant(api.RoomParticipantIdentity(room=room, identity=identity))

    async def end_room(self, room: str) -> None:
        async with self._client() as lk:
            await lk.room.delete_room(api.DeleteRoomRequest(room=room))

    async def active_room_names(self) -> set[str]:
        async with self._client(LIST_ROOMS_TIMEOUT_SECONDS) as lk:
            res = await lk.room.list_rooms(api.ListRoomsRequest())
            return {r.name for r in res.rooms}


_service = LiveKitService(settings.LIVEKIT_URL, settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)


def get_livekit() -> LiveKitService:
    return _service
