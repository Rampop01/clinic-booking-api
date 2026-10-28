"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("API_KEY env var is required");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 30,
});

const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ───────────────────────── schema ─────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id        TEXT PRIMARY KEY,
      provider  TEXT NOT NULL,
      start_at  TIMESTAMPTZ NOT NULL,
      end_at    TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq        BIGSERIAL PRIMARY KEY,
      id         TEXT UNIQUE NOT NULL,
      slot_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Level 3: the database itself guarantees one confirmed booking per slot.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
    CREATE TABLE IF NOT EXISTS idempotency (
      key           TEXT PRIMARY KEY,
      body_hash     TEXT NOT NULL,
      status_code   INT NOT NULL,
      response_body JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id    BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      ts    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS attempts_email_ts ON attempts (email, ts);
  `);
}

// ───────────────────────── helpers ─────────────────────────
const bookingJson = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
});

const slotJson = (r) => ({
  id: r.id,
  provider: r.provider,
  start: new Date(r.start_at).toISOString(),
  end: new Date(r.end_at).toISOString(),
  available: r.available,
});

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

const hashBody = (body) => crypto.createHash("sha256").update(stableStringify(body)).digest("hex");

const asyncH = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ───────────────────────── app ─────────────────────────
const app = express();
app.disable("x-powered-by");

// The web page is public (it asks the user for the key); everything else needs the key.
app.use(express.static(path.join(__dirname, "public")));

// Level 2: API key check runs before anything else (including body parsing).
app.use((req, res, next) => {
  const key = req.get("X-API-Key");
  if (!key || key !== API_KEY) return res.status(401).json({ error: "missing or invalid API key" });
  next();
});

app.use(express.json({ limit: "1mb" }));

// CORS so the page works wherever it is hosted.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});

// Level 1: replace all slots (also wipes bookings and per-request state)
app.post(
  "/reset",
  asyncH(async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots)) return res.status(400).json({ error: "slots must be an array" });
    for (const s of slots) {
      if (
        !s ||
        !isNonEmptyString(s.id) ||
        !isNonEmptyString(s.provider) ||
        isNaN(Date.parse(s.start)) ||
        isNaN(Date.parse(s.end))
      ) {
        return res.status(400).json({ error: "each slot needs id, provider, start and end" });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE bookings, slots, idempotency, attempts");
      for (const s of slots) {
        await client.query(
          "INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, start_at=EXCLUDED.start_at, end_at=EXCLUDED.end_at",
          [s.id, s.provider, s.start, s.end]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.status(200).json({ ok: true, slots: slots.length });
  })
);

// Level 1: list slots
app.get(
  "/slots",
  asyncH(async (req, res) => {
    const params = [];
    let where = "";
    if (typeof req.query.provider === "string") {
      params.push(req.query.provider);
      where = "WHERE s.provider = $1";
    }
    const { rows } = await pool.query(
      `SELECT s.*, NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
       ) AS available
       FROM slots s ${where}
       ORDER BY s.start_at ASC, s.id ASC`,
      params
    );
    res.json({ slots: rows.map(slotJson) });
  })
);

// Level 5: at most 5 attempts per email per minute (failed attempts included)
async function checkRateLimit(client, email) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["rl:" + email]);
  await client.query(
    "DELETE FROM attempts WHERE email = $1 AND ts < now() - make_interval(secs => $2)",
    [email, RATE_WINDOW_SECONDS]
  );
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            CEIL(EXTRACT(EPOCH FROM (min(ts) + make_interval(secs => $2) - now())))::int AS wait
     FROM attempts WHERE email = $1`,
    [email, RATE_WINDOW_SECONDS]
  );
  if (rows[0].n >= RATE_LIMIT) {
    return { limited: true, retryAfter: Math.max(1, rows[0].wait || 1) };
  }
  await client.query("INSERT INTO attempts (email) VALUES ($1)", [email]);
  return { limited: false };
}

