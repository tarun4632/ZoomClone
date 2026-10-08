# Zoom Clone: implementation plan

## 1. Scope

**Build:**
- Dashboard: navbar (logo, search-looking input that does nothing, settings icon and avatar placeholders), **New Meeting / Join / Schedule** tiles, clock card, Upcoming and Recent lists
- Instant meeting: unique meeting ID, invite link, redirect to the meeting room
- Join: by meeting ID plus passcode, or by invite link; display name required; meeting existence validated
- Schedule: title, description, date/time, duration, generated link, saved to DB, shown in Upcoming, meeting details page with "Copy Invitation"
- Meeting room: real audio/video through LiveKit Cloud, one gallery grid, mic/camera toggles, participants panel, leave, end meeting
- Host controls (bonus): mute all, remove participant
- Responsive layout (bonus)
- Seed data, README, deployment

**Not building:** waiting room, chat, reactions, screen share, a separate speaker view, keyboard shortcuts, Personal Meeting ID, real search, contacts, profile settings, login/signup, meeting edit/cancel, meeting lock, co-hosts, invitees, LiveKit webhooks, Redis, self-hosted SFU, Docker, CI/lint setup, global state libraries.

---

## 2. Architecture

```
               ┌───────────────────────────────────┐
               │  client/  (Next.js, Vercel)       │
               │  Dashboard · Pre-join · Room      │
               └───────┬───────────────────┬───────┘
          HTTPS REST   │                   │  WebRTC media + signaling
                       ▼                   ▼
 ┌──────────────────────────────┐   ┌─────────────────────────────┐
 │ server/  (FastAPI)           │   │ LiveKit Cloud (SFU)         │
 │  CONTROL PLANE               │   │  MEDIA PLANE                │
 │  • create / list meetings    │──▶│  • receives 1 stream per    │
 │  • meeting ID + invite link  │API│    publisher, forwards it   │
 │  • join validation           │   │    to every subscriber      │
 │  • mints LiveKit tokens      │   │  • TURN for NAT traversal   │
 │  • join / leave / end        │   └─────────────────────────────┘
 │  • mute all / remove         │
 └──────────────┬───────────────┘
                ▼
          SQLite (WAL)
```

**FastAPI never touches audio or video.** It decides who may join and with what role, then issues a signed LiveKit token. LiveKit Cloud moves the media.

### SFU concepts to be able to explain

| Topology | How it works | Upload per user (6 people, 1.5 Mbps) |
|---|---|---|
| Mesh (P2P) | Everyone sends to everyone | 5 × 1.5 = **7.5 Mbps**, breaks above about 4 people |
| MCU | Server decodes, mixes and re-encodes one stream | 1.5 Mbps, but very CPU-heavy on the server |
| **SFU** | Server forwards each stream without decoding | **1.5 Mbps**. This is the model Zoom, Meet and Teams use. |

- **Simulcast:** the publisher sends a few quality levels and the SFU picks one per viewer. In LiveKit this is one client flag.
- **TURN:** relays media when UDP is blocked. LiveKit Cloud provides it.
- **Why not write your own SFU?** It's infrastructure, like a database. The app's own logic is meetings, permissions and host controls.

---

## 3. Monorepo layout

```
zoom-clone/                 ← one public GitHub repo
├── client/                 ← Next.js  → Vercel  (Root Directory: client)
├── server/                 ← FastAPI  → Railway  (Root Directory: server)
├── README.md
└── .gitignore
```

The project currently lives in **OneDrive**. Exclude `node_modules` and `.venv` from sync, or move the project to something like `C:\dev\zoom-clone`. OneDrive syncing those folders is slow and causes file-lock errors on Windows.

---

## 4. Server (`server/`)

**Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, Pydantic v2 + pydantic-settings, `livekit-api`, pytest.

```
server/
├── app/
│   ├── main.py               # FastAPI app, CORS, routers, create tables + seed/top-up on startup
│   ├── config.py             # settings from env (DATABASE_URL, LIVEKIT_*, CLIENT_ORIGIN)
│   ├── database.py           # engine, SessionLocal, get_db, SQLite PRAGMAs
│   ├── models.py             # User, Meeting, MeetingParticipant
│   ├── schemas.py            # Pydantic request/response models (UTC datetimes with offset)
│   ├── deps.py               # get_current_user → the seeded default user
│   ├── routers/
│   │   ├── users.py          # GET /me
│   │   └── meetings.py       # all meeting endpoints
│   ├── services/
│   │   ├── meeting_service.py   # create, list, join, leave, end, cleanup of stale meetings
│   │   ├── livekit_service.py   # tokens, mute all, remove, delete room, list rooms
│   │   └── ids.py               # meeting number, passcode, host key
│   └── seed.py               # one-time history seed + startup top-up of future demo meetings
├── tests/test_meetings.py
├── requirements.txt
└── .env.example
```

There is no login. `get_current_user()` returns the seeded default user, and every route uses it, so adding auth later would only change that function. Tables are created with `Base.metadata.create_all()`, without migrations.

**Seeding** has two parts, because the SQLite file lives on a persistent volume and fixed demo dates would go stale between deploy and grading:
- **Once, when the database is empty:** users, plus ended meetings with participant rows for Recent. Past data never goes stale.
- **Top-up, on startup and before answering `GET /meetings?scope=upcoming`:** if the default user has fewer than 3 scheduled meetings whose end time is still ahead, add demo meetings relative to the current time (e.g. tomorrow 10:00, in 3 days, in 7 days, all UTC) until there are 3. Running it on the dashboard request, not only at startup, keeps Upcoming filled even if the service runs for weeks without a restart. It's one cheap count query, and it runs in the same place as the stale-meeting cleanup.

### Database schema

