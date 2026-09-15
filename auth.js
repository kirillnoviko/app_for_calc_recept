"use strict";
const crypto = require("crypto");

/**
 * Проверяет подпись initData из Telegram Mini App.
 * Возвращает объект пользователя или null, если подпись не сошлась.
 *
 * Клиенту доверять нельзя: initDataUnsafe.user.id подделывается за минуту.
 * Единственный надёжный способ — пересчитать HMAC здесь, на сервере.
 */
function verifyInitData(initData, botToken, maxAgeSec) {
  if (!initData || !botToken) return null;
  maxAgeSec = maxAgeSec || 86400;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  // строка проверки: пары key=value, отсортированные по ключу, через \n
  const pairs = [];
  params.forEach((v, k) => pairs.push(k + "=" + v));
  pairs.sort();
  const checkString = pairs.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

  const a = Buffer.from(calc, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate) return null;
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSec) return null;

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;

  return user;
}

module.exports = { verifyInitData };
