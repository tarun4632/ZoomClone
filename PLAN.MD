# Zoom Clone: design

How the app is built and why. This describes the code as it is; setup steps are in `README.md`.

## 1. Scope

**Built:**
- **Accounts:** sign up, sign in, sign out, and a one-click demo account with sample meetings.
- **Dashboard:** navbar with **Schedule / Join / New Meeting**, a profile card with a live clock, Upcoming and Recent lists, light and dark mode.
- **Instant meeting:** unique meeting ID, passcode and invite link, then straight to the meeting.
- **Join:** by meeting ID and passcode, or by invite link. A display name is required. Unknown IDs are rejected.
- **Schedule:** title, description, date and time, duration, video defaults. Saved, listed under Upcoming, with a details page and "Copy Invitation".
- **Meeting room:** real audio and video through LiveKit Cloud, a gallery grid, mic and camera toggles, a participants panel, leave and end.
- **Host controls:** mute all, mute one person, remove, make host, assign a new host on leaving, end for all.
- **Responsive layout** for phone, tablet and desktop.

**Not built:** waiting room (admit list), chat, reactions, screen share, speaker view, recordings, Personal Meeting ID, editing or cancelling a scheduled meeting, co-hosts, meeting lock, email verification, password reset, LiveKit webhooks.

---

## 2. Architecture

```
               ┌───────────────────────────────────┐
               │  client/  (Next.js, Vercel)       │
               │  Sign in · Dashboard · Pre-join   │
               │  · Meeting room                   │
               └───────┬───────────────────┬───────┘
          HTTPS REST   │                   │  WebRTC media + signaling
                       ▼                   ▼
 ┌──────────────────────────────┐   ┌─────────────────────────────┐
 │ server/  (FastAPI, Railway)  │   │ LiveKit Cloud (SFU)         │
 │  CONTROL PLANE               │   │  MEDIA PLANE                │
 │  • accounts and tokens       │──▶│  • receives 1 stream per    │
 │  • create / list meetings    │API│    publisher, forwards it   │
 │  • who may join, and as what │   │    to every subscriber      │
 │  • mints LiveKit tokens      │   │  • TURN for NAT traversal   │
 │  • host actions, host role   │   └─────────────────────────────┘
 └──────────────┬───────────────┘
                ▼
          SQLite (WAL)
```

**FastAPI never touches audio or video.** It decides who may join and with what role, then issues a signed LiveKit token. LiveKit Cloud moves the media.

### SFU concepts

| Topology | How it works | Upload per user (6 people, 1.5 Mbps) |
|---|---|---|
| Mesh (P2P) | Everyone sends to everyone | 5 × 1.5 = **7.5 Mbps**, breaks above about 4 people |
| MCU | Server decodes, mixes and re-encodes one stream | 1.5 Mbps, but very CPU-heavy on the server |
| **SFU** | Server forwards each stream without decoding | **1.5 Mbps**. This is the model Zoom, Meet and Teams use. |

- **Simulcast:** the publisher sends a few quality levels and the SFU picks one per viewer. In LiveKit this is one client flag.
- **TURN:** relays media when UDP is blocked. LiveKit Cloud provides it.
- **Why not write an SFU?** It is infrastructure, like a database. This app's own logic is meetings, permissions and host controls.

---

## 3. Repository layout

```
ZoomClone/
├── client/                 Next.js  → Vercel  (root directory: client)
├── server/                 FastAPI  → Railway (root directory: server)
├── .github/workflows/      CI: server tests; client type check, lint and build
├── README.md               setup, settings, how access works
└── PLAN.MD                 this document
```

---

## 4. Server (`server/`)

**Stack:** Python 3.14, FastAPI, SQLAlchemy 2, Pydantic v2 with pydantic-settings, `livekit-api`, pytest.