```
users 1───* meetings (host)
users 1───* meeting_participants  (nullable: attendees are guests)
meetings 1───* meeting_participants
```

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  avatar_color  TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE meetings (
  id                   TEXT PRIMARY KEY,          -- UUID; also the LiveKit room name
  meeting_number       TEXT NOT NULL UNIQUE,      -- 11 digits, shown as "123 4567 8901"
  host_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  description          TEXT,
  meeting_type         TEXT NOT NULL CHECK (meeting_type IN ('instant','scheduled')),
  status               TEXT NOT NULL CHECK (status IN ('scheduled','live','ended')),
  scheduled_start_at   DATETIME,                  -- UTC
  duration_minutes     INTEGER CHECK (duration_minutes > 0),
  passcode             TEXT NOT NULL,
  host_key             TEXT NOT NULL,             -- proves "I'm the host" when joining
  host_video_on        BOOLEAN NOT NULL DEFAULT 1,
  participant_video_on BOOLEAN NOT NULL DEFAULT 1,
  started_at           DATETIME,
  ended_at             DATETIME,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (meeting_type = 'instant' OR scheduled_start_at IS NOT NULL)
);
CREATE INDEX ix_meetings_host_status_start ON meetings(host_id, status, scheduled_start_at);

CREATE TABLE meeting_participants (               -- one row per join
  id           INTEGER PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- set for host joins; NULL = guest
  display_name TEXT NOT NULL,
  identity     TEXT NOT NULL UNIQUE,              -- random UUID; LiveKit identity (visible to others in the room)
  secret_hash  TEXT,                              -- SHA-256 of the participant's private secret; NULL on seeded history
  role         TEXT NOT NULL CHECK (role IN ('host','attendee')),
  status       TEXT NOT NULL CHECK (status IN ('joined','left','removed')),
  joined_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at      DATETIME
);
CREATE INDEX ix_participants_meeting_status ON meeting_participants(meeting_id, status);
```

Design decisions:
- **Participants are separate from users.** Guests join without an account, and rejoining creates a new row. This table is what makes "Recent meetings" possible.
- **Two IDs per meeting.** The UUID is internal and used as the room name. `meeting_number` is the human-facing ID.
- **Host key.** With no login, every browser counts as the default user, so the server needs another way to know who the host is.
  - The dashboard's endpoints return `host_key` for the user's meetings. Invite links never include it.
  - Joining with a valid key gives the host role and skips the passcode. Joining without it gives the attendee role, and the passcode is required.
  - Zoom has a similar "host key".
- **`user_id` on participant rows** is set only for host joins, to the host's user. Attendee joins are guests (`NULL`). Seed data may also include meetings hosted by other users where the default user attended.
- **Invite link** is `{CLIENT_ORIGIN}/j/{meeting_number}?pwd={passcode}`, the same shape as Zoom's.
- **Times are stored in UTC.** SQLite drops the timezone, so the schemas re-attach UTC on output (e.g. `2026-10-08T09:30:00Z`). Without that, the browser would read the time as local and show it shifted by hours.
- **Status enums are CHECK constraints**, because SQLite has no enum type.
- **SQLite settings:** `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` (SQLite ignores foreign keys without the second one). Run a single uvicorn worker.

### Meeting lifecycle (no webhooks)

- `scheduled` (or created as an instant meeting) → `live` on the first join. Anyone with the link can start it; there's no "wait for host".
- `live` → `ended` in either of two cases:
  1. The host clicks **"End meeting for all"**.
  2. The **last joined participant leaves**. Each client sends a leave request when it disconnects, and on tab close the request goes out with `navigator.sendBeacon`.
- **Restart:** a join on an `ended` meeting sets it back to `live` (new `started_at`, `ended_at` cleared) when either:
  - the caller has the **host key** (always allowed), or
  - the meeting is **scheduled and its window hasn't ended yet** (`scheduled_start_at + duration_minutes > now`). This matches "anyone with the link can start it".
- **410 "This meeting has ended"** goes only to attendees joining an ended **instant** meeting, or an ended scheduled meeting whose window is over.
- Why the restart rule matters: "anyone can start" plus "last person out ends it" would otherwise break two common cases.
  - A grader schedules a meeting for tomorrow, tests the invite link in incognito, and leaves. Without the rule, tomorrow's guests would get 410.
  - A guest who is alone refreshes the page. The `pagehide` leave ends the meeting, and without the rule their rejoin would get 410.
- **"End meeting for all" on a scheduled meeting** inside its window disconnects everyone, but anyone with the link can start it again, as in Zoom with "join before host" enabled. On an instant meeting, End is final for attendees.
- **Stale-meeting cleanup:** a browser crash or lost network can mean no leave request ever arrives, leaving the meeting stuck as `live`.
  - Before answering `GET /meetings`, the server calls LiveKit's `list_rooms` once.
  - Any `live` meeting that started more than 2 minutes ago and has no LiveKit room is marked `ended`, and its open participant rows are marked `left`. The 2-minute grace covers the gap between `/join` and the room actually being created.
  - This is a normal API call, not a webhook.
- **Upcoming is decided by the schedule window, not by `status`:** `meeting_type = 'scheduled'` and (`datetime(scheduled_start_at, '+' || duration_minutes || ' minutes') > datetime('now')` or `status = 'live'`). Ordered by start time. `live` rows are labelled "In progress".
  - A meeting that was tested early and ended stays in Upcoming until its window is over.
  - The `status = 'live'` clause keeps a meeting that runs past its scheduled duration visible.
- **Recent:** `status = 'ended'` and (`host_id` = me, or a participant row with `user_id` = me). Ordered by `ended_at` descending. A scheduled meeting that was tested early can appear in both lists. That's intended: Recent is a history of sessions, and Upcoming lists what's on the calendar.

### API (`/api`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Default user, for the navbar avatar |
| GET | `/meetings?scope=upcoming\|recent` | Dashboard lists. Runs the stale-meeting cleanup first, plus the demo top-up for `upcoming`. Includes `passcode` and `host_key`, since these are the user's own meetings. |
| POST | `/meetings/instant` | New Meeting → `{meeting_number, passcode, host_key, invite_url}`. Title is set to "{host name}'s Zoom Meeting", as Zoom does. |
| POST | `/meetings` | Schedule: `{title, description, start_at, duration_minutes, host_video_on, participant_video_on}` |
| GET | `/meetings/{number}` | Public info for the join flow: `{title, host_name, status, host_video_on, participant_video_on}`. 404 if unknown. |
| GET | `/meetings/{number}/details` | Owner view for the details page: everything above plus `passcode`, `host_key`, `invite_url`, schedule fields |
| POST | `/meetings/{number}/join` | `{display_name, passcode?, host_key?}` → `{identity, role, token, livekit_url, passcode, invite_url}`. 403 for a wrong passcode. On an ended meeting it restarts the meeting if the caller has the host key or the meeting is scheduled and inside its window; otherwise 410. |
| POST | `/meetings/{number}/participants/{identity}/leave` | No body. Sets `left_at` and ends the meeting if nobody is left. Calling it twice does nothing extra. |
| POST | `/meetings/{number}/end` | Host only: deletes the LiveKit room and marks the meeting ended |
| POST | `/meetings/{number}/mute-all` | Host only. Mutes everyone except participants whose database role is `host`. |
| POST | `/meetings/{number}/participants/{identity}/mute` | Host only. Mutes that participant's microphone (never unmutes). |
| POST | `/meetings/{number}/participants/{identity}/remove` | Host only. A host can't be removed. |
| POST | `/meetings/{number}/participants/{identity}/make-host` | Host only. That attendee becomes host and the caller becomes an attendee; both roles update live in LiveKit metadata. |

- **Host-only endpoints** take the caller's own credentials, `{identity, participant_secret}`, in the body.
  - The server allows the action only if that participant row is `joined` and its **current** `role` is `host`; otherwise it returns 403.
  - **Where the secret comes from:** `/join` returns a random `participant_secret` to that participant only. The server stores only its SHA-256 hash.
  - **Why not the identity alone:** the `identity` is visible to everyone in the LiveKit room, so it can't prove who's calling.
- **The host key versus the role:**
  - The `host_key` only decides who may *join as host*.
  - During a meeting, authority follows the role. That's what makes **Make Host** work: the new host never needs the host key.
  - Rejoining with the host key gives the host role again, so after a transfer there can briefly be two hosts.
- The leave endpoint takes no body, so `sendBeacon` can call it cross-origin without content-type or CORS-preflight problems. The identity in the URL is a random UUID, so nobody can guess someone else's.
- Pre-join runs before `/join`, so the video defaults come from the public info. The pre-join camera toggle starts as `host_video_on` if the browser has a host key for this meeting, and as `participant_video_on` otherwise.
- `/join` returns `passcode` and `invite_url` so the in-room meeting-info panel can show them to everyone, including a host who joined with only the host key. The caller has already proven access, so this exposes nothing new.

### Key code

```python
# services/ids.py
def generate_meeting_number() -> str:
    # 11 digits, never starting with 0. If the UNIQUE constraint fails,
    # the caller rolls back the session and retries.
    return secrets.choice("123456789") + "".join(secrets.choice(string.digits) for _ in range(10))

