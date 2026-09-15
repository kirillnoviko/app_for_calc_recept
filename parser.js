/* Разбор рецепта из текстового сообщения.
   Возвращает {title, note, items:[{name,a,u}], skipped:[], warn:[]} */
function parseRecipe(text){
  var lines = String(text || "").replace(/\u00a0/g, " ").split(/\r?\n/);
  var title = "", note = "", items = [], skipped = [], warn = [];
  var titleTaken = false;

  lines.forEach(function(raw){
    var s = raw.trim();
    if(!s) return;
    s = s.replace(/^[\-\u2013\u2014\u2022*\u00b7]+\s*/, "").trim();
    if(!s) return;

    /* первая непустая строка всегда заголовок, даже если в ней есть цифры */
    if(!titleTaken){
      titleTaken = true;
      var m = s.match(/^(.*?)\s*[\(\uff08]([^\)\uff09]*)[\)\uff09]\s*$/);
      if(m){ title = m[1].trim(); note = m[2].trim(); }
      else title = s.replace(/[:\uff1a]\s*$/, "").trim();
      title = title.replace(/\s*[\-\u2013\u2014]\s*$/, "").trim();
      return;
    }

    var it = parseLine(s);
    if(it){
      if(it.warn) warn.push(it.warn);
      items.push({name:it.name, a:it.a, u:it.u});
    }else{
      skipped.push(s);
    }
  });

  return {title:title, note:note, items:items, skipped:skipped, warn:warn};
}

function toNum(s){ return parseFloat(String(s).replace(",", ".")); }

function parseLine(s){
  /* случай 1: строка кончается единицей измерения */
  var m = s.match(/^(.*?)(\d+(?:[.,]\d+)?)\s*(гр\.?|грамм(?:ов|а)?|г\.?|шт\.?|мл\.?)\s*$/i);
  if(m){
    var name = cleanName(m[1]);
    var a = toNum(m[2]);
    var raw = m[3].toLowerCase();
    var u = /шт/.test(raw) ? "шт" : "г";
    var w = null;
    if(/мл/.test(raw)) w = "«" + s + "»: миллилитры записаны как граммы.";
    if(!name || !(a > 0)) return null;
    return {name:name, a:a, u:u, warn:w};
  }

  /* случай 2: единицы нет — годится для «Цедра 1 лайма», «1 боб тонка» */
  if(s.split(/\s+/).length > 5) return null;

  var nums = [], re = /(\d+(?:[.,]\d+)?)/g, mm;
  while((mm = re.exec(s)) !== null){
    var after = s.slice(mm.index + mm[0].length);
    if(/^\s*%/.test(after)) continue;          /* 33% — часть названия */
    nums.push({v:mm[0], i:mm.index});
  }
  if(nums.length !== 1) return null;

  var n = nums[0];
  var rest = cleanName(s.slice(0, n.i) + " " + s.slice(n.i + n.v.length));
  var val = toNum(n.v);
  if(!rest || !(val > 0)) return null;
  /* число в конце строки — это вес без подписи; в начале или середине — счёт штук */
  var atEnd = (n.i + n.v.length) >= s.replace(/[\s.,;]+$/, "").length;
  var u = atEnd ? "г" : "шт";
  return {name:capFirst(rest), a:val, u:u,
          warn:"«" + s + "»: единица не указана, поставил " + u + "."};
}

function capFirst(s){
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function cleanName(s){
  return String(s)
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/^[\s\-\u2013\u2014:,.]+|[\s\-\u2013\u2014:,.]+$/g, "")
    .trim();
}

if(typeof module !== "undefined") module.exports = {parseRecipe: parseRecipe};