```
server/
├── app/
│   ├── main.py               app, CORS, routers; on startup: create tables, migrate, seed
│   ├── config.py             settings from env (DATABASE_URL, LIVEKIT_*, CLIENT_ORIGIN)
│   ├── database.py           engine, sessions, SQLite PRAGMAs, migrate()
│   ├── models.py             User, AuthToken, Meeting, MeetingParticipant
│   ├── schemas.py            request and response models (UTC datetimes with offset)
│   ├── deps.py               get_current_user (401 if not signed in), get_optional_user
│   ├── routers/
│   │   ├── auth.py           sign up, sign in, sign out
│   │   ├── users.py          GET /me
│   │   └── meetings.py       every meeting endpoint
│   ├── services/
│   │   ├── auth_service.py      password hashing, accounts, tokens
│   │   ├── meeting_service.py   create, list, join, leave, the one-host rule, cleanup
│   │   ├── livekit_service.py   the only module that talks to LiveKit
│   │   └── ids.py               meeting number, passcode, invite token, secrets
│   └── seed.py               demo users and meetings
└── tests/                    26 tests against a fake LiveKit and a throwaway database
```

Routers stay thin; the rules live in the services. Routes receive the LiveKit service through a dependency, so the tests replace it with a fake.

### Database schema

```
users 1───* auth_tokens
users 1───* meetings              (the owner, column host_id)
users 1───* meeting_participants  (nullable: guests have no account)
meetings 1───* meeting_participants
```

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  avatar_color  TEXT,
  password_hash TEXT,                              -- scrypt; NULL = cannot sign in
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_tokens (                         -- one row per sign-in
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                -- SHA-256 of the bearer token
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL
);

CREATE TABLE meetings (
  id                   TEXT PRIMARY KEY,           -- UUID; also the LiveKit room name
  meeting_number       TEXT NOT NULL UNIQUE,       -- 11 digits, shown as "123 4567 8901"
  host_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the owner
  title                TEXT NOT NULL,
  description          TEXT,
  meeting_type         TEXT NOT NULL CHECK (meeting_type IN ('instant','scheduled')),
  status               TEXT NOT NULL CHECK (status IN ('scheduled','live','ended')),
  scheduled_start_at   DATETIME,                   -- UTC
  duration_minutes     INTEGER CHECK (duration_minutes > 0),
  passcode             TEXT NOT NULL,              -- 6 letters and digits
  invite_token         TEXT NOT NULL,              -- random; the ?pwd= of the invite link
  host_video_on        BOOLEAN NOT NULL DEFAULT 1,
  participant_video_on BOOLEAN NOT NULL DEFAULT 1,
  started_at           DATETIME,
  ended_at             DATETIME,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (meeting_type = 'instant' OR scheduled_start_at IS NOT NULL)
);
CREATE INDEX ix_meetings_host_status_start ON meetings(host_id, status, scheduled_start_at);