def generate_passcode() -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(6))

def generate_host_key() -> str:
    return secrets.token_urlsafe(16)
```

```python
# services/livekit_service.py: the only module that talks to LiveKit
def create_token(room: str, identity: str, name: str, is_host: bool) -> str:
    return (
        api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(name)
        # Other clients read this to show "(Host)" in the participants panel.
        .with_metadata(json.dumps({"role": "host" if is_host else "attendee"}))
        .with_grants(api.VideoGrants(room_join=True, room=room, room_admin=is_host,
                                     can_publish=True, can_subscribe=True))
        .with_ttl(timedelta(hours=4))
        .to_jwt()
    )

async def mute_all(room: str, host_identities: set[str]) -> None:
    # host_identities: every meeting_participants row for this meeting with
    # role='host' and status='joined' (covers a host with two tabs open).
    async with api.LiveKitAPI(settings.LIVEKIT_URL, settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET) as lk:
        res = await lk.room.list_participants(api.ListParticipantsRequest(room=room))
        for p in res.participants:
            if p.identity in host_identities:
                continue
            for t in p.tracks:
                if t.type == api.TrackType.AUDIO and not t.muted:
                    await lk.room.mute_published_track(api.MuteRoomTrackRequest(
                        room=room, identity=p.identity, track_sid=t.sid, muted=True))

async def active_room_names() -> set[str]:
    async with api.LiveKitAPI(settings.LIVEKIT_URL, settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET) as lk:
        res = await lk.room.list_rooms(api.ListRoomsRequest())
        return {r.name for r in res.rooms}