// Core booking logic: returns { status, body }. Runs inside a transaction.
async function createBooking(client, body) {
  const slotId = body.slot_id;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!isNonEmptyString(slotId)) return { status: 400, body: { error: "slot_id is required" } };
  if (!name) return { status: 400, body: { error: "name is required" } };
  if (!email) return { status: 400, body: { error: "email is required" } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: "email is not valid" } };

  const slotRes = await client.query("SELECT *, (start_at <= now()) AS started FROM slots WHERE id = $1", [
    String(slotId),
  ]);
  if (slotRes.rowCount === 0) return { status: 404, body: { error: "slot not found" } };
  if (slotRes.rows[0].started) return { status: 400, body: { error: "slot has already started" } };

  const id = crypto.randomUUID();
  const ins = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1,$2,$3,$4,'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [id, String(slotId), name, email]
  );
  if (ins.rowCount === 0) return { status: 409, body: { error: "slot already booked" } };
  return { status: 201, body: bookingJson(ins.rows[0]) };
}

// Levels 1–5: book a slot
app.post(
  "/bookings",
  asyncH(async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body) return res.status(400).json({ error: "body must be a JSON object" });

    const idemKey = req.get("Idempotency-Key");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (idemKey) {
        // Serialise requests carrying the same key so a retry can never double-book.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["idem:" + idemKey]);
        const bodyHash = hashBody(body);
        const prev = await client.query("SELECT * FROM idempotency WHERE key = $1", [idemKey]);
        if (prev.rowCount > 0) {
          await client.query("COMMIT");
          if (prev.rows[0].body_hash !== bodyHash) {
            return res.status(422).json({ error: "Idempotency-Key was already used with a different body" });
          }
          return res.status(prev.rows[0].status_code).json(prev.rows[0].response_body);
        }
      }

      // Level 5: count every new attempt that names an email, valid or not.
      if (typeof body.email === "string" && body.email.trim()) {
        const rl = await checkRateLimit(client, body.email.trim().toLowerCase());
        if (rl.limited) {
          await client.query("ROLLBACK");
          res.set("Retry-After", String(rl.retryAfter));
          return res.status(429).json({ error: "too many booking attempts, slow down" });
        }
      }

      const result = await createBooking(client, body);
      if (idemKey) {
        const bodyHash = hashBody(body);
        await client.query(
          "INSERT INTO idempotency (key, body_hash, status_code, response_body) VALUES ($1,$2,$3,$4)",
          [idemKey, bodyHash, result.status, JSON.stringify(result.body)]
        );
      }
      await client.query("COMMIT");
      return res.status(result.status).json(result.body);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// Level 4: list a person's bookings with cursor pagination (oldest first)
app.get(
  "/bookings",
  asyncH(async (req, res) => {
    const emailRaw = req.query.email;
    if (typeof emailRaw !== "string" || !emailRaw.trim()) {
      return res.status(400).json({ error: "email is required" });
    }
    let limit = 10;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== "string" || !/^\d+$/.test(req.query.limit)) {
        return res.status(400).json({ error: "limit must be an integer from 1 to 50" });
      }
      limit = parseInt(req.query.limit, 10);
      if (limit < 1 || limit > 50) {
        return res.status(400).json({ error: "limit must be an integer from 1 to 50" });
      }
    }
    let after = 0;
    if (req.query.cursor !== undefined) {
      const decoded = Buffer.from(String(req.query.cursor), "base64url").toString("utf8");
      if (!/^\d+$/.test(decoded)) return res.status(400).json({ error: "invalid cursor" });
      after = parseInt(decoded, 10);
    }
    const { rows } = await pool.query(
      `SELECT * FROM bookings
       WHERE lower(email) = lower($1) AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [emailRaw.trim(), after, limit + 1]
    );
    const page = rows.slice(0, limit);
    const next_cursor =
      rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url") : null;
    res.json({ bookings: page.map(bookingJson), next_cursor });
  })
);

// Level 1: get a booking
app.get(
  "/bookings/:id",
  asyncH(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "booking not found" });
    res.json(bookingJson(rows[0]));
  })
);

// Level 3: cancel a booking (frees the slot)
app.delete(
  "/bookings/:id",
  asyncH(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (cur.rowCount === 0) {
        await client.query("COMMIT");
        return res.status(404).json({ error: "booking not found" });
      }
      if (cur.rows[0].status === "cancelled") {
        await client.query("COMMIT");
        return res.status(409).json({ error: "booking already cancelled" });
      }
      const upd = await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *", [
        req.params.id,
      ]);
      await client.query("COMMIT");
      res.json(bookingJson(upd.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// 404 + error handlers always answer with { "error": "..." }
app.use((req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

initSchema()
  .then(() => app.listen(PORT, () => console.log(`Clinic booking API listening on :${PORT}`)))
  .catch((e) => {
    console.error("Failed to initialise database", e);
    process.exit(1);
  });
