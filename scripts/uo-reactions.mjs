/**
 * UO · Реакции в чате
 *
 * Отклик значком под любым сообщением чата: бросок, реплика, карточка
 * заклинания. Число рядом со значком — сколько человек его поставили,
 * а кто именно — видно по наведению.
 *
 * Хранятся реакции флагом в самом сообщении, строкой на каждого участника:
 * `flags.uo-reactions.reakcii.<userId> = ["👍", "🔥"]`. Каждый меняет только
 * свою строку, поэтому два отклика в одну секунду не затирают друг друга.
 *
 * Чужое сообщение игрок менять не вправе — Foundry пускает к нему только
 * автора и ведущего. Поэтому просьба уходит по сокету активному ведущему,
 * а тот проверяет её и пишет. Отправителя называет сервер, а не сама просьба:
 * поставить значок от чужого имени нельзя.
 */

import { Т, М, загрузитьЯзык } from "./yazyk.mjs";

const MODULE_ID = "uo-reactions";
const SOCKET = `module.${MODULE_ID}`;
const FLAG = "reakcii";
const SET_SETTING = "nabor";
const LAYOUT_SETTING = "raskladka";

/** Как избранное ложится по страницам журнала. */
const LAYOUTS = {
  govoryashchij: М("Страница на каждого, кто говорит"),
  uchastnik: М("Страница на каждого участника"),
  soobshchenie: М("Страница на каждое сообщение"),
};
const DEFAULT_LAYOUT = "govoryashchij";

/** Набор по умолчанию: одобрение, смех, удивление, грусть, злость — и пара застольных. */
const DEFAULT_SET = "👍 👎 😂 😮 😢 😡 ❤️ 🔥 🎲 💀";

/**
 * Свои значки — картинки ведущего: герб отряда, рожица трактирщика.
 * Лежат списком `[{ id, name, src }]`, а в реакции пишется `img:<id>`, не путь:
 * картинку можно заменить файлом получше, и поставленные значки не потеряются.
 */
const OWN_SETTING = "svoi";
const OWN_MENU = "svoi-menu";
const OWN_PREFIX = "img:";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SET_SETTING, {
    name: М("Набор реакций"),
    hint: М("Значки, из которых выбирают игроки, через пробел. Уже поставленные значки остаются, даже если убрать их из набора."),
    scope: "world", config: true, type: String, default: DEFAULT_SET
  });
  game.settings.register(MODULE_ID, OWN_SETTING, {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => refreshOwnChips(),
  });
  game.settings.registerMenu(MODULE_ID, OWN_MENU, {
    name: М("Свои значки"),
    label: М("Править значки"),
    hint: М("Свои картинки в наборе реакций, рядом с эмодзи: герб отряда, лицо трактирщика, кружка эля. Подойдёт любой файл картинки — png, webp, svg, gif."),
    icon: "fa-solid fa-icons",
    type: OwnReactionsMenu,
    restricted: true,
  });
  // У каждого своя: журнал избранного личный, и раскладка в нём — тоже.
  game.settings.register(MODULE_ID, LAYOUT_SETTING, {
    name: М("Избранное: страницы"),
    hint: М("Как раскладывать избранное в вашем журнале. «Кто говорит» — по персонажу или имени в шапке сообщения; «участник» — по тому, кто сидит за клавиатурой, со всеми его персонажами. Уже записанное не перекладывается."),
    scope: "client", config: true, type: String, choices: { ...LAYOUTS }, default: DEFAULT_LAYOUT
  });
});

// Словарь читается уже после init, поэтому подписи настройки переводятся задним числом.
Hooks.once("i18nInit", async () => {
  await загрузитьЯзык(MODULE_ID);
  for (const key of [SET_SETTING, LAYOUT_SETTING]) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    if (!setting) continue;
    setting.name = Т(setting.name);
    setting.hint = Т(setting.hint);
    if (setting.choices) for (const k of Object.keys(setting.choices)) setting.choices[k] = Т(setting.choices[k]);
  }
  const menu = game.settings.menus.get(`${MODULE_ID}.${OWN_MENU}`);
  if (menu) for (const field of ["name", "label", "hint"]) menu[field] = Т(menu[field]);
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onRequest);
  // Щелчок мимо набора закрывает его. Щелчок по той же улыбке — тоже,
  // но это делает её собственный обработчик: иначе набор закрылся бы
  // здесь и тут же открылся снова.
  document.addEventListener("pointerdown", ev => {
    if (picker && !picker.contains(ev.target) && !pickerAnchor?.contains(ev.target)) closePicker();
  }, true);
  document.addEventListener("keydown", ev => {
    if (picker && ev.key === "Escape") closePicker();
  });
});