async def remove_participant(room: str, identity: str) -> None: ...  # lk.room.remove_participant
async def end_room(room: str) -> None: ...                           # lk.room.delete_room
```

These names follow the current `livekit-api` SDK. Check them against the docs for the version you install.

- **Roles are decided only by the server**, from the host key, and written into the signed token.
- **Mute all** forces a mute but never forces an unmute, same as Zoom. Participants unmute themselves.
  - The server works out who to skip from the database: every participant row with `role = 'host'` and `status = 'joined'`. A host with two tabs open isn't muted in either.
- **Mute one participant** mutes that person's published audio tracks through LiveKit's `mute_published_track`. Like Mute All, it never unmutes.
- **Remove** disconnects the person from the LiveKit room and sets their row to `removed`. They can rejoin with the same link, which is a known limitation without login. A host can't be removed.
- **Make Host** swaps the two rows' `role` in the database and updates both participants' LiveKit metadata with `update_participant`. Every client reads the role from that metadata, so "(Host)" labels and host controls move live. LiveKit is updated before the database commit; if LiveKit fails, the database is left unchanged and the endpoint returns 502.
- Endpoints that call LiveKit are `async def`. Their short SQLite queries run inline, which is fine with one worker.

### Tests (10, backend only)

The LiveKit service is replaced with a fake in tests.

1. Creating an instant meeting gives an 11-digit unique number, a passcode and a host key.
2. Upcoming includes a future scheduled meeting, a live one marked "In progress", and a future scheduled meeting that was started and ended early. It does not include one whose end time has passed.
3. `GET /meetings/{unknown}` returns 404.
4. Joining with a wrong passcode returns 403. Joining with a valid host key and no passcode succeeds.
5. Joining with the host key gives the host role and `user_id` set. Joining without it gives the attendee role and `user_id` `NULL`.
6. When the last participant leaves, the meeting is ended and appears in Recent. Calling leave a second time changes nothing.
7. On an ended **instant** meeting, an attendee's join returns 410 and the host's join restarts it as `live`. On an ended **scheduled** meeting still inside its window, an attendee's join restarts it.
8. Calling mute-all as an attendee, or with a wrong secret, returns 403. With host credentials, every participant except those with the `host` role in the database gets muted (checked through the fake LiveKit service).
9. Make Host swaps the roles in the database and sends both role updates to LiveKit. Afterwards the old host gets 403 on mute-all, and the new host gets 204.
10. Muting one participant returns 403 for an attendee caller and 204 for a host. A host can't be removed.

Everything else gets tested by hand in the browser, which matters more for this assignment.

---

## 5. Client (`client/`)

**Stack:** Next.js (App Router) + TypeScript, Tailwind, `livekit-client` + `@livekit/components-react`, date-fns, lucide-react icons.

**What to use from `@livekit/components-react`:**
- **Hooks:** `useTracks`, `useParticipants`, `useLocalParticipant`, `useIsSpeaking`.
- **`RoomAudioRenderer`:** plays every remote participant's audio. Without it, people see video but hear nothing.
- **`VideoTrack`:** attaches a video track to a `<video>` element inside your own tile.
- Everything visible is your own Zoom-styled UI: the grid, tiles, toolbar and panels. Don't use the prebuilt `VideoConference`, `ControlBar` or `GridLayout`. These are SDK building blocks like the hooks, not copied UI, so they don't raise the originality concern.

**State:** `useState` / `useEffect` plus LiveKit's own room state. No Zustand, no TanStack Query, no global stores. Data fetching is plain `fetch` through a small `lib/api.ts`.

**SPA:** all pages are client components that fetch on the client and navigate with `router.push`.

```
client/src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                    # Dashboard
│   ├── meetings/[number]/page.tsx  # Meeting details + Copy Invitation + Start
│   ├── j/[number]/page.tsx         # Invite link landing → /wc/[number]?pwd=...
│   └── wc/[number]/page.tsx        # Pre-join stage → meeting room stage (one page)
├── components/
│   ├── ui/          Button, Modal, Avatar
│   ├── dashboard/   Navbar, ActionTile, ClockCard, MeetingList,
│   │                JoinMeetingModal, ScheduleMeetingModal
│   └── meeting/     PreJoin, VideoGrid, VideoTile, Toolbar,
│                    ParticipantsPanel, MeetingInfo, LeaveMenu
└── lib/
    ├── api.ts               # fetch wrappers for each endpoint
    ├── parseMeetingInput.ts # "123 4567 8901" | full invite URL → {number, pwd}
    ├── format.ts            # formatMeetingNumber, formatTimeRange
    └── types.ts
```

`/wc/[number]` holds a single `stage` state (`"prejoin"` or `"room"`), so the name, the mic/camera choices and the preview tracks pass directly into the room.

The dashboard hands the host key over through `sessionStorage`, keyed by meeting number, never through the URL. If it were in the URL, a host who copied the address bar to share it would turn every guest into a host.

### Zoom UI checklist (styled after the Zoom web portal's signed-in home page)

**Rule: nothing on screen is only for show.** Every button, link and field works. Zoom's portal items that this app has no feature for are left out: the marketing nav, the top bar, the sidebar products, the plan/upgrade cards, Personal Meeting ID, Test Audio and Video, and the footer.

- **Navbar:** white, with the blue "zoom" text wordmark on the left. On the right: **Schedule**, **Join** and **New Meeting** text links that open the same modals and actions as the tiles, then a sun/moon **light/dark mode** toggle, then the user's avatar as a rounded square with their initial. No search box and no settings icon, since neither would do anything.
- **Light and dark mode:**
  - **Default:** the OS setting, until the user picks one with the toggle; the choice is saved in `localStorage`.
  - **Before first paint,** an inline script sets `<html data-theme>` so the page never flashes the wrong theme.
  - **How it re-themes:** dark mode redefines the colour tokens, so every card, list, modal and form changes with it.
  - **Not affected:** the meeting room and pre-join stay dark in both modes, as in Zoom.
- **Dashboard layout:** two columns of white cards with about a 16px radius and a very soft shadow. On phones they stack into one column, action card first.
  - **Left, wide column:**
    - **Profile card:** a large rounded-square avatar (initial), the name in large bold type, the email in muted text, and the live clock and date on the right.
    - **Recent card:** a "Recent meetings" heading with a divider. When empty, it shows a box illustration and "No recent meetings".
  - **Right, narrow column:**
    - **Action card:** three rounded-square icons with grey labels underneath: **Schedule** (blue, calendar), **Join** (blue, plus), **New Meeting** (orange, video camera).
    - **Meetings card:** a "Meetings" heading, then the Upcoming list.
  - **Colours:** Zoom blue around `#0B5CFF`, orange around `#FF742E`. Secondary buttons are light-blue pills with blue text.
  - Upcoming is grouped under day headings: "Today", "Tomorrow", then dates such as "Mon, Oct 12". Zoom's home screen shows only today, so when nothing is scheduled today, the Today group shows "No upcoming meetings today" and later days still appear below it. Live meetings are labelled "In progress".
  - Get exact colours by eyedropping your screenshots.
