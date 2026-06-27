# chtkay — anonymous chat (refined)

A small Omegle-style 1-on-1 random chat. Node + Express + Socket.IO, optional MongoDB.

## Run locally
```bash
npm install
cp .env.example .env      # then edit .env
npm start                 # http://localhost:3000
```
Open two browser tabs to test matching. `GET /health` shows live status.

## Deploy
Set the env vars (`ADMIN_SECRET`, optional `MONGO_URI`, `ALLOWED_ORIGIN`) in your host's
dashboard. `Procfile` for Heroku-style hosts:
```
web: node server.js
```
Point your domain straight at the app — don't redirect chtkay.com to a herokuapp URL
like the old build did.

## What changed from the old version
- **Secrets** come from env vars. No credentials in code. Rotate any old ones — they leaked.
- **Privacy:** message text is no longer saved. Only a report count and ad-click count
  (if Mongo is on). Less data = less liability.
- **Honest online count** by default (`ONLINE_BOOST=0`). The old build added a fake +275.
- **18+ gate** before matching, a **Report** button, and light scrubbing of HTML and
  long digit runs (discourages sharing phone numbers).
- Admin endpoint needs a real secret: `/admin/stats?secret=YOUR_SECRET`.

## Safety — read this, it's the real risk
Anonymous stranger chat attracts abuse and, critically, can put minors in contact with
adults. Omegle shut down over exactly this. If chtkay gets traction you need:
- Active **moderation** — watch reports daily, ban fast.
- A clear **terms + safety page** and a way for people to report off-platform.
- Realistically, **age verification** is weak with just a checkbox. Treat 18+ as a
  promise you actively enforce, not a formality.
- Keep **logging minimal** but enough to act on reports and cooperate with authorities
  if something serious happens.

Don't relaunch this widely until you're ready to moderate it.

## Sponsors
Edit the `ADS` array near the bottom of `public/index.html`. Each entry is text + an
Instagram link + a short business key for click counting.
