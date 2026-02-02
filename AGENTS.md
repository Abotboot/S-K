# AGENTS.md - Auth Server

## Commands
- **Start server**: `npm start` or `node server.cjs`
- **Install deps**: `npm install`
- **Docker build**: `docker build -t auth-server .`
- **Docker run**: `docker run -p 7860:7860 -e MONGO_URI=<uri> auth-server`

## Architecture
- **Stack**: Node.js 18+ / Express / MongoDB (Mongoose)
- **Entry point**: `server.cjs` (CommonJS module)
- **Database**: MongoDB Atlas with `Key` schema (key, note, hwid, expires)
- **Routes**: Admin API (`/api/*`), Lua script delivery (`/headless`, `/script`, `/safe`, `/chainsaw`), Dashboard (`/admin`), Linkvertise key gen (`/getkey`)

## Code Style
- CommonJS (`require`/`module.exports`), no ES modules
- Async/await for all DB operations
- Environment variables for secrets: `MONGO_URI`, `ADMIN_PASSWORD`, `PORT`
- Inline HTML templates for dashboard pages (no templating engine)
- Error handling: try/catch with JSON error responses for API, HTML for user-facing