Hooks.on("renderChatMessageHTML", (message, html) => decorate(message, html));

/* ------------------------------------------------------------------ *
 *  Данные
 * ------------------------------------------------------------------ */

/** Значки набора по порядку. Режется по графемам: «❤️» и флаги — один значок, хоть и не один символ. */
function allowedSet() {
  const raw = game.settings.get(MODULE_ID, SET_SETTING) || DEFAULT_SET;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const list = [...segmenter.segment(raw)].map(s => s.segment).filter(s => s.trim());
  return [...new Set([...list, ...ownList().map(o => OWN_PREFIX + o.id)])];
}

/** Свои значки ведущего, только целые записи. */
function ownList() {
  const list = game.settings.get(MODULE_ID, OWN_SETTING);
  return Array.isArray(list) ? list.filter(o => o?.id && o?.src) : [];
}

/**
 * Как показать значок: эмодзи — текстом, свой — картинкой. Свой, которого
 * в списке уже нет, показывается заглушкой: снять его всё равно можно.
 */
function faceOf(key) {
  if (!key.startsWith(OWN_PREFIX)) {
    const span = document.createElement("span");
    span.className = "uo-r-emoji";
    span.textContent = key;
    return span;
  }
  const own = ownList().find(o => OWN_PREFIX + o.id === key);
  if (!own) {
    const gone = document.createElement("i");
    gone.className = "uo-r-emoji fa-solid fa-image";
    return gone;
  }
  const img = document.createElement("img");
  img.className = "uo-r-emoji uo-r-svoj";
  img.src = own.src;
  img.alt = own.name || "";
  return img;
}

/** Имя значка для подсказки: у своего — подпись ведущего, у эмодзи — пусто. */
function nameOf(key) {
  return key.startsWith(OWN_PREFIX) ? ownList().find(o => OWN_PREFIX + o.id === key)?.name ?? "" : "";
}

/** Свои значки поменялись — перерисовать сообщения, где они стоят. */
function refreshOwnChips() {
  for (const message of game.messages ?? []) {
    const used = Object.values(reactionsOf(message)).flat();
    if (used.some(k => typeof k === "string" && k.startsWith(OWN_PREFIX))) ui.chat?.updateMessage?.(message);
  }
}

/** Реакции сообщения: { userId: ["👍", …] }. */
function reactionsOf(message) {
  return message.getFlag(MODULE_ID, FLAG) ?? {};
}

/**
 * Свести реакции к списку значков: какой, кто поставил.
 * Сначала в порядке набора, потом всё, что из набора уже убрано.
 * Ушедшие из мира участники не считаются.
 */
function tally(message) {
  const byEmoji = new Map();
  for (const [userId, list] of Object.entries(reactionsOf(message))) {
    const user = game.users.get(userId);
    if (!user || !Array.isArray(list)) continue;
    for (const emoji of list) {
      if (!byEmoji.has(emoji)) byEmoji.set(emoji, []);
      byEmoji.get(emoji).push(user);
    }
  }
  const order = allowedSet();
  const rank = emoji => {
    const i = order.indexOf(emoji);
    return i < 0 ? order.length : i;
  };
  return [...byEmoji.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([emoji, users]) => ({ emoji, users }));
}

/* ------------------------------------------------------------------ *
 *  Запись
 * ------------------------------------------------------------------ */

/** Поставить или снять значок участника. Пишет только своя строка участника. */
function writeReaction(message, userId, emoji, on) {
  const mine = new Set(reactionsOf(message)[userId] ?? []);
  if (on) mine.add(emoji);
  else mine.delete(emoji);
  const path = `flags.${MODULE_ID}.${FLAG}`;
  if (mine.size) return message.update({ [`${path}.${userId}`]: [...mine] });
  // Снят последний значок — строка участника уходит целиком, без пустого списка.
  const ForcedDeletion = foundry.data.operators?.ForcedDeletion;
  return message.update(ForcedDeletion
    ? { [`${path}.${userId}`]: new ForcedDeletion() }
    : { [`${path}.-=${userId}`]: null });
}

