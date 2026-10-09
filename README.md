# Fleetly License API

Cloudflare Worker behind `api.fleetlybots.com`.

- `GET /api/skills/<trigger>?key=<license>` — validates the buyer's license
  key against the `fleetly-licenses` KV namespace and returns the skill
  instructions. Invalid/missing key → 403 with a "get a license" message.
- `GET /api/health` — health check.

Skill content is embedded in `worker.js` (seeded from the Fleet Skills
registry). License keys live in KV as `license:<KEY>` →
`{"email","status":"active","created"}`. Deploys automatically on push.
