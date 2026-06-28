# Love Letter: The Hobbit — Online Multiplayer

A real-time online card game for 2–4 players built with Node.js + Socket.io.

## Deploy on Render (free tier)

1. **Push to GitHub**
   - Create a new GitHub repo
   - Upload all these files (or `git push`)

2. **Create a Render Web Service**
   - Go to [render.com](https://render.com) → New → Web Service
   - Connect your GitHub repo
   - Settings:
     - **Environment:** Node
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Plan:** Free

3. **Deploy** — Render will give you a URL like `https://HLL.onrender.com`

## Keep it alive with UptimeRobot

Free tier on Render spins down after 15 min of inactivity.

1. Go to [uptimerobot.com](https://uptimerobot.com) → Add New Monitor
2. **Monitor Type:** HTTP(s)
3. **URL:** `https://your-app.onrender.com/ping`
4. **Interval:** Every 5 minutes

This pings the `/ping` endpoint to keep the server warm.

## How to play

1. Host creates a room and shares the 4-letter code (or the copy link button sends a direct join URL)
2. Friends open the link or enter the code + their name
3. Host taps **Start Game** when everyone has joined (2–4 players)
4. Players take turns on their own phones — no pass-and-play needed!
5. At round end, the host taps **Next Round**

## Cards

| Card | Value | Count | Effect |
|------|-------|-------|--------|
| The One Ring | 0 (→7) | 1 | No effect. Worth 7 at end of round |
| Smaug | 1 | 5 | Name a card — if target holds it, eliminated |
| Bard the Bowman | 2 | 2 | Peek at another player's hand |
| Legolas | 3 | 1 | Compare hands — lower card eliminated |
| Tauriel | 3 | 1 | Compare hands — higher card eliminated |
| Gandalf the Grey | 4 | 2 | Protected from effects until next turn |
| Fili & Kili | 5 | 2 | Target discards and redraws |
| Thorin Oakenshield | 6 | 1 | Trade hands |
| Bilbo Baggins | 7 | 1 | No effect (mandatory discard with 5 or 6) |
| Arkenstone | 8 | 1 | Highest card — eliminated if discarded |

## Tech Stack

- **Backend:** Node.js + Express + Socket.io
- **Frontend:** Vanilla HTML/CSS/JS (mobile-optimized)
- **No database** — all state in memory