/**
 * Нажатие на значок. Желаемое состояние считает тот, кто нажал, по тому,
 * что видит у себя: так двойной щелчок ставит и снимает, а не ставит дважды.
 */
async function toggle(message, emoji) {
  const on = !(reactionsOf(message)[game.user.id] ?? []).includes(emoji);
  if (on && !allowedSet().includes(emoji)) return;
  if (message.canUserModify(game.user, "update")) return writeReaction(message, game.user.id, emoji, on);

  const gm = game.users.activeGM;
  if (!gm) {
    ui.notifications.warn(Т("Ведущего нет в игре: отклик на чужое сообщение некому записать."));
    return;
  }
  game.socket.emit(SOCKET, { type: "toggle", messageId: message.id, emoji, on }, { recipients: [gm.id] });
}

/**
 * Просьба игрока. Отвечает только активный ведущий — иначе при двух ведущих
 * запись шла бы дважды. Поставить можно только значок из набора, снять — любой:
 * набор могли сузить уже после того, как значок поставили.
 */
async function onRequest(data, senderId) {
  if (game.user !== game.users.activeGM) return;
  const message = game.messages.get(data?.messageId);
  const sender = game.users.get(senderId);
  if (!message || !sender) return;

  if (data.type === "toggle") {
    if (typeof data.emoji !== "string") return;
    if (data.on && !allowedSet().includes(data.emoji)) return;
    await writeReaction(message, sender.id, data.emoji, !!data.on);
  }
  if (data.type === "favorite") await queued(() => writeFavorite(message, sender, !!data.on, data.layout));
}

/* ------------------------------------------------------------------ *
 *  Избранное
 *
 *  У каждого участника свой журнал «Избранное: имя» в папке «Избранное».
 *  Владелец журнала — сам участник, остальным он закрыт (ведущие видят всё,
 *  как всегда). Отмеченное сообщение — запись на странице журнала: когда
 *  и что сказано. Это копия, а не ссылка: сообщение удалят или чат очистят,
 *  а запись останется.
 *
 *  Как записи ложатся по страницам, каждый выбирает сам (настройка
 *  «Избранное: страницы»): страница на каждого, кто говорит, на каждого
 *  участника или на каждое сообщение. На общей странице записи идут
 *  по времени сообщений.
 *
 *  Какие сообщения на странице, помнит её флаг — по нему же звезда в чате
 *  знает, отмечено ли сообщение. Сама запись в тексте страницы — блок
 *  с id сообщения: снятая звезда вырезает ровно его.
 *
 *  Создавать журналы игрокам Foundry по умолчанию не даёт, поэтому первую
 *  запись (журнал, а то и папку) делает активный ведущий по просьбе. Потом
 *  журнал свой, и игрок пишет в него сам.
 * ------------------------------------------------------------------ */

const FAV_JOURNAL = "izbrannoe";       // флаг журнала: чей он, id участника
const FAV_FOLDER = "papka-izbrannogo"; // флаг папки
const FAV_PAGE = "soobshcheniya";      // флаг страницы: id сообщений на ней
const FAV_GROUP = "kto";               // флаг страницы: чья это страница

/** Журнал избранного участника — по флагу, а не по имени: журнал могут переименовать. */
function favoritesOf(user) {
  return game.journal.find(j => j.getFlag(MODULE_ID, FAV_JOURNAL) === user.id) ?? null;
}

/** Сообщения на странице избранного. */
function idsOf(page) {
  const list = page.getFlag(MODULE_ID, FAV_PAGE);
  return Array.isArray(list) ? list : [];
}

/** Страница избранного, где уже лежит это сообщение. */
function favoritePage(message, user = game.user) {
  return favoritesOf(user)?.pages.find(p => idsOf(p).includes(message.id)) ?? null;
}

/** Раскладка участника; неизвестное значение — по говорящему. */
function layoutOf(value) {
  return value in LAYOUTS ? value : DEFAULT_LAYOUT;
}

/**
 * Видно ли участнику сообщение. Шёпот — только адресатам и автору,
 * слепой бросок — только ведущим: в избранное не уносят того, чего не видели.
 */
function canSee(message, user) {
  if (user.isGM) return true;
  if (message.blind) return false;
  return !message.whisper.length || message.whisper.includes(user.id) || message.author?.id === user.id;
}

