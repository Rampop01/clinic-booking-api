"use strict";
// Local-only helper: starts a throwaway embedded Postgres on :54329 and keeps it running.
//   node local-pg.js
const EmbeddedPostgres = require("embedded-postgres").default;
const path = require("path");

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(__dirname, ".pgdata"),
    user: "postgres",
    password: "postgres",
    port: 54329,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  try { await pg.createDatabase("clinic"); } catch (_) {}
  console.log("READY postgres://postgres:postgres@localhost:54329/clinic");
  process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await pg.stop(); process.exit(0); });
})().catch((e) => { console.error(e); process.exit(1); });