CREATE TABLE meeting_participants (                -- one row per join
  id           INTEGER PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = guest
  display_name TEXT NOT NULL,
  identity     TEXT NOT NULL UNIQUE,               -- random UUID; the LiveKit identity
  role         TEXT NOT NULL CHECK (role IN ('host','attendee')),      -- current role
  status       TEXT NOT NULL CHECK (status IN ('joined','left','removed')),
  secret_hash  TEXT,                               -- SHA-256 of the participant secret
  joined_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at      DATETIME
);
CREATE INDEX ix_participants_meeting_status ON meeting_participants(meeting_id, status);
```

Design decisions:
- **Participants are separate from users.** Guests join without an account, and rejoining creates a new row. This table is what makes "Recent meetings" possible, and it is where the host role lives.
- **Two IDs per meeting.** The UUID is internal and is the room name. `meeting_number` is the human-facing ID.
- **Secrets are stored hashed.** Bearer tokens and participant secrets are random and returned once; the database keeps only their SHA-256. Passwords are salted scrypt hashes. A database leak exposes none of them.
- **The passcode is stored as it is,** because the owner has to be shown it.
- **Times are stored in UTC.** SQLite drops the time zone, so a column type re-attaches UTC on the way out (`2026-10-08T09:30:00Z`). Without that the browser would read times as local.
- **Status values are CHECK constraints,** because SQLite has no enum type.
- **SQLite settings:** `journal_mode=WAL`, `foreign_keys=ON` (SQLite ignores foreign keys without it), `busy_timeout`. One uvicorn worker.
- **Schema changes** are applied by `migrate()` on startup: it adds missing columns, drops removed ones, and fills in invite tokens for older meetings. It never drops data, so the database survives redeploys as long as it lives on a volume.

### Access: three proofs, one job each

| Proof | Who has it | What it allows |
|---|---|---|
| **Account token** | A signed-in user | The dashboard: listing, creating and viewing your own meetings. Starting a meeting you own. |
| **Passcode or invite token** | Anyone the owner shared it with | Joining that meeting as an attendee. |
| **Participant secret** | One participant, for one join | Leaving, asking for a sync, and the host actions while that participant's current role is host. |

- **Account tokens** are random strings sent as `Authorization: Bearer …`, valid for 30 days, and revoked by sign-out. Opaque tokens were chosen over JWTs: there is no signing key to configure, and a token can be revoked.
- **The invite link does not contain the passcode.** `?pwd=` carries the meeting's random invite token. It lets the holder in, as a link is meant to, but nothing about the passcode can be worked out from it. A hash of a 6-character passcode could be brute-forced; a random token has no relationship to it.
- **The participant's identity proves nothing.** Everyone in a call can see it, so every in-meeting request carries the participant secret too. Leaving sends it as a form-encoded body, which `navigator.sendBeacon` can send cross-origin without a CORS preflight while a tab is closing.
- **The owner needs no passcode** for their own meeting, whatever their role in it.
- **LiveKit tokens** carry no admin grant. Every host action goes through this server, which checks the current role.

### Meeting lifecycle (no webhooks)

- **Starting.** A meeting is `scheduled` until someone joins, then `live`.
  - **Scheduled meeting:** only its owner can start it. Anyone else gets 409 on `/join` and waits; the client joins automatically once it is live.
  - **Instant meeting:** anyone with the passcode or link can open it the first time.
- **Ending.** `live` → `ended` when the host clicks "End Meeting for All", or when the last participant leaves.
- **Restarting.** The owner can always restart an ended meeting. Others cannot:
  - ended scheduled meeting, its time not over yet: they wait for the owner again (409);
  - ended scheduled meeting, time over, or an ended instant meeting: 410 "This meeting has ended".
- **Stale meetings.** A crashed browser sends no leave, which could leave a meeting `live` for ever. Before answering `GET /meetings`, the server asks LiveKit for its rooms once and ends any meeting that has been live for over 2 minutes with no room.
- **Upcoming** is decided by the schedule, not by status: scheduled meetings whose end time is still ahead, plus any that are live. Ordered by start time; live ones are labelled "In progress".
- **Recent:** ended meetings the user owns or attended while signed in, newest first, 50 at most.

### One host at a time

The host role is a column on the participant row, and at most one joined row holds it.

- **Who is host first.** The owner, when they join and nobody else holds the role.
- **Make Host** swaps the role between two rows. LiveKit metadata is updated first; if that fails the database is left unchanged (502).
- **A host who leaves assigns a successor.** "Leave Meeting" opens an "Assign a new host" box, as in Zoom. The client calls Make Host, then leave. A host alone in the meeting just leaves, and it ends.
- **The role does not come back.** An owner who rejoins while someone else is host is an attendee like anyone. The one exception is the owner's own earlier session (a second tab, or a tab that died): the newer session takes the role from it.
- **A host who leaves without choosing** (closed tab, refresh, crash) is replaced automatically:
  - nobody is promoted for 20 seconds, so a refresh does not cost the host their role;
  - then the system picks someone connected: the owner if they are in the call, otherwise whoever has been in the meeting longest.
- **A meeting that never had a host gets none by default.** An instant meeting opened by a guest stays hostless until its owner joins.

`POST /meetings/{number}/sync` is what makes the automatic cases work without webhooks. The clients in the room call it when LiveKit reports that a host dropped out, after a reconnect, and every 10 seconds while no host is visible. The server then compares its participant rows with LiveKit's list:
- a joined row LiveKit no longer lists has left (rows under 30 seconds old are spared; that browser may still be connecting);
- a left row LiveKit lists again has come back;
- more than one host is reduced to one;
- no host, and the last one has been gone 20 seconds: a successor is picked;
- anyone whose LiveKit role label disagrees with the database is corrected.

The check is only trusted from a caller who is connected, and it gives the caller no say in the outcome.

### Host actions

- **Mute one / Mute All** force-mute published audio tracks through LiveKit. They never unmute; there is no unmute endpoint, so only the person can unmute themselves. Mute All skips the host and applies to the people present at that moment.
- **Remove** disconnects the person and marks their row `removed`. The host cannot be removed.
- **End Meeting for All** deletes the LiveKit room and marks the meeting ended. If LiveKit cannot delete the room, nothing changes (502).

### API (`/api`)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/health` | anyone | Health check for the deploy |
| POST | `/auth/signup` | anyone | Create an account; returns a bearer token and the user |
| POST | `/auth/login` | anyone | Sign in; same response. Same 401 for unknown email and wrong password |
| POST | `/auth/logout` | signed in | Revoke the token it was called with |
| GET | `/me` | signed in | The signed-in user |
| GET | `/meetings?scope=upcoming\|recent` | signed in | Dashboard lists. Runs the stale-meeting cleanup first |
| POST | `/meetings/instant` | signed in | New instant meeting, titled "{name}'s Zoom Meeting" |
| POST | `/meetings` | signed in | Schedule a meeting |
| GET | `/meetings/{number}` | anyone | Public info for the join screen: title, host name, type, status, start time, video defaults, and whether the caller owns it |
| GET | `/meetings/{number}/details` | owner, or signed-in attendee | Everything above plus passcode, invite link and schedule. 404 for anyone else |
| POST | `/meetings/{number}/join` | anyone | `{display_name, passcode? \| invite_token?}` → LiveKit token, role, participant secret. 403 wrong passcode, 409 not started, 410 ended |
| POST | `/meetings/{number}/participants/{identity}/leave` | that participant | Form body `participant_secret=…`. Safe to call twice |
| POST | `/meetings/{number}/sync` | any participant | Re-check the participant rows against LiveKit |
| POST | `/meetings/{number}/end` | host | End for all |
| POST | `/meetings/{number}/mute-all` | host | Mute everyone but the host |
| POST | `/meetings/{number}/participants/{identity}/mute` | host | Mute one person |
| POST | `/meetings/{number}/participants/{identity}/remove` | host | Remove one person |
| POST | `/meetings/{number}/participants/{identity}/make-host` | host | Hand the host role to that person |