/**
 * Записи идут по одной: две звезды подряд не должны завести два журнала,
 * а две записи на одну страницу — затереть одна другую.
 */
let queue = Promise.resolve();
function queued(job) {
  queue = queue.then(job, job);
  return queue;
}

async function ensureFolder() {
  const found = game.folders.find(f => f.type === "JournalEntry" && f.getFlag(MODULE_ID, FAV_FOLDER));
  if (found) return found;
  return Folder.implementation.create({
    name: Т("Избранное"), type: "JournalEntry", color: "#b8953f",
    flags: { [MODULE_ID]: { [FAV_FOLDER]: true } },
  });
}

async function ensureFavorites(user) {
  const found = favoritesOf(user);
  if (found) return found;
  const folder = await ensureFolder();
  return JournalEntry.implementation.create({
    name: Т("Избранное: {имя}", { имя: user.name }),
    folder: folder?.id ?? null,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    flags: { [MODULE_ID]: { [FAV_JOURNAL]: user.id } },
  });
}

/** Текст без разметки — для названия страницы. */
function plain(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return div.textContent.replace(/\s+/g, " ").trim();
}

/** Кто сказал: имя из шапки сообщения, иначе автор. */
function speakerName(message) {
  return message.alias || message.speaker?.alias || message.author?.name || Т("Без имени");
}

const esc = s => Handlebars.escapeExpression(String(s ?? ""));

/**
 * Чья страница. Говорящий узнаётся по листу персонажа, если он есть:
 * имя в шапке у одного героя бывает разным (жетон переименовали), а лист тот же.
 * Без листа — по имени в шапке: так ведущий, говорящий за трактирщика,
 * и сам ведущий окажутся на разных страницах.
 */
function groupOf(message, layout) {
  if (layout === "uchastnik") {
    const author = message.author;
    return { key: `u:${author?.id ?? "?"}`, name: author?.name ?? Т("Без имени") };
  }
  if (layout === "soobshchenie") return { key: `m:${message.id}`, name: null };
  const name = speakerName(message);
  const actor = message.speaker?.actor;
  return { key: actor ? `a:${actor}` : `n:${name}`, name };
}

/**
 * Одна запись. У броска в тексте сообщения одно число, поэтому бросок
 * записывается формулой и итогом; у реплики и карточки — сам текст.
 * Имя говорящего не пишется там, где страница и так его.
 */
