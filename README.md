# Clinic Booking API

Koya Cohort 4 assessment, Task 1. Node + Express + Postgres, with a small web page at `/`.

## Run locally

```bash
npm install
API_KEY=secret DATABASE_URL=postgres://user:pass@localhost:5432/clinic npm start
API_KEY=secret npm test      # integration tests against http://localhost:3000
```

## Environment

| Var | Purpose |
| --- | --- |
| `API_KEY` | Value clients must send in the `X-API-Key` header |
| `DATABASE_URL` | Postgres connection string (Neon / Supabase / Render) |
| `PORT` | Set automatically by most hosts |

## How each level is handled

1. **Level 1:** `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/:id`.
2. **Level 2:** API key middleware runs first (401). Booking validation gives 400/404, trims name and email, lower-cases email, and rejects slots that have already started.
3. **Level 3:** A partial unique index (`UNIQUE (slot_id) WHERE status='confirmed'`) means Postgres itself refuses a second confirmed booking. `INSERT … ON CONFLICT DO NOTHING` turns that into a 409, so it holds under concurrent requests and across multiple instances. `DELETE /bookings/:id` cancels and frees the slot.
4. **Level 4:** `Idempotency-Key` is stored with a hash of the body and the response. Requests with the same key are serialised using a Postgres advisory lock, so parallel retries still produce one booking. A different body returns 422. `GET /bookings` uses cursor pagination, oldest first.
5. **Level 5:** At most 5 attempts per email per 60 s, counted in Postgres (so it survives restarts and works across instances). Failed attempts count. The 6th gets 429 with `Retry-After` in whole seconds.

## Deploy (free)

1. Create a Neon (or Supabase) Postgres database and copy its connection string.
2. Push this repo to GitHub, then create a Render **Web Service** from it (it reads `render.yaml`).
3. Set `API_KEY` and `DATABASE_URL` in the Render environment.