- **Join modal:** "Meeting ID or invite link" and "Your Name". The Join button stays disabled until both are filled. Show a Zoom-style "Invalid meeting ID" error.
- **Schedule modal:**
  - Topic (pre-filled "{Name}'s Zoom Meeting", like Zoom), Description, date, time, Duration (hours and minutes), Host video on/off, Participant video on/off.
  - A read-only time zone label showing the browser's time zone (e.g. "India Standard Time"). This is the zone the entered time is converted to UTC from, so the label is accurate.
  - After saving, show the details page with **Copy Invitation** (template below).
- **Pre-join:** dark background, camera preview, mic and camera toggles (the camera starts as the meeting's host/participant video default says), a name input, and a **Meeting Passcode** field shown only when the URL has no `pwd` and there's no host key. Then a blue **Join** button and a **Cancel** button that releases the camera and mic and returns to the dashboard.
- **Meeting room** (styled after a screenshot of the real Zoom meeting window, with only working controls):
  - Near-black stage, with video tiles filling it edge to edge; a single participant fills the stage.
  - Each tile has a dark translucent name label at the bottom-left, with a red slashed mic when muted.
  - The speaker gets a green border, as in Zoom's gallery view (LiveKit's `isSpeaking`).
  - With video off, show the name or initials in the centre.
  - At the top-left, a pill with an ⓘ icon and the meeting title opens meeting info: ID, host, passcode and invite link.
  - Left out because they'd be decoration only: Chat, React, Share, Host tools, More, the ^ device menus, the view switcher and the encryption shield.
- **Toolbar:** a full-width dark bar with icon-over-label controls and no button backgrounds. Mute/Unmute and Start/Stop Video are on the left, Participants (with a superscript count) in the centre, and a red circled-X **End** (host) or **Leave** (guest) on the right. The host gets the "End Meeting for All / Leave Meeting" choice.
- **Participants panel:** "Participants (N)", rows with "(Host)" or "(Host, me)" and mic/camera icons. The role is read live from LiveKit metadata, so it updates when the host changes.
  - **For the host, on other attendees' rows:**
    - **Mute**, shown while their mic is on; it acts immediately, as in Zoom.
    - A **More** menu with **Make Host** (confirm: "Make {name} the host? You will become a participant.") and **Remove**.
  - **Mute All** in the footer.
  - **When the role moves,** a brief notice says "You are now the host" or "{name} is now the host".
- **Confirmations (host):** Remove asks "Remove {name} from the meeting?". Mute All asks "Mute all current participants?". Don't copy Zoom's "All current and new participants will be muted": this build doesn't mute people who join later, so that text would be wrong.
- **States:** loading, "Invalid meeting ID", "This meeting has ended", "You have been removed", "Cannot access camera".

### Invitation text (Copy Invitation)

Zoom's format, filled from `/details`:

```
{host name} is inviting you to a scheduled Zoom meeting.

Topic: {title}
Time: {start in the browser's time zone, e.g. "Oct 9, 2026 10:00 AM India"}

Join Zoom Meeting
{invite_url}

Meeting ID: {123 4567 8901}
Passcode: {passcode}
```

Leave out Zoom's "One tap mobile" and dial-in sections, because there's no phone dial-in. An instant meeting has no start time, so its invitation drops the `Time:` line and says "is inviting you to a Zoom meeting."

### Room connection

```ts
// Pre-join created these with createLocalVideoTrack / createLocalAudioTrack.
// Reusing them avoids opening the camera twice, which can fail on Windows.
const room = new Room({ adaptiveStream: true, dynacast: true,
  publishDefaults: { simulcast: true } });
await room.connect(livekitUrl, token);
for (const track of previewTracks) await room.localParticipant.publishTrack(track);

const leaveUrl = `${API_URL}/api/meetings/${number}/participants/${identity}/leave`;
window.addEventListener("pagehide", () => navigator.sendBeacon(leaveUrl));
```

- Wrap the room stage in LiveKit's room context provider, holding the `room` above, so the hooks work. Render `<RoomAudioRenderer />` once inside it. Check the provider's exact name against the installed `@livekit/components-react` version.
- On Leave, disconnect, `POST` to the leave URL, then go back to the dashboard. On tab close, `pagehide` sends the same request with `sendBeacon`. `pagehide` fires more reliably than `beforeunload`, especially on mobile.
- On `Disconnected`, show "You have been removed" or "This meeting has been ended by the host", depending on the reason.
- Safari blocks audio until the user clicks something, so call `room.startAudio()` from a click.
- React Strict Mode runs effects twice in development. Guard the connect and the preview-track creation with a ref, so the room doesn't connect twice and the camera isn't opened twice.

### Mic and camera on/off

None of this involves FastAPI or the database. Only the host's Mute All goes through the server.

**Pre-join:**
- **Camera off:** stop and release the preview video track, so the camera light goes off. **Camera on:** create a new one.
- **Mic off:** keep the preview audio track but mute it. **Mic on:** unmute it.
- **On Join:** publish only the tracks that exist. The audio track is always published, muted if the mic was off, so others see the muted-mic icon straight away. If the camera was off, no video track is published.