The participant, sync and host routes take the caller's own `{identity, participant_secret}`. "Host" means that participant row is joined and its current role is `host`.

Every meeting route is `async def` and runs its short SQLite queries inline. With one worker, the stretches between awaits never interleave, which is what makes the role changes safe without locks. The sign-in routes are plain `def`, so the deliberately slow password hashing runs in FastAPI's thread pool instead of blocking the others.

### Seed data

- **Once, when the database is empty:** three users and five ended meetings with participants, for Recent. One is hosted by another user with the demo user attending; one involves neither, so it must not appear.
- **Demo account:** `alex.johnson@example.com` / `zoomclone-demo`. The password is public on purpose.
- **Top-up:** on startup and before the demo user's Upcoming list, the server makes sure that account has three scheduled meetings ahead, so the list is never empty however long the service runs. Other accounts get no demo data.

### Tests

26 backend tests, with LiveKit replaced by a fake and a throwaway SQLite file:
- creating and listing meetings; unknown IDs;
- joining by passcode, invite token and owner account; who may start a scheduled or instant meeting; restart rules;
- leaving, and that leave needs the participant's own secret;
- muting (the same for both meeting types), make host, remove, end;
- the one-host rule: assigning a successor, the owner not getting the role back, the 20-second grace, the owner's second tab, a host who vanishes, a connection that recovers;
- accounts, tokens, who can see which meetings, and upgrading an older database.

