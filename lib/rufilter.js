// Евристичний фільтр російського контенту для пошуку (картинки, GIF, YouTube).
// Не 100% — але відсіює більшість: російські літери/слова в назвах і російські домени.

// слова, яких немає в українській (або пишуться інакше)
const RU_WORDS = new Set(`
что это как когда очень сегодня привет спасибо пожалуйста нет мне меня тебя него нее неё всех всего
лучшие лучший лучшая смешные смешное смешно видео фильм фильмы песня песни самый самые самая сейчас
если потому здесь только тоже нужно можно почему где кто его ее её они он она будет был была было
были или после чем уже еще ещё мой твой свой хорошо плохо ребята девушка парень игра игры
прохождение обзор новости новость смотреть смотри лучших приколы подборка сериал серия выпуск часть
вопрос ответ любовь жизнь друзья дети человек страна год года время ночь россия россии российский
российская русский русская русские русских москва москвы путин рф кремль
`.trim().split(/\s+/));

const RU_STEMS = ['росси', 'русск', 'москв', 'путин', 'кремл', 'zov', 'на русском'];
const LATIN_MARKERS = /\b(russia|russian|moscow|putin|rus)\b|\[ru\]|\(ru\)/i;

function isRussianText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (LATIN_MARKERS.test(t)) return true;
  if (RU_STEMS.some(s => t.includes(s))) return true;
  if (/[їєґ]/.test(t)) return false;          // явно українське
  if (/[ыэъё]/.test(t)) return true;          // літери, яких нема в українській
  const words = t.match(/[а-яіїєґё']+/g) || [];
  if (!words.length) return false;
  if (/і/.test(t) && !words.some(w => RU_WORDS.has(w))) return false;
  return words.some(w => RU_WORDS.has(w));
}

const RU_HOSTS = [
  'vk.com', 'vk.ru', 'vkvideo.ru', 'userapi.com', 'ok.ru', 'mycdn.me', 'odnoklassniki.ru',
  'yandex.ru', 'yandex.com', 'yandex.net', 'ya.ru', 'yastatic.net', 'dzen.ru', 'zen.yandex.ru',
  'mail.ru', 'imgsmail.ru', 'rutube.ru', 'pikabu.ru', 'livejournal.com', 'lj.rossia.org',
  'rambler.ru', 'kinopoisk.ru', 'ria.ru', 'rt.com', 'tass.ru', 'lenta.ru', 'gazeta.ru',
];
function isRussianUrl(u) {
  if (!u) return false;
  let host;
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  if (/\.(ru|su|xn--p1ai|рф)$/.test(host)) return true;
  return RU_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

// повертає { results, hidden }
function filterResults(list, fields) {
  const out = [];
  let hidden = 0;
  for (const r of list) {
    const bad = fields.urls.some(k => isRussianUrl(r[k])) || fields.texts.some(k => isRussianText(r[k]));
    if (bad) hidden++; else out.push(r);
  }
  return { results: out, hidden };
}

module.exports = { isRussianText, isRussianUrl, filterResults };