**In the room:**
- The toolbar buttons call `localParticipant.setMicrophoneEnabled(...)` and `setCameraEnabled(...)`. These pick up the tracks published from pre-join, because those tracks have the Microphone and Camera sources. If the camera was off at join, turning it on creates and publishes a track.
- Button state comes from `useLocalParticipant()` (`isMicrophoneEnabled`, `isCameraEnabled`), never from a separate `useState`. A server-side Mute All then flips the button to "Unmute" automatically.
- Other people see the change through LiveKit's track mute events: the muted-mic icon on the tile, the name or initials when video is off, and the icons in the participants panel.
- Expected device behaviour, to confirm in the Setup check: turning the camera off releases it (light off), and muting the mic keeps the device open, so unmuting is instant.

---

## 6. Main flows

**New Meeting**
1. `POST /meetings/instant`
2. Save the host key in `sessionStorage`, then go to `/wc/{number}`
3. Pre-join (name prefilled, no passcode field)
4. `POST /join` with the host key → host token
5. Connect to LiveKit

**Join by invite link**
1. `/j/{number}?pwd=...`
2. → `/wc/{number}?pwd=...`
3. `GET /meetings/{number}`
4. Pre-join (name only)
5. `POST /join` with the passcode → attendee token

**Join by meeting ID**
1. Join modal → `parseMeetingInput`
2. `GET /meetings/{number}` (404 means "Invalid meeting ID")
3. Pre-join (name + passcode)
4. `POST /join` → attendee token

**Schedule**
1. Modal → `POST /meetings` (local time converted to UTC)
2. Refetch Upcoming
3. **Start** from the list or the details page joins as host

**Leave / end / restart**
- **Leave:** the leave request. If the last person leaves, the meeting is ended.
- **End for all:** `POST /end` deletes the LiveKit room and marks the meeting ended, so it moves to Recent.
- **Restart:** the host refreshes or clicks Start again → join with the host key → the meeting is `live` again. Guests can also restart a scheduled meeting during its window, so testing the invite link early doesn't break the real meeting.

---

## 7. Deployment