The client is checked by the type checker, the linter and the production build. CI runs all of it on every push and pull request.

---

## 5. Client (`client/`)

**Stack:** Next.js 16 (App Router) with React 19 and TypeScript, Tailwind 4, `livekit-client` with `@livekit/components-react`, date-fns, lucide-react.

```
client/src/
├── app/
│   ├── layout.tsx                  fonts, theme script
│   ├── login/page.tsx              sign in and sign up
│   ├── page.tsx                    dashboard                    (signed in)
│   ├── meetings/[number]/          details, Copy Invitation     (signed in)
│   ├── j/[number]/page.tsx         invite link → /wc/[number]?pwd=…
│   └── wc/[number]/page.tsx        pre-join, then the meeting room (guests welcome)
├── components/
│   ├── auth/         RequireAuth, AuthIllustration
│   ├── dashboard/    Navbar, AccountMenu, ActionCard, ProfileCard, MeetingList,
│   │                 JoinMeetingModal, ScheduleMeetingModal, ThemeToggle
│   ├── meeting/      PreJoin, MeetingRoom, VideoGrid, VideoTile, Toolbar,
│   │                 ParticipantsPanel, LeaveMenu, MeetingInfo, status screens
│   └── ui/           Button, Modal, Avatar, Card, Field, Spinner
└── lib/
    ├── api.ts               one fetch wrapper per endpoint; adds the bearer token
    ├── auth.ts              the token in localStorage, and a hook to read it
    ├── types.ts             the API contract, mirroring server/app/schemas.py
    ├── parseMeetingInput.ts "123 4567 8901" or a full invite URL → number and token
    ├── invitation.ts        the Copy Invitation text
    └── format.ts, session.ts, theme.ts
```

- **State:** `useState` and `useEffect` plus LiveKit's own room state. No global store, no data-fetching library.
- **Single-page app:** every page is a client component that fetches in the browser.
- **From LiveKit's React package** the app uses only the hooks, `RoomAudioRenderer` (plays everyone's audio) and `VideoTrack`. Every visible control is its own.

### Sign-in and the token

- The token is kept in `localStorage` and sent as a bearer header. The API is on another origin, where a cookie would be a third-party cookie; the cost is that script on the page could read the token.
- `RequireAuth` wraps the dashboard and details pages: no token means `/login?next=…`. A 401 from the API forgets the token, which has the same effect. This only decides what the browser shows; the API enforces access.
- **Sign-in screens** follow Zoom's: a top bar that switches between Sign In and Sign Up, an illustrated panel, one short form. Sign-up is email first, then name and password. The demo account sits where Zoom puts its sign-in providers.
- **Account menu** (the navbar avatar): name and email, Profile (read-only), Settings (light or dark), Sign out.

### Dashboard

- **Navbar:** logo, Schedule / Join / New Meeting, the theme toggle, the avatar menu. On phones the three actions become icons.
- **Two columns of cards;** one column on phones, action card first.
  - Profile card with the live clock and date.
  - Action card: Schedule, Join, New Meeting.
  - Meetings card: Upcoming, grouped under Today / Tomorrow / dates. An empty Today group says "No upcoming meetings today". The owner sees Start, or Join when it is live.
  - Recent card, with an empty state.
- **Join modal:** meeting ID or invite link, and a name. "Invalid meeting ID" for unknown IDs.
- **Schedule modal:** topic (pre-filled "{Name}'s Zoom Meeting"), description, date, time, duration, host and participant video on/off, and a read-only label for the browser's time zone. Saving opens the details page.
- **Light and dark mode:** the OS setting until the user chooses; the choice is saved. An inline script applies it before first paint so the page never flashes. The meeting room stays dark in both.

### Pre-join (`/wc/[number]`)

