# Zoom Clone: web client

The Next.js app (App Router, TypeScript, Tailwind). Setup, settings and how the whole project fits together are in the [root README](../README.md).

```bash
npm install
copy .env.example .env.local   # macOS/Linux: cp .env.example .env.local
npm run dev                    # http://localhost:3000
```

| Path | What it is |
|---|---|
| `src/app/login` | Sign in and sign up |
| `src/app/page.tsx` | Dashboard (signed-in users) |
| `src/app/meetings/[number]` | Meeting details and "Copy Invitation" (signed-in users) |
| `src/app/j/[number]` | Invite link landing; forwards to `/wc/[number]` |
| `src/app/wc/[number]` | Pre-join screen, then the meeting room (guests welcome) |
| `src/lib/api.ts` | One fetch wrapper per API endpoint |
| `src/lib/auth.ts` | The signed-in user's token |

This project uses a recent Next.js with breaking changes; see `AGENTS.md` before changing routing or data fetching.
