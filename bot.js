"use strict";
const db = require("./db");
const { parseRecipe } = require("./parser");

const TOKEN = process.env.BOT_TOKEN || "";
const API = "https://api.telegram.org/bot" + TOKEN + "/";

async function call(method, payload) {
  if (!TOKEN) throw new Error("BOT_TOKEN не задан");
  const r = await fetch(API + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ": " + (j.description || "ошибка"));
  return j.result;
}

function sendMessage(chatId, text, extra) {
  return call("sendMessage", Object.assign({ chat_id: chatId, text }, extra || {}));
}

function escHtml(s) {
  return String(s).replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}

/**
 * Собирает отчёт в HTML для Telegram.
 * Списки ингредиентов уходят в <pre>: моноширинный блок выравнивает
 * колонку с граммовками, иначе на телефоне всё разъезжается.
 */
function renderReport(o) {
  let out = "<b>" + escHtml(o.title || "Отчёт") + "</b>";
  if (o.sub) out += "\n" + escHtml(o.sub);

  (o.sections || []).forEach(sec => {
    const rows = sec.rows || [];
    if (!rows.length && !sec.head) return;

    let body = "";
    if (sec.head) body += sec.head + "\n";
    if (sec.note) body += sec.note + "\n";

    let w = 0;
    rows.forEach(r => { if (String(r[0]).length > w) w = String(r[0]).length; });
    w = Math.min(w, 22);

    rows.forEach(r => {
      let n = String(r[0]);
      if (n.length > w) n = n.slice(0, w - 1) + "…";
      body += n + ".".repeat(Math.max(2, w - n.length + 2)) + " " + String(r[1]) + "\n";
    });

    out += "\n<pre>" + escHtml(body.replace(/\s+$/, "")) + "</pre>";
  });

  (o.totals || []).forEach(t => {
    out += "\n<b>" + escHtml(t[0]) + ": " + escHtml(t[1]) + "</b>";
  });

  return out;
}

/** Отсекает мусор и слишком большие отчёты до отправки. */
function saneReport(o) {
  if (!o || typeof o !== "object") return null;
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const secs = Array.isArray(o.sections) ? o.sections.slice(0, 30) : [];
  return {
    title: str(o.title, 120) || "Отчёт",
    sub: str(o.sub, 200),
    sections: secs.map(s => ({
      head: str(s && s.head, 120),
      note: str(s && s.note, 200),
      rows: (Array.isArray(s && s.rows) ? s.rows.slice(0, 60) : [])
        .map(r => [str(r && r[0], 60), str(r && r[1], 30)])
    })),
    totals: (Array.isArray(o.totals) ? o.totals.slice(0, 6) : [])
      .map(t => [str(t && t[0], 60), str(t && t[1], 30)])
  };
}

/** Ставит вебхук на наш адрес. Вызывается один раз при старте. */
async function setWebhook(publicUrl, secretPath) {
  if (!TOKEN || !publicUrl) return;
  const url = publicUrl.replace(/\/+$/, "") + "/bot/" + secretPath;
  await call("setWebhook", {
    url,
    allowed_updates: ["message"],
    drop_pending_updates: true
  });
  console.log("вебхук установлен:", url);
}

function id() {
  return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[\s\-\u2010-\u2015]+/g, " ").trim();
}

/**
 * Кладёт разобранный рецепт в состояние.
 * Ингредиенты сверяются со справочником по нормализованному названию,
 * новые заводятся — та же логика, что в приложении.
 */
async function saveFill(parsed, byId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const st = await db.getState();
    if (!st.data) return { error: "База ещё пустая. Откройте приложение и задайте данные." };

    const data = st.data;
    data.ings = data.ings || [];
    data.fills = data.fills || [];

    const items = parsed.items.map(it => {
      const found = data.ings.find(g => norm(g.name) === norm(it.name));
      if (found) return { i: found.id, a: it.a, u: it.u };
      const rec = { id: id(), name: String(it.name).trim() };
      data.ings.push(rec);
      return { i: rec.id, a: it.a, u: it.u };
    });

    const fill = {
      id: id(),
      name: parsed.title || "Начинка без названия",
      note: parsed.note || "",
      img: "",
      items
    };
    data.fills.push(fill);

    const rev = await db.putState(data, st.rev, byId);
    if (rev !== null) return { fill };
  }
  return { error: "Кто-то правил данные одновременно. Попробуйте ещё раз." };
}

const HELP =
  "Я считаю начинку для конфет.\n\n" +
  "Нажмите кнопку ниже, чтобы открыть калькулятор.\n\n" +
  "Ещё я умею принимать рецепты: перешлите мне сообщение с рецептом, " +
  "и я разберу его в начинку. Формат обычный — первая строка название, " +
  "дальше строки вида «Сливки 39 гр».";

async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const fromId = msg.from && msg.from.id;
  const text = (msg.text || msg.caption || "").trim();

  const appUrl = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  const kb = appUrl
    ? { reply_markup: { inline_keyboard: [[{ text: "Открыть калькулятор", web_app: { url: appUrl } }]] } }
    : {};

  if (!text || /^\/start\b/.test(text) || /^\/help\b/.test(text)) {
    await sendMessage(chatId, HELP, kb);
    return;
  }

  const admin = await db.isAdmin(fromId);
  if (!admin) {
    await sendMessage(chatId,
      "Добавлять рецепты могут только администраторы. Ваш Telegram ID: " + fromId, kb);
    return;
  }

  const parsed = parseRecipe(text);
  const grams = parsed.items
    .filter(i => i.u === "г")
    .reduce((s, i) => s + i.a, 0);

  if (!parsed.items.length || grams <= 0) {
    await sendMessage(chatId,
      "Не нашёл ингредиентов с граммовками. Первая строка — название, " +
      "дальше строки вида «Сливки 39 гр».", kb);
    return;
  }

  const res = await saveFill(parsed, fromId);
  if (res.error) {
    await sendMessage(chatId, res.error, kb);
    return;
  }

  let out = "Сохранил начинку «" + res.fill.name + "»\n";
  parsed.items.forEach(i => {
    out += i.name + ": " + i.a + " " + i.u + "\n";
  });
  out += "Выход: " + Math.round(grams * 10) / 10 + " г";
  if (parsed.warn.length) out += "\n\nПроверьте: " + parsed.warn.join(" ");
  if (parsed.skipped.length) out += "\n\nПропустил строки без граммовок: " + parsed.skipped.join("; ");

  await sendMessage(chatId, out, kb);
}

module.exports = { handleUpdate, setWebhook, sendMessage, renderReport, saneReport };
