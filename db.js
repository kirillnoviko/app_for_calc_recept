"use strict";
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
  max: 5
});

/**
 * Состояние приложения хранится одним JSON-документом.
 * Для одного кондитера с парой помощников этого достаточно, а схема
 * остаётся гибкой: слои, справочник и формы меняются без миграций.
 * Поле rev защищает от затирания чужих правок: клиент присылает ту
 * ревизию, которую читал, и при расхождении получает 409.
 */
const SCHEMA = `
create table if not exists app_state (
  id          smallint primary key default 1,
  rev         bigint   not null default 0,
  data        jsonb    not null,
  updated_at  timestamptz not null default now(),
  updated_by  bigint,
  constraint app_state_single check (id = 1)
);

create table if not exists files (
  id          text primary key,
  mime        text not null,
  bytes       bytea not null,
  created_at  timestamptz not null default now()
);

create table if not exists admins (
  tg_id       bigint primary key,
  name        text,
  added_at    timestamptz not null default now()
);
`;

async function init() {
  await pool.query(SCHEMA);

  const ids = String(process.env.ADMIN_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    await pool.query(
      "insert into admins (tg_id, name) values ($1, $2) on conflict (tg_id) do nothing",
      [id, "из ADMIN_IDS"]
    );
  }
}

async function isAdmin(tgId) {
  if (!tgId) return false;
  const r = await pool.query("select 1 from admins where tg_id = $1", [String(tgId)]);
  return r.rowCount > 0;
}

async function getState() {
  const r = await pool.query("select rev, data from app_state where id = 1");
  if (!r.rowCount) return { rev: 0, data: null };
  return { rev: Number(r.rows[0].rev), data: r.rows[0].data };
}

/** Записывает состояние. Возвращает null, если ревизия устарела. */
async function putState(data, expectedRev, byId) {
  const cur = await pool.query("select rev from app_state where id = 1");

  if (!cur.rowCount) {
    if (Number(expectedRev) !== 0) return null;
    const ins = await pool.query(
      "insert into app_state (id, rev, data, updated_by) values (1, 1, $1, $2) returning rev",
      [data, byId ? String(byId) : null]
    );
    return Number(ins.rows[0].rev);
  }

  const upd = await pool.query(
    `update app_state
        set rev = rev + 1, data = $1, updated_at = now(), updated_by = $2
      where id = 1 and rev = $3
      returning rev`,
    [data, byId ? String(byId) : null, String(expectedRev)]
  );
  if (!upd.rowCount) return null;
  return Number(upd.rows[0].rev);
}

async function putFile(id, mime, buf) {
  await pool.query(
    "insert into files (id, mime, bytes) values ($1, $2, $3) on conflict (id) do nothing",
    [id, mime, buf]
  );
}

async function getFile(id) {
  const r = await pool.query("select mime, bytes from files where id = $1", [id]);
  return r.rowCount ? r.rows[0] : null;
}

module.exports = { pool, init, isAdmin, getState, putState, putFile, getFile };