function entryHtml(message, withName) {
  const when = new Date(message.timestamp).toLocaleString(game.i18n.lang, {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
  const rolls = message.rolls ?? [];

  const head = withName ? `<strong>${esc(speakerName(message))}</strong> · ${esc(when)}` : esc(when);
  const parts = [`<p class="uo-izbr-kogda">${head}</p>`];
  if (message.flavor) parts.push(`<p><em>${message.flavor}</em></p>`);
  if (rolls.length) {
    for (const roll of rolls) parts.push(`<p>${esc(roll.formula)} = <strong>${esc(roll.total)}</strong></p>`);
  } else if (message.content) {
    parts.push(`<blockquote>${message.content}</blockquote>`);
  }
  return `<div class="uo-izbr" data-soobshchenie="${message.id}" data-ts="${message.timestamp}">${parts.join("")}</div>`;
}

/** Название страницы на одно сообщение: кто и о чём. */
function singleName(message) {
  const rolls = message.rolls ?? [];
  const gist = plain(message.flavor) || plain(rolls.length ? "" : message.content)
    || rolls.map(r => `${r.formula} = ${r.total}`).join(", ");
  const short = gist.length > 48 ? `${gist.slice(0, 47).trimEnd()}…` : gist;
  const who = speakerName(message);
  return short ? `${who}: ${short}` : who;
}

/** Вставить запись по времени сообщения. Блоки, которые владелец переписал руками, не трогаются. */
function withEntry(html, entry, timestamp) {
  const box = document.createElement("div");
  box.innerHTML = html ?? "";
  const holder = document.createElement("div");
  holder.innerHTML = entry;
  const later = [...box.querySelectorAll(":scope > .uo-izbr[data-ts]")].find(e => Number(e.dataset.ts) > timestamp);
  if (later) later.before(holder.firstElementChild);
  else box.append(holder.firstElementChild);
  return box.innerHTML;
}

function withoutEntry(html, messageId) {
  const box = document.createElement("div");
  box.innerHTML = html ?? "";
  box.querySelector(`[data-soobshchenie="${messageId}"]`)?.remove();
  return box.innerHTML;
}

/** Отметить или снять. Работает у того, кому это можно: у ведущего или у владельца журнала. */
async function writeFavorite(message, user, on, layout) {
  if (!canSee(message, user)) return;
  const page = favoritePage(message, user);

  if (!on) {
    if (!page) return;
    const rest = idsOf(page).filter(id => id !== message.id);
    if (!rest.length) return page.delete();
    return page.update({
      "text.content": withoutEntry(page.text.content, message.id),
      [`flags.${MODULE_ID}.${FAV_PAGE}`]: rest,
    });
  }
  if (page) return;

  const journal = await ensureFavorites(user);
  layout = layoutOf(layout);
  const group = groupOf(message, layout);
  const entry = entryHtml(message, layout !== "govoryashchij");
  const shared = layout !== "soobshchenie"
    && journal.pages.find(p => p.getFlag(MODULE_ID, FAV_GROUP) === group.key);

  if (shared) {
    return shared.update({
      "text.content": withEntry(shared.text.content, entry, message.timestamp),
      [`flags.${MODULE_ID}.${FAV_PAGE}`]: [...idsOf(shared), message.id],
    });
  }
  return journal.createEmbeddedDocuments("JournalEntryPage", [{
    name: group.name ?? singleName(message),
    type: "text",
    text: { content: entry, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    // Страницы идут в том порядке, в каком впервые прозвучало то, что на них.
    sort: message.timestamp,
    flags: { [MODULE_ID]: { [FAV_PAGE]: [message.id], [FAV_GROUP]: group.key } },
  }]);
}

/** Нажатие на звезду. Состояние считает тот, кто нажал, — как у значков. */
async function toggleFavorite(message) {
  const on = !favoritePage(message);
  const layout = layoutOf(game.settings.get(MODULE_ID, LAYOUT_SETTING));
  const journal = favoritesOf(game.user);
  if (game.user.isGM || journal?.isOwner) {
    await queued(() => writeFavorite(message, game.user, on, layout));
    notifyFavorite(on);
    return;
  }

  const gm = game.users.activeGM;
  if (!gm) {
    ui.notifications.warn(Т("Ведущего нет в игре: журнал избранного заводит ведущий, а его нет. Попробуйте, когда он зайдёт."));
    return;
  }
  game.socket.emit(SOCKET, { type: "favorite", messageId: message.id, on, layout }, { recipients: [gm.id] });
  notifyFavorite(on);
}

function notifyFavorite(on) {
  ui.notifications.info(on
    ? Т("В избранном: журнал «{имя}».", { имя: favoritesOf(game.user)?.name ?? Т("Избранное: {имя}", { имя: game.user.name }) })
    : Т("Убрано из избранного."));
}

/**
 * Звёзды в чате следят за журналом. Страница поменялась — перерисовываются
 * только те сообщения, что на неё пришли или с неё ушли: для этого помним,
 * что было на каждой странице.
 */
const onPage = new Map();

function isMine(page) {
  return page.parent?.getFlag(MODULE_ID, FAV_JOURNAL) === game.user.id;
}

function refreshStars(page, gone = false) {
  if (!isMine(page)) return;
  const before = onPage.get(page.id) ?? [];
  const now = gone ? [] : idsOf(page);
  if (gone) onPage.delete(page.id);
  else onPage.set(page.id, now);
  const changed = [...before.filter(id => !now.includes(id)), ...now.filter(id => !before.includes(id))];
  for (const id of changed) {
    const message = game.messages.get(id);
    if (message) ui.chat?.updateMessage?.(message);
  }
}
Hooks.once("ready", () => {
  for (const page of favoritesOf(game.user)?.pages ?? []) onPage.set(page.id, idsOf(page));
});
Hooks.on("createJournalEntryPage", page => refreshStars(page));
Hooks.on("updateJournalEntryPage", page => refreshStars(page));
Hooks.on("deleteJournalEntryPage", page => refreshStars(page, true));
// Журнал пришёл целиком (его только что завёл ведущий) — у игрока он
// появляется вместе со страницей, и отдельной createJournalEntryPage нет.
Hooks.on("createJournalEntry", journal => {
  if (journal.getFlag(MODULE_ID, FAV_JOURNAL) !== game.user.id) return;
  for (const page of journal.pages) refreshStars(page);
});

// Пункт в меню сообщения (правая кнопка) — для тех, кто не ищет звезду в шапке.
Hooks.on("getChatMessageContextOptions", (app, options) => {
  const messageOf = li => game.messages.get((li?.dataset ? li : li?.[0])?.dataset?.messageId);
  options.push(
    {
      name: Т("В избранное"), icon: '<i class="fa-regular fa-star"></i>',
      condition: li => { const m = messageOf(li); return !!m && !favoritePage(m); },
      callback: li => { const m = messageOf(li); if (m) toggleFavorite(m); },
    },
    {
      name: Т("Убрать из избранного"), icon: '<i class="fa-solid fa-star"></i>',
      condition: li => { const m = messageOf(li); return !!m && !!favoritePage(m); },
      callback: li => { const m = messageOf(li); if (m) toggleFavorite(m); },
    },
  );
});

/* ------------------------------------------------------------------ *
 *  Вид
 * ------------------------------------------------------------------ */

/** Кнопка «отреагировать» в шапке сообщения и строка значков под текстом. */
function decorate(message, html) {
  const metadata = html.querySelector(".message-header .message-metadata");
  if (metadata) {
    const add = document.createElement("a");
    add.className = "uo-r-add";
    add.dataset.tooltip = Т("Отреагировать");
    add.setAttribute("aria-label", Т("Отреагировать"));
    add.innerHTML = '<i class="fa-regular fa-face-smile-plus" inert></i>';
    add.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      openPicker(message, add);
    });
    // Звезда избранного. Отмеченное видно всегда, а не только под мышью:
    // так по чату сразу ясно, что уже унесено в журнал.
    const starred = !!favoritePage(message);
    const star = document.createElement("a");
    star.className = "uo-r-fav";
    if (starred) star.classList.add("on");
    const label = starred ? Т("Убрать из избранного") : Т("В избранное");
    star.dataset.tooltip = label;
    star.setAttribute("aria-label", label);
    star.innerHTML = `<i class="${starred ? "fa-solid" : "fa-regular"} fa-star" inert></i>`;
    star.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFavorite(message);
    });

    const closer = metadata.querySelector(".message-delete, .message-dismiss");
    if (closer) closer.before(star, add);
    else metadata.append(star, add);
  }

  const counts = tally(message);
  if (!counts.length) return;

  const bar = document.createElement("div");
  bar.className = "uo-reakcii";
  for (const { emoji, users } of counts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "uo-r-chip";
    if (users.includes(game.user)) chip.classList.add("mine");
    // Подсказку Foundry показывает как разметку, поэтому имена экранируются.
    const who = users.map(u => esc(u.name)).join(", ");
    const title = nameOf(emoji);
    chip.dataset.tooltip = title ? `<strong>${esc(title)}</strong><br>${who}` : who;
    chip.dataset.tooltipDirection = "UP";
    const face = faceOf(emoji);
    const count = document.createElement("span");
    count.className = "uo-r-count";
    count.textContent = users.length;
    chip.append(face, count);
    chip.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(message, emoji);
    });
    bar.append(chip);
  }

  const content = html.querySelector(".message-content");
  if (content) content.after(bar);
  else html.append(bar);
}

