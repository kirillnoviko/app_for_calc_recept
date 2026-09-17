"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./db");
const bot = require("./bot");
const { verifyInitData } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DEV_ADMIN = process.env.ALLOW_DEV_ADMIN === "1";

app.disable("x-powered-by");
app.set("trust proxy", 1);

/* ---------- кто пришёл ---------- */
/* Подпись проверяется на каждом запросе. Клиентскому user.id доверия нет. */
async function who(req) {
  const raw = req.get("X-Init-Data") || "";
  const user = verifyInitData(raw, BOT_TOKEN);

  if (!user) {
    if (DEV_ADMIN) return { user: { id: 0, first_name: "Разработчик" }, admin: true, dev: true };
    return { user: null, admin: false };
  }
  return { user, admin: await db.isAdmin(user.id) };
}

function needAdmin(handler) {
  return async (req, res) => {
    let ctx;
    try {
      ctx = await who(req);
    } catch (e) {
      return res.status(500).json({ error: "сбой проверки доступа" });
    }
    if (!ctx.user) return res.status(401).json({ error: "откройте приложение из Telegram" });
    if (!ctx.admin) return res.status(403).json({ error: "нужны права администратора" });
    req.ctx = ctx;
    return handler(req, res);
  };
}

/* ---------- вебхук бота ---------- */
/* Регистрируется до express.json, чтобы тело читалось только здесь. */
app.post("/bot/:secret", express.json({ limit: "1mb" }), async (req, res) => {
  if (!WEBHOOK_SECRET || req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);
  res.sendStatus(200); // Telegram не должен ждать обработку
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error("ошибка обработки апдейта:", e.message);
  }
});

app.use(express.json({ limit: "8mb" }));

/* ---------- API ---------- */
app.get("/api/me", async (req, res) => {
  const ctx = await who(req);
  if (!ctx.user) return res.status(401).json({ error: "откройте приложение из Telegram" });
  res.json({
    id: ctx.user.id,
    name: ctx.user.first_name || "",
    isAdmin: ctx.admin,
    dev: !!ctx.dev
  });
});

app.get("/api/state", async (req, res) => {
  const ctx = await who(req);
  if (!ctx.user) return res.status(401).json({ error: "откройте приложение из Telegram" });
  const st = await db.getState();
  res.json({ rev: st.rev, data: st.data, isAdmin: ctx.admin });
});

app.put("/api/state", needAdmin(async (req, res) => {
  const { rev, data } = req.body || {};
  if (!data || typeof data !== "object")
    return res.status(400).json({ error: "нет данных" });
  if (!Array.isArray(data.fills) || !Array.isArray(data.comps) ||
      !Array.isArray(data.forms) || !Array.isArray(data.ings))
    return res.status(400).json({ error: "в данных не хватает разделов" });

  const next = await db.putState(data, Number(rev) || 0, req.ctx.user.id);
  if (next === null) {
    const cur = await db.getState();
    return res.status(409).json({ error: "данные уже изменились", rev: cur.rev, data: cur.data });
  }
  res.json({ rev: next });
}));

/* ---------- картинки ---------- */
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

app.post("/api/img",
  express.raw({ type: Object.keys(IMG_TYPES), limit: "3mb" }),
  needAdmin(async (req, res) => {
    const mime = (req.get("Content-Type") || "").split(";")[0].trim();
    if (!IMG_TYPES[mime]) return res.status(415).json({ error: "поддерживаются jpeg, png, webp" });
    if (!req.body || !req.body.length) return res.status(400).json({ error: "пустой файл" });

    const id = crypto.randomBytes(9).toString("hex");
    await db.putFile(id, mime, req.body);
    res.json({ url: "/api/img/" + id });
  })
);

app.get("/api/img/:id", async (req, res) => {
  if (!/^[a-f0-9]{18}$/.test(req.params.id)) return res.sendStatus(404);
  const f = await db.getFile(req.params.id);
  if (!f) return res.sendStatus(404);
  res.set("Content-Type", f.mime);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(f.bytes);
});

/* ---------- отчёт в переписку ---------- */
app.post("/api/report", async (req, res) => {
  const ctx = await who(req);
  if (!ctx.user) return res.status(401).json({ error: "откройте приложение из Telegram" });

  const body = req.body || {};
  let html, plain;

  if (body.report) {
    const rep = bot.saneReport(body.report);
    if (!rep) return res.status(400).json({ error: "отчёт не разобрался" });
    html = bot.renderReport(rep);
  } else {
    plain = String(body.text || "").slice(0, 3800);
    if (!plain.trim()) return res.status(400).json({ error: "пустой отчёт" });
  }

  if (html && html.length > 4000)
    return res.status(413).json({ error: "отчёт слишком большой для одного сообщения" });

  if (ctx.dev) return res.json({ ok: true, dev: true });

  try {
    if (html) await bot.sendMessage(ctx.user.id, html, { parse_mode: "HTML" });
    else await bot.sendMessage(ctx.user.id, plain);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "Telegram не принял сообщение: " + e.message });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

/* ---------- статика ---------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------- старт ---------- */
(async () => {
  try {
    await db.init();
    console.log("база готова");
  } catch (e) {
    console.error("не поднялась база:", e.message);
    process.exit(1);
  }

  app.listen(PORT, () => console.log("слушаю порт " + PORT));

  const url = process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "");
  if (BOT_TOKEN && WEBHOOK_SECRET && url) {
    try {
      await bot.setWebhook(url, WEBHOOK_SECRET);
    } catch (e) {
      console.error("вебхук не встал:", e.message);
    }
  } else {
    console.log("вебхук не ставлю: нет BOT_TOKEN, WEBHOOK_SECRET или PUBLIC_URL");
  }
})();
