# Zoom Clone

A browser video-meeting app modelled on Zoom: sign in, start an instant meeting, schedule one for later, or join by meeting ID or invite link. Audio and video are real, carried by LiveKit.

- **`client/`** is the web app: Next.js (App Router), TypeScript and Tailwind.
- **`server/`** is the API: FastAPI, SQLAlchemy and SQLite.
- **LiveKit Cloud** carries the media. The server never touches audio or video. It decides who may join and in what role, then hands the browser a signed LiveKit token.

```
 Browser (Next.js) ── REST ──▶ FastAPI ── admin API ──▶ LiveKit Cloud
        │                        │                           ▲
        │                      SQLite                        │
        └──────────── WebRTC audio and video ────────────────┘
```

## What it does

- **Accounts.** Sign up, sign in, sign out. A demo account with sample meetings is one click away on the sign-in page.
- **Dashboard.** New Meeting, Join and Schedule, plus Upcoming and Recent lists. It has light and dark mode and works on a phone.
- **Meetings.** Each has an 11-digit ID, a passcode and an invite link. Scheduled meetings have a details page with "Copy Invitation".
- **Guests.** Anyone with an invite link, or the meeting ID and passcode, can join without an account.
- **Scheduled meetings start with their owner.** Someone who arrives early sees "Waiting for the host to start this meeting" and is let in automatically when it starts.
- **Meeting room.** Camera and mic preview before joining, a gallery grid, mute and video toggles, and a participants panel.
- **Host controls.** Mute all, mute one person, remove someone, make someone else host, and end the meeting for everyone.
- **One host at a time.** A host who leaves picks who takes over ("Assign a new host"), and does not get the role back by returning. If the host just closes the tab or drops off, the system picks a successor after a short wait.

## Run it locally

You need Python 3.14, Node.js 24, and a free [LiveKit Cloud](https://cloud.livekit.io) project.

**1. Server**

```bash
cd server
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
copy .env.example .env            # macOS/Linux: cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Put your LiveKit project's URL, API key and API secret in `server/.env` (LiveKit Cloud → Settings → Keys). Without them the server still starts, and logs a warning, but nobody can connect to a call.

**2. Client**

```bash
cd client
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
npm run dev
```

Open http://localhost:3000 and choose **Use the demo account**, or create your own.

To try a call with two people on one machine, open the invite link in a private window. That second window is a guest.

### Settings

| File | Variable | What it is |
|---|---|---|
| `server/.env` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Your LiveKit project. |
| `server/.env` | `DATABASE_URL` | SQLite file. Defaults to `sqlite:///./zoom.db`. |
| `server/.env` | `CLIENT_ORIGIN` | The client's address, for CORS. Several are comma-separated. The first one is used to build invite links. |
| `client/.env.local` | `NEXT_PUBLIC_API_URL` | The server's address. It is baked in when the client is built. |

### Demo account

| Email | Password |
|---|---|
| `alex.johnson@example.com` | `zoomclone-demo` |

The password is public on purpose, so anyone can try the app. The demo account always has a few upcoming meetings; new accounts start empty.

## Tests

```bash
cd server
pytest
```

The tests cover the API with LiveKit replaced by a fake: meeting lifecycle, join rules, host controls, who may start a meeting, the one-host rule and host succession (including a host who vanishes without leaving), accounts, and upgrading an older database.

```bash
cd client
npx tsc --noEmit && npm run lint && npm run build
```

The client has no unit tests. It is checked by the type checker, the linter, the production build, and by hand in the browser.

Both sets of checks run on GitHub for every push to `main` and every pull request (`.github/workflows/ci.yml`). They report on a commit; they do not hold back a deploy.

## How access works

There are three separate proofs, each for one job.

| Proof | Who has it | What it allows |
|---|---|---|
| **Account token** | A signed-in user | The dashboard: listing, creating and viewing your own meetings. Starting a meeting you own, which makes you its first host. |
| **Passcode or invite link** | Anyone the host shared it with | Joining that meeting as an attendee. |
| **Participant secret** | One participant, for one join | Leaving, and the host controls while that participant is currently a host. |

Some details worth knowing:

- **Passwords** are stored as salted scrypt hashes.
- **Account tokens** are random strings sent as `Authorization: Bearer …`. The server keeps only their SHA-256 hash, they last 30 days, and signing out revokes them.
- **The invite link does not contain the passcode.** Its `?pwd=` value is a separate random token for that meeting. It lets the holder in, as the link is meant to, but the passcode cannot be worked out from it.
- **Host powers follow the participant's current role**, not the account. That is what lets "Make Host" work for a guest, and what removes the powers from someone who hands the role over.
- **Leaving needs the participant secret.** Participant IDs are visible to everyone in a call, so an ID alone must not be enough to make someone else "leave".

## Deployment

The client is built for Vercel (root directory `client`) and the server for Railway (root directory `server`, with a volume for the SQLite file). See `server/railway.json` and `server/Procfile`.

- Set `NEXT_PUBLIC_API_URL` on Vercel before building.
- Set `CLIENT_ORIGIN` on Railway to the client's URL.
- Run **one** server process. SQLite and the route design both assume it.
- The database upgrades itself on start (`migrate()` in `server/app/database.py`).

## Known limitations

- **Removed participants can rejoin** with the same link. Nothing ties a guest to a device.
- **No sign-in rate limiting, email verification or password reset.**
- **The account token is kept in the browser's `localStorage`.** That is simple and works across the two origins, but script injected into the page could read it.
- **Replacing a host who leaves without choosing takes a little while.** The meeting waits 20 seconds so that a refresh does not cost the host their role, and a crashed browser is only noticed once LiveKit gives up on its connection, so that case takes closer to a minute.
- **An owner who gave the host role away is an ordinary attendee** when they return, and cannot end their own meeting unless the current host hands the role back.
- **Instant meetings can be opened by anyone with the link** before their owner arrives (scheduled ones cannot). Nobody is host until the owner joins.
- **Not built:** chat, screen share, waiting room, recordings, editing or cancelling a scheduled meeting.

`PLAN.MD` is the original design document. Its first section lists what has changed since it was written.