let picker = null;
let pickerAnchor = null;

function closePicker() {
  picker?.remove();
  picker = null;
  pickerAnchor = null;
}

/** Всплывающий набор значков возле кнопки. Свои уже поставленные подсвечены. */
function openPicker(message, anchor) {
  if (picker && pickerAnchor === anchor) return closePicker();
  closePicker();
  pickerAnchor = anchor;
  const mine = reactionsOf(message)[game.user.id] ?? [];

  picker = document.createElement("div");
  picker.className = "uo-r-picker";
  for (const emoji of allowedSet()) {
    const button = document.createElement("button");
    button.type = "button";
    button.append(faceOf(emoji));
    const title = nameOf(emoji);
    if (title) button.dataset.tooltip = esc(title);
    if (mine.includes(emoji)) button.classList.add("mine");
    button.addEventListener("click", ev => {
      ev.stopPropagation();
      closePicker();
      toggle(message, emoji);
    });
    picker.append(button);
  }
  document.body.append(picker);

  // Под кнопкой, правым краем к ней: чат прижат к правому краю экрана.
  // Внизу не помещается — открывается над кнопкой.
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = picker;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

/* ------------------------------------------------------------------ *
 *  Свои значки: правка
 * ------------------------------------------------------------------ */

/**
 * Пункт в настройках модуля. Foundry делает `new Тип()` и зовёт render,
 * а правку ведёт обычный диалог — своего окна тут не нужно.
 */
class OwnReactionsMenu extends foundry.applications.api.ApplicationV2 {
  async render() {
    await editOwn();
    return this;
  }
}

/** Строка редактора: картинка, подпись, путь, выбор файла, убрать. */
function ownRow(own = { id: "", name: "", src: "" }) {
  const e = s => foundry.utils.escapeHTML(String(s ?? ""));
  return `
    <div class="uo-r-svoj-stroka" data-id="${e(own.id)}">
      <img class="uo-r-svoj-vid" src="${e(own.src || "icons/svg/hazard.svg")}" alt="">
      <input type="text" class="uo-r-svoj-imya" value="${e(own.name)}" placeholder="${e(Т("подпись"))}">
      <input type="text" class="uo-r-svoj-put" value="${e(own.src)}" placeholder="${e(Т("путь к картинке"))}">
      <button type="button" class="uo-r-svoj-vybrat" data-tooltip="${e(Т("Выбрать файл"))}"><i class="fa-solid fa-file-image" inert></i></button>
      <button type="button" class="uo-r-svoj-ubrat" data-tooltip="${e(Т("Убрать"))}"><i class="fa-solid fa-xmark" inert></i></button>
    </div>`;
}

function wireRow(row) {
  const path = row.querySelector(".uo-r-svoj-put");
  const view = row.querySelector(".uo-r-svoj-vid");
  const show = () => { view.src = path.value.trim() || "icons/svg/hazard.svg"; };
  path.addEventListener("change", show);
  row.querySelector(".uo-r-svoj-vybrat").addEventListener("click", () => {
    new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: path.value.trim(),
      callback: chosen => { path.value = chosen; show(); },
    }).render(true);
  });
  row.querySelector(".uo-r-svoj-ubrat").addEventListener("click", () => row.remove());
}