| Piece | Where | Notes |
|---|---|---|
| Client | **Vercel**, Root Directory `client` | Env: `NEXT_PUBLIC_API_URL` |
| Server | **Railway** with a volume mounted for the SQLite file, Root Directory `server` | Env: `DATABASE_URL` (path on the volume), `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `CLIENT_ORIGIN`. `CLIENT_ORIGIN` is the Vercel production URL and is used for both CORS and invite links. Check Railway's current pricing. |
| SFU | **LiveKit Cloud** free tier | Create a project, copy the URL and API key/secret into the server env |

Avoid Render's free tier for the server. Its disk is wiped whenever the service restarts, including when it wakes from idle sleep, and waking takes about 50 seconds. Scheduled meetings would disappear during evaluation. Render only works with a paid persistent disk.

Only the Vercel production domain passes CORS. Preview deployments are not supported.

**Local development:** `uvicorn app.main:app --reload` and `npm run dev`, both pointing at the same LiveKit Cloud project. The camera works on `localhost`. Anywhere else, browsers require HTTPS, which Vercel provides.

---

## 8. Implementation checklist

Five steps, done in order. Each ends with a **Done when** check; don't start the next step until it passes.

Rules for every step:
- **Redeploy after each step** (from step 1 on), so build, CORS and HTTPS problems show up early, not at the end.
- **Build every screen for phone and desktop at the same time.** Step 5 only does a final phone check.
- **Commit after each checklist item that works.** Never commit `.env`.

**Status (2026-10-08):** `[x]` means built and checked by the backend tests, the TypeScript check, the production build, or an API smoke test with both apps running. No **Done when** check that needs a real call, a phone or a deployment has been run yet.

### 1. Setup and first deploy
- [ ] Move the project out of OneDrive (e.g. `C:\dev\zoom-clone`), or exclude `node_modules` and `.venv` from sync. *Not done: still in OneDrive.*
- [ ] `git init`, a root `.gitignore` (`node_modules`, `.next`, `.venv`, `__pycache__`, `*.db`, `.env*` except `.env.example`) before the first commit, and a public GitHub repo. *`git init` and `.gitignore` are done. Not done: no commits yet (git `user.name` isn't set) and no GitHub repo.*
- [x] Pick one Python version for local and Railway, and pin it. *Pinned `3.14` in `server/.python-version`. Railway support for 3.14 is not yet confirmed.*
- [x] `server/`: venv, `requirements.txt` (fastapi, uvicorn, sqlalchemy, pydantic-settings, livekit-api, pytest, httpx), `config.py` with safe defaults so tests run without real LiveKit keys, `main.py` with CORS and a health route
- [x] `client/`: Next.js App Router + TypeScript + Tailwind; install `livekit-client`, `@livekit/components-react`, `date-fns`, `lucide-react`; `lib/api.ts` reading `NEXT_PUBLIC_API_URL`
- [ ] LiveKit Cloud project; URL, key and secret in `server/.env`; `.env.example` in both apps. *The `.env.example` files are done. Not done: no LiveKit project or keys yet.*
- [ ] LiveKit test: a throwaway token route on FastAPI and a throwaway client page that connects with it. *Skipped: once the keys are in, the real `/join` and `/wc` page do this test instead. The SDK names were checked against the installed type definitions.*
- [ ] First deploy:
  - **Railway:** Root Directory `server`, a volume with `DATABASE_URL` pointing into it, the LiveKit env vars, a single uvicorn worker on `$PORT`
  - **Vercel:** Root Directory `client`. Set `NEXT_PUBLIC_API_URL` **before** the first build, because Next.js bakes it in at build time.
  - Set `CLIENT_ORIGIN` on Railway to the Vercel URL
- **Done when:**
  - The deployed client calls the deployed health route with no CORS error.
  - Two browsers join the same LiveKit room through the throwaway token, both locally and on the Vercel URL.
  - You've confirmed against your installed SDK versions: the `livekit-api` method names, the components-react room context provider, and the camera/mic behaviour described in "Mic and camera on/off".

### 2. Backend
- [x] `database.py`: engine, `SessionLocal`, `get_db`, and `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` on every connection
- [x] `models.py`: the 3 tables exactly as in the schema, with the CHECK constraints, UNIQUE columns, foreign keys with `ON DELETE`, and both indexes
- [x] `schemas.py`: datetimes go out with a UTC offset; `start_at` coming in is converted to UTC
- [x] `ids.py`: meeting number, passcode, host key; roll back and retry when the meeting number collides
- [x] `deps.py`: `get_current_user` returns the default user
- [x] `seed.py`:
  - one-time seed: users, and ended meetings with participant rows, including one hosted by another user that the default user attended
  - top-up to 3 future scheduled meetings
- [x] `livekit_service.py`: `create_token` (identity, name, role metadata, grants, 4-hour TTL), `mute_all(host_identities)`, `remove_participant`, `end_room`, `active_room_names`
- [x] `meeting_service.py`:
  - create an instant meeting (titled "{host name}'s Zoom Meeting") or a scheduled one
  - Upcoming (schedule window or `live`) and Recent lists
  - join: passcode or host key → role and `user_id`; restart rules; 403 and 410
  - leave: changes nothing on a second call; ends the meeting when the last joined participant leaves
  - end
  - stale-meeting cleanup with the 2-minute grace
- [x] Routers: `GET /me` and every endpoint in the API table. Host-only endpoints return 403 without the host key, and leave takes no body.
- [x] `GET /meetings` runs the stale-meeting cleanup first, plus the top-up for `upcoming`
- [x] Tests: a fake LiveKit service and a throwaway SQLite database; the 10 tests in section 4 pass. *10 passed. A local smoke test also checked leave, the auto-end, 410, the host restart, and Make Host / Mute one against the running server.*
- [x] Remove the throwaway token route from step 1. *Not needed: the route was never created.*
- [ ] Redeploy the server. *Not done: not deployed yet.*
- **Done when:** `pytest` passes, every endpoint behaves correctly when called by hand from FastAPI's `/docs` page (locally and on Railway), and the seeded meetings come back from the deployed `GET /meetings`.

### 3. Dashboard
- [x] Take screenshots of the real Zoom web app; eyedrop the colours into the Tailwind theme. *Screenshots of the Zoom web portal home page are in hand. Their card, button and colour style is now in the theme tokens.*
- [x] Restyle the dashboard after the web portal screenshots, as described in the UI checklist in section 5: two-column cards, the action-icon card, the profile card with the clock, the Meetings card, the Recent card with its empty-state box, and no decorative-only elements. *Checked with screenshots of the built app at 1440px and 360px; there's no sideways scroll on phones.*
- [x] `lib/`: `types.ts`, `api.ts` (one wrapper per endpoint), `format.ts`, `parseMeetingInput.ts` (a spaced ID, plain digits, or a full invite URL)
- [x] `ui/`: Button, Modal, Avatar
- [x] Navbar: wordmark, working Schedule / Join / New Meeting links, and an avatar from `GET /me`. *The decorative search box and settings icon are removed. On phones the links become icon buttons.*
- [x] Tiles:
  - **New Meeting:** `POST /meetings/instant` → host key into `sessionStorage` → `/wc/{number}` in the same tab
  - **Join** and **Schedule**: open their modals
- [x] Action card: Schedule, Join and New Meeting as rounded-square icons in one row, which replaces the old big tiles. It fits at 360px, and on phones it's the first card.
- [x] `ClockCard` (live clock and date). `MeetingList` for:
  - Upcoming: grouped under Today / Tomorrow / dates, "No upcoming meetings today" in an empty Today group, "In progress" label, Start button that joins as host
  - Recent
- [x] `JoinMeetingModal`:
  - Join stays disabled until both fields are filled
  - `GET /meetings/{number}`; show "Invalid meeting ID" on 404
  - carry the name over to pre-join
- [x] `ScheduleMeetingModal`: Topic pre-filled "{Name}'s Zoom Meeting", the other fields, a read-only browser time-zone label → local time converted to UTC → `POST /meetings` → refetch Upcoming → open the details page
- [x] `meetings/[number]` details page: `GET /details`, **Copy Invitation** using the invitation template in section 5, Start as host. *The invitation's time zone shows as e.g. "GMT+5:30", not "India".*
- [x] `j/[number]`: redirect to `/wc/[number]?pwd=...`
- [x] Any page using `useSearchParams` sits inside a `<Suspense>` boundary, or the Vercel build fails. *`next build` passes.*
- [ ] Redeploy the client. *Not done: not deployed yet.*
- **Done when**, on the deployed site at desktop and phone width:
  - New Meeting creates a meeting, saves its host key, and opens `/wc/{number}`. The room page is still empty until step 4.
  - Scheduling a meeting puts it in Upcoming under the right day.
  - Its details page opens, and the copied invitation matches the template.
  - Start (from the list and the details page) opens `/wc/{number}` with the host key saved.
  - The Join modal rejects an unknown ID and passes a valid one to `/wc/{number}`.
  - Recent shows the seeded ended meetings.

### 4. Meeting room (`/wc/[number]`)

Built in two halves. 4a gives a working call; 4b adds host controls on top. If time runs short, 4a alone is still a demo.

*Status: all of step 4's code is written, type-checks and builds, and every LiveKit API was checked against the installed type definitions. None of it has run in a real call yet, because that needs LiveKit keys and a camera, so neither "Done when" check below has been run.*

**4a. A working call**
- [x] Pre-join stage:
  - `GET /meetings/{number}`; show the loading, "Invalid meeting ID" and "This meeting has ended" states
  - host key from `sessionStorage`, never from the URL
- [x] Pre-join preview, following "Mic and camera on/off":
  - camera and mic preview tracks; the camera starts from the host/participant video default
  - camera off releases the track; mic off mutes it
  - "Cannot access camera" still lets the person join
- [x] Pre-join form:
  - name input, prefilled from `/me` for the host, or carried over from the Join modal
  - passcode field shown only when the URL has no `pwd` and there's no host key
  - Join → `POST /join`; handle 403 (wrong passcode) and 410
- [x] Connection:
  - `Room` with adaptiveStream, dynacast and simulcast; connect; publish the preview tracks (the audio track muted if the mic was off)
  - a Strict Mode guard (a ref), so the room doesn't connect twice in development
- [x] Room setup: room context provider, one `RoomAudioRenderer`, and `room.startAudio()` from a click
- [x] `VideoGrid` + `VideoTile`:
  - responsive gallery grid with a name label and muted-mic icon on each tile
  - green border while speaking; initials when video is off
- [x] `Toolbar`:
  - mic and camera through `setMicrophoneEnabled` / `setCameraEnabled`, with their state from `useLocalParticipant()`
  - Participants with a count, and Leave
  - fits at phone width
- [x] `ParticipantsPanel` (read-only for now): "Participants (N)", "(Host)" and "(Host, me)" from token metadata, mic and camera icons; an overlay at phone width
- [x] Leave:
  - Leave button: disconnect, POST leave, go to the dashboard
  - on `pagehide`: `sendBeacon` to the leave URL
- **Done when**, on the deployed site, with two browsers (or a laptop and a phone):
  - they see and hear each other
  - mic and camera toggles update both screens
  - Leave works
  - closing the last tab ends the meeting (it shows in Recent)

**4b. Host controls and end states**
- [x] `MeetingInfo` (the ⓘ title pill at the top-left): meeting ID, passcode and invite link from the `/join` response
- [x] Participants panel, for the host: Remove on each row and Mute All in the footer, each behind its confirmation dialog
- [x] Toolbar, for the host: the End menu with "End Meeting for All" and "Leave Meeting"; End for all calls `POST /end`
- [x] `Disconnected` handler: show "You have been removed" or "This meeting has been ended by the host", depending on the reason
- **Done when** all of these work as section 4 describes:
  - Mute All mutes the guest, and the guest's button flips to "Unmute"
  - Remove disconnects the guest
  - End for all ends the meeting for everyone
  - the host restarts an ended meeting, and a guest restarts a scheduled meeting inside its window
  - a guest gets "This meeting has ended" on an ended instant meeting
  - crash test: kill a browser during a meeting; within about 2 minutes, loading the dashboard moves that meeting to Recent

### 5. Ship
- [ ] Every loading, empty and error state from the UI checklist is in place
- [ ] Final phone check of every screen: the dashboard, pre-join, the room and the participants overlay
- [ ] Final deploy: Railway and Vercel env vars match `.env.example`; the Python version is pinned on Railway
- [ ] Production test:
  - run every flow from the main flows section on the deployed URLs, using two devices including a phone
  - restart the Railway service and confirm the data survives
- [ ] README: setup steps, architecture, schema, the assumptions below, and the live links
- [ ] Final check: the repo is public, no `.env` is committed, and Upcoming isn't empty
- **Done when:** someone who has never seen the project can open the Vercel URL, run every flow, and find answers in the README.

### README must state these assumptions

- No login. Anyone who opens the dashboard is treated as the default user, which follows from the assignment's "assume a default user is logged in". That includes seeing that user's host keys.
- Host identity comes from the host key, not from an account. Invite links never contain it.
- The passcode is embedded in invite links (`?pwd=`), as in Zoom. Joining by meeting ID asks for it.
- A meeting ends when the host ends it or the last participant leaves. The host can always restart it. Anyone with the link can restart a scheduled meeting until its scheduled end time; an ended instant meeting stays ended for guests.
- A removed participant can rejoin with the same link (no login means no identity to block). Zoom blocks this by default.
- Simplifications compared with Zoom:
  - The invite link's `pwd` is the plain passcode. Zoom uses an encoded token.
  - A host can leave without assigning a new host. Zoom asks the host to "Assign and leave". The host can hand over the role at any time with **Make Host**.
  - Rejoining with the host key gives the host role again, so after a transfer there can briefly be two hosts.
  - Mute All mutes only the people in the meeting at that moment.
  - Meeting info opens from the ⓘ title pill at the top-left. The meeting window shows only working controls: Chat, React, Share, Host tools and More are not built.
- Times are stored in UTC and shown in the browser's timezone.

---

## 9. Interview talking points

- **Why an SFU?** Use the bandwidth table in section 2.
- **Why is FastAPI separate from LiveKit?** Separation of concerns. The server owns business rules and permissions, and LiveKit only moves media. The token is a signed permission slip.
- **How does the server know who the host is without login?** The host key, as described in the schema section.
- **How do meetings end without webhooks?** Leave requests sent with `sendBeacon`, the last-participant rule, and the `list_rooms` cleanup for crashed clients.
- **Why have a participants table?** It supports guests, rejoins and the Recent list.
- **Meeting ID collisions?** The UNIQUE constraint, a rollback, and a retry. There are 9×10¹⁰ possible numbers.
- **Pitfalls:** forgetting `PRAGMA foreign_keys=ON`, timezone bugs (naive datetimes from SQLite), CORS between Vercel and the API, browser autoplay blocking audio, and camera permission being denied.
- **Originality:** use the LiveKit SDKs, including low-level pieces like `RoomAudioRenderer` and `VideoTrack`, but don't use the prebuilt conference UI or copy LiveKit's "Meet" example or any existing Zoom clone. Plagiarism means disqualification.
