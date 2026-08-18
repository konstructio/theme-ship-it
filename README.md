# Ship It! — a theme theme

The retro arcade take on platform engineering: planets are zones, rockets are
apps, and your hero levels up by actually shipping software. This is the Claude
Design prototype served verbatim, wired to the theme by
`static/theme-bridge.js` — the game code itself is untouched.

Launched from Konstruct's Themes registry, it plays against your real
organization: claiming a planet creates a zone, registering an app creates a
real ThemedApp deployment, and your hero (XP, quests, gear) persists in your
Character CR across browsers and themes. Opened standalone it falls back to the
original localStorage prototype.

## Running locally

```bash
go run main.go
# open http://localhost:8080
```

## Deploying via Konstruct

Register this repo as a theme theme in the Themes settings page. The
platform builds it with kpack, serves it behind the theme infrastructure, and
opens it in the Konstruct shell with your session token.

## API contract

All platform calls go through `static/theme.js`, which reads the auth token
from the URL fragment (passed by the Konstruct launcher) and calls the
`/api/v1/theme/*` endpoints. The bridge (`static/theme-bridge.js`) maps
game actions to real API calls:

| Game action | API call |
|---|---|
| Claim planet | `POST /theme/zones/{org}` |
| Register app | `POST /theme/app` |
| Scale replicas | `PATCH /theme/app/{org}/{name}` |
| Relaunch | `POST /theme/app/{org}/{name}/redeploy` |
| Save hero | `PUT /theme/character/{org}` |
| Poll app status | `GET /theme/apps/{org}` (every 15s) |
| List org repos | `GET /konstruct-application/{org}` |