async function editOwn() {
  if (!game.user.isGM) return;
  const list = ownList();

  await foundry.applications.api.DialogV2.wait({
    window: { title: Т("Свои значки"), icon: "fa-solid fa-icons" },
    position: { width: 600 },
    content: `
      <div class="uo-r-svoj-forma">
        <p class="hint">${Т("Картинки встают в набор реакций после эмодзи, в этом порядке. Подпись видна по наведению. Убранный значок остаётся под сообщениями, где его уже поставили, — заглушкой.")}</p>
        <div class="uo-r-svoj-spisok">${(list.length ? list : [undefined]).map(o => ownRow(o)).join("")}</div>
        <button type="button" class="uo-r-svoj-dobavit"><i class="fa-solid fa-plus" inert></i> ${Т("Добавить значок")}</button>
      </div>`,
    buttons: [
      {
        action: "save", label: Т("Сохранить"), icon: "fa-solid fa-floppy-disk", default: true,
        callback: async (event, button, dialog) => {
          const rows = [...dialog.element.querySelectorAll(".uo-r-svoj-stroka")];
          const next = rows.map(row => {
            const src = row.querySelector(".uo-r-svoj-put").value.trim();
            if (!src) return null;
            const name = row.querySelector(".uo-r-svoj-imya").value.trim()
              || decodeURIComponent(src.split("/").pop().replace(/\.[^.]+$/, ""));
            return { id: row.dataset.id || foundry.utils.randomID(), name, src };
          }).filter(Boolean);
          await game.settings.set(MODULE_ID, OWN_SETTING, next);
        },
      },
      { action: "cancel", label: Т("Отмена"), icon: "fa-solid fa-xmark" },
    ],
    render: (event, dialog) => {
      const root = dialog.element;
      const box = root.querySelector(".uo-r-svoj-spisok");
      box.querySelectorAll(".uo-r-svoj-stroka").forEach(wireRow);
      root.querySelector(".uo-r-svoj-dobavit").addEventListener("click", () => {
        const holder = document.createElement("div");
        holder.innerHTML = ownRow();
        const row = holder.firstElementChild;
        box.append(row);
        wireRow(row);
        row.querySelector(".uo-r-svoj-put").focus();
      });
    },
  });
}