- Camera preview with mic and camera toggles. The camera starts from the meeting's host or participant video default.
- Name, pre-filled from the Join modal or the signed-in account.
- A passcode field only when there is no invite token and the visitor is not the owner.
- **Scheduled meeting not started:** the screen says so with the scheduled time. After Join it shows "Waiting for the host to start this meeting", checks every 4 seconds, and joins the moment the meeting is live.
- Cancel releases the camera and mic.

### Meeting room

- Near-black stage with a gallery grid that picks the column count giving the largest tiles. A name label on each tile, a slashed mic when muted, a green border while speaking, initials when the camera is off.
- A title pill at the top-left opens meeting info: ID, host, passcode, invite link.
- **Toolbar:** Mute, Stop Video, Participants with a count, and a red End (host) or Leave (everyone else).
- **Participants panel:** "(Host)" and "(me)" labels read live from LiveKit metadata. For the host:
  - clicking someone's microphone icon mutes them; a muted icon is not clickable;
  - a More menu with Make Host and Remove, each with a confirmation;
  - Mute All in the footer.
- **Leave menu:** the host gets "End Meeting for All" and "Leave Meeting"; with others in the call, Leave opens "Assign a new host".
- **Notices** when the host role moves: "You are now the host", "{name} is now the host", "You are no longer the host".
- **End states:** removed by the host, ended by the host, disconnected, could not connect.

### Things that are easy to get wrong

- **Tracks are created once.** Pre-join's camera and mic tracks are handed to the room and published as they are. Opening the camera a second time can fail on Windows.
- **Mic off is muted, camera off is released.** Muting keeps the device open so unmuting is instant; stopping the camera turns its light off.
- **Button state comes from LiveKit,** never from separate state, so a server-side mute flips the button to "Unmute" by itself.
- **React Strict Mode** runs effects twice in development. Connecting and opening devices are guarded so they happen once, and "really unmounted" is told apart from the simulated unmount.
- **Next.js keeps a page alive after you navigate away** and shows it again on Back, state and all. Pages reset what should not survive: the meeting page returns to a fresh pre-join (not the room you left), the sign-in page clears its fields, open menus and modals close.
- **Leaving on tab close** uses `pagehide` with `sendBeacon`, which fires more reliably than `beforeunload`, especially on phones.
- **Browsers block audio until a click.** A "Click to enable audio" button appears when needed.
- **LiveKit's own logs** are turned down to warnings, so the console stays quiet.

### Invitation text (Copy Invitation)

```
{host name} is inviting you to a scheduled Zoom meeting.

Topic: {title}
Time: {start in the browser's time zone, e.g. "Oct 9, 2026 10:00 AM GMT+5:30"}

Join Zoom Meeting
{invite link}

Meeting ID: {123 4567 8901}
Passcode: {passcode}
```

An instant meeting has no `Time:` line and says "is inviting you to a Zoom meeting."

---

## 6. Main flows

**New Meeting**
1. `POST /meetings/instant`, then go to `/wc/{number}`
2. Pre-join: name pre-filled, no passcode field (the server recognises the owner by their sign-in)
3. `POST /join` → host token
4. Connect to LiveKit and publish the preview tracks

**Join by invite link**
1. `/j/{number}?pwd={invite token}` → `/wc/{number}?pwd=…`
2. `GET /meetings/{number}`
3. Pre-join: name only
4. `POST /join` with the invite token → attendee token

**Join by meeting ID**
1. Join modal → `parseMeetingInput` → `GET /meetings/{number}` (404 means "Invalid meeting ID")
2. Pre-join: name and passcode
3. `POST /join` with the passcode → attendee token

**Schedule, then start**
1. Modal → `POST /meetings` (local time converted to UTC) → details page
2. A guest who opens the link early waits: `POST /join` → 409, then poll `GET /meetings/{number}`
3. The owner clicks Start → `POST /join` → the meeting is live → the waiting guest's join goes through

