"use strict";
// Integration test: run against a live server.
//   API_KEY=secret BASE=http://localhost:3000 node test.js
const BASE = process.env.BASE || "http://localhost:3000";
const KEY = process.env.API_KEY || "secret";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

async function call(method, path, body, headers = {}, key = KEY) {
  const h = { "Content-Type": "application/json", ...headers };
  if (key !== null) h["X-API-Key"] = key;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { s: res.status, j: json, h: res.headers };
}

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const slots = (extra = []) => ({
  slots: [
    { id: "past", provider: "Dr Ade", start: iso(-3600e3), end: iso(-1800e3) },
    { id: "s1", provider: "Dr Ade", start: iso(2 * 3600e3), end: iso(2.5 * 3600e3) },
    { id: "s2", provider: "Dr Bisi", start: iso(1 * 3600e3), end: iso(1.5 * 3600e3) },
    { id: "s3", provider: "Dr Ade", start: iso(3 * 3600e3), end: iso(3.5 * 3600e3) },
    ...extra,
  ],
});

(async () => {
  console.log("Level 2: auth");
  ok((await call("GET", "/slots", null, {}, null)).s === 401, "no key -> 401");
  ok((await call("GET", "/slots", null, {}, "wrong")).s === 401, "wrong key -> 401");

  console.log("Level 1: slots + booking");
  ok((await call("POST", "/reset", slots())).s === 200, "reset");
  let r = await call("GET", "/slots");
  ok(r.s === 200 && r.j.slots.length === 4, "list slots");
  ok(r.j.slots[0].id === "past" && r.j.slots[1].id === "s2", "sorted by start asc");
  ok(r.j.slots.every((s) => s.available === true), "all available");
  r = await call("GET", "/slots?provider=Dr%20Bisi");
  ok(r.j.slots.length === 1 && r.j.slots[0].id === "s2", "provider filter");

  r = await call("POST", "/bookings", { slot_id: "s1", name: "  Ada Obi ", email: " ADA@Example.com " });
  ok(r.s === 201 && r.j.status === "confirmed", "book -> 201 confirmed");
  ok(r.j.name === "Ada Obi" && r.j.email === "ada@example.com", "name trimmed, email lower-cased");
  const id = r.j.id;
  r = await call("GET", "/bookings/" + id);
  ok(r.s === 200 && r.j.id === id, "get booking");
  ok((await call("GET", "/bookings/nope")).s === 404, "unknown booking -> 404");
  r = await call("GET", "/slots");
  ok(r.j.slots.find((s) => s.id === "s1").available === false, "slot s1 now unavailable");

  console.log("Level 2: validation");
  ok((await call("POST", "/bookings", { name: "A", email: "a@b.co" })).s === 400, "missing slot_id");
  ok((await call("POST", "/bookings", { slot_id: "s2", name: "  ", email: "a@b.co" })).s === 400, "blank name");
  ok((await call("POST", "/bookings", { slot_id: "s2", name: "A", email: "not-an-email" })).s === 400, "bad email");
  ok((await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: "v1@b.co" })).s === 404, "unknown slot -> 404");
  ok((await call("POST", "/bookings", { slot_id: "past", name: "A", email: "v2@b.co" })).s === 400, "past slot -> 400");

  console.log("Level 3: conflict + cancel");
  r = await call("POST", "/bookings", { slot_id: "s1", name: "Bob", email: "bob@b.co" });
  ok(r.s === 409, "same slot twice -> 409");
  await call("POST", "/reset", slots());
  const race = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call("POST", "/bookings", { slot_id: "s3", name: "R" + i, email: `race${i}@b.co` }))
  );
  ok(race.filter((x) => x.s === 201).length === 1, "20 simultaneous requests -> exactly one 201");
  ok(race.filter((x) => x.s === 409).length === 19, "...and 19 x 409");
  const winner = race.find((x) => x.s === 201).j;
  r = await call("DELETE", "/bookings/" + winner.id);
  ok(r.s === 200 && r.j.status === "cancelled", "cancel -> 200 cancelled");
  ok((await call("DELETE", "/bookings/" + winner.id)).s === 409, "cancel twice -> 409");
  ok((await call("DELETE", "/bookings/nope")).s === 404, "cancel unknown -> 404");
  r = await call("POST", "/bookings", { slot_id: "s3", name: "Again", email: "again@b.co" });
  ok(r.s === 201, "cancelled slot can be booked again");

  console.log("Level 4: idempotency + pagination");
  await call("POST", "/reset", slots());
  const body = { slot_id: "s1", name: "Ida", email: "ida@b.co" };
  const a = await call("POST", "/bookings", body, { "Idempotency-Key": "k1" });
  const b = await call("POST", "/bookings", body, { "Idempotency-Key": "k1" });
  ok(a.s === 201 && b.s === 201 && a.j.id === b.j.id, "same key + body -> same booking id");
  ok((await call("POST", "/bookings", { ...body, name: "Other" }, { "Idempotency-Key": "k1" })).s === 422, "same key, different body -> 422");
  const par = await Promise.all(Array.from({ length: 10 }, () =>
    call("POST", "/bookings", { slot_id: "s2", name: "P", email: "par@b.co" }, { "Idempotency-Key": "k2" })));
  ok(new Set(par.map((x) => x.j.id)).size === 1 && par.every((x) => x.s === 201), "10 parallel retries -> one booking");

  await call("POST", "/reset", { slots: Array.from({ length: 7 }, (_, i) => ({ id: "p" + i, provider: "X", start: iso((i + 1) * 3600e3), end: iso((i + 1.5) * 3600e3) })) });
  for (let i = 0; i < 4; i++) await call("POST", "/bookings", { slot_id: "p" + i, name: "Pg", email: "pager" + "@b.co" });
  // rate limit allows 5/min per email, so use a second email for the rest of the list
  for (let i = 4; i < 7; i++) await call("POST", "/bookings", { slot_id: "p" + i, name: "Pg", email: "pager2@b.co" });
  let seen = [], cursor = null, pages = 0;
  do {
    r = await call("GET", "/bookings?email=PAGER@b.co&limit=3" + (cursor ? "&cursor=" + cursor : ""));
    seen = seen.concat(r.j.bookings.map((x) => x.slot_id)); cursor = r.j.next_cursor; pages++;
  } while (cursor && pages < 10);
  ok(seen.join() === "p0,p1,p2,p3" && pages === 2, "paged 4 bookings in 2 pages, oldest first, case-insensitive email");
  ok(r.j.next_cursor === null, "last page next_cursor null");
  ok((await call("GET", "/bookings?email=a@b.co&limit=0")).s === 400, "limit 0 -> 400");
  ok((await call("GET", "/bookings?email=a@b.co&limit=51")).s === 400, "limit 51 -> 400");
  ok((await call("GET", "/bookings?email=a@b.co&limit=abc")).s === 400, "limit abc -> 400");

  console.log("Level 5: rate limit");
  await call("POST", "/reset", slots());
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(await call("POST", "/bookings", { slot_id: "zzz", name: "S", email: "spam@b.co" }));
  ok(codes.slice(0, 5).every((x) => x.s === 404), "first 5 attempts processed (failed ones count)");
  ok(codes[5].s === 429, "6th -> 429");
  const ra = parseInt(codes[5].h.get("Retry-After"), 10);
  ok(ra >= 1 && ra <= 60, "Retry-After is whole seconds (" + ra + ")");
  ok((await call("POST", "/bookings", { slot_id: "s1", name: "Other", email: "other@b.co" })).s === 201, "other email unaffected");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