**Host leaves**
1. Leave Meeting → "Assign a new host" → `POST /make-host` → `POST /leave`
2. Everyone's labels and controls update through LiveKit metadata

**Host disappears**
1. LiveKit reports the participant gone → the others call `POST /sync`
2. After 20 seconds without a host, a sync promotes a successor

---

## 7. Deployment and CI

| Piece | Where | Notes |
|---|---|---|
| Client | **Vercel**, root directory `client` | `NEXT_PUBLIC_API_URL` is baked in at build time |
| Server | **Railway**, root directory `server`, with a volume for the SQLite file | `DATABASE_URL` (a path on the volume), `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `CLIENT_ORIGIN`. One uvicorn worker |
| Media | **LiveKit Cloud** | URL, key and secret go in the server's settings |
| CI | **GitHub Actions** | Server tests; client type check, lint and build. On every push to `main` and every pull request |

- Both hosts redeploy on every push to `main`. CI reports on a commit but does not hold a deploy back.
- `CLIENT_ORIGIN` lists the allowed origins for CORS; the first one is used to build invite links.
- The database upgrades itself on startup and is never rebuilt, so data survives redeploys.
- The camera needs HTTPS everywhere except `localhost`.

---

## 8. Assumptions and limitations

- **Sign-in is required for the dashboard.** The brief says to assume a default user; the demo account is that user, one click away, and guests never need an account to join.
- **A removed participant can rejoin** with the same link. Nothing ties a guest to a device.
- **An owner who gave the host role away cannot end their own meeting** unless the current host hands it back.
- **Replacing a host who left without choosing takes time:** 20 seconds after a closed tab, closer to a minute after a crash, because LiveKit first has to give up on the connection.
- **Instant meetings can be opened by anyone with the link** before their owner arrives. Nobody is host until the owner joins.
- **Mute All covers the people present** when it is clicked, not those who join later.
- **The account token is in `localStorage`,** readable by any script on the page.
- **No sign-in rate limiting, email verification or password reset.**
- **No backups.** The data is one SQLite file on one volume.
- **One server process.** SQLite and the lock-free role changes both assume it.

---

## 9. Interview talking points

- **Why an SFU?** The bandwidth table in section 2.
- **Why is FastAPI separate from LiveKit?** The server owns rules and permissions; LiveKit only moves media. The LiveKit token is a signed permission slip.
- **How does the server know who someone is?** Three proofs for three jobs: the account token for the dashboard, the passcode or invite token for getting into a meeting, the participant secret for acting inside it.
- **Why opaque tokens instead of JWTs?** Sign-out really revokes them, there is no signing key to leak or forget to set, and one indexed lookup per request is nothing for SQLite.
- **Why is the invite token random, not a hash of the passcode?** Six characters can be brute-forced from a hash. A random token reveals nothing.
- **Why does leaving need a secret?** Identities are visible to everyone in the room. Without it, any attendee could make the host "leave", stripping their role and ending the meeting.
- **How is there never more than one host?** The role only ever moves between rows: Make Host swaps it, joining takes it only when nobody else holds it, and the sync reduces any double to one.
- **How do meetings and hosts recover without webhooks?** Leave requests through `sendBeacon`, the last-participant rule, the clients' sync when LiveKit reports someone gone, and the room-list cleanup for meetings nobody is left in.
- **Why a 20-second wait before replacing a host?** A page refresh is a leave followed by a join. Without the wait, refreshing would hand the meeting to someone else for good.
- **Why a participants table?** Guests, rejoins, the Recent list, and a place for the role and the secret.
- **Meeting ID collisions?** A UNIQUE constraint, a rollback and a retry, out of 9×10¹⁰ numbers.
- **Pitfalls met:** SQLite ignoring foreign keys without the PRAGMA, naive datetimes shifting times by hours, CORS between two hosts, browsers blocking audio, Next.js restoring a dead meeting screen on Back, and npm versions disagreeing about the lockfile in CI.
- **Originality:** LiveKit's SDK and low-level pieces are used; its prebuilt conference UI and example apps are not.
