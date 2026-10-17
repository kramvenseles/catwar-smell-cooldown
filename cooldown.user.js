// ==UserScript==
// @name         Отображение кулдауна нюха
// @namespace    catwar-smell-cooldown
// @version      0.3.3
// @description  Пока действие «Принюхаться» на откате — показывать его серой иконкой с обратным отсчётом до момента, когда снова можно, вместо исчезновения из меню.
// @author       kramvenseles
// @match        https://catwar.su/cw3*
// @match        https://*.catwar.su/cw3*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/kramvenseles/catwar-smell-cooldown
// @downloadURL  https://raw.githubusercontent.com/kramvenseles/catwar-smell-cooldown/main/cooldown.user.js
// @updateURL    https://raw.githubusercontent.com/kramvenseles/catwar-smell-cooldown/main/cooldown.user.js
// ==/UserScript==

// ВАЖНО: мод пассивный. Он НИЧЕГО не делает в игре за игрока — только наблюдает за меню
// действий и рисует поверх. Никакой автоматизации действий. (Соответствует линии проекта и
// нашему пониманию ОПИ; финальное слово — за согласованием с Почтовиком.)

(function () {
  'use strict';

  const VERSION = '0.3.3';

  // --- Что мы умеем считать -------------------------------------------------
  // Пока только навык «Нюх» (формула отката известна точно, см. docs/game-mechanics.md).
  // Остальные действия сюда добавятся по мере разбора таблиц откатов.
  const KNOWN = {
    13: { name: 'Принюхаться', skill: 'smell' }, // обнюхать землю/клетку
    14: { name: 'Обнюхать',    skill: 'smell' }, // обнюхать кота
  };

  // Длительность отката в секундах по навыку и его уровню.
  function cooldownSeconds(skill, level) {
    if (skill === 'smell') {
      // До УН 4 — фиксированный час; с УН 4 — 3600/(УН−2) (справка «Нюх», id 20).
      if (level < 4) return 3600;
      if (level >= 9) return 0;            // на 9 уровне отката нет
      return Math.round(3600 / (level - 2));
    }
    return 3600; // безопасный дефолт для будущих навыков
  }

  // --- Хранилище состояния (переживает перезагрузку) ------------------------
  // readyAt по id действия: epoch-мс, когда действие снова станет доступно.
  const LS_KEY = 'cwmod_cd_state';
  const DEMO_KEY = 'cwmod_cd_demo';
  const CALIB_PENDING_KEY = 'cwmod_cd_calib_pending'; // ждём фактического возврата для замера
  const CALIB_LOG_KEY = 'cwmod_cd_calib';             // накопленные замеры (переживают закрытие)

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch (e) { return {}; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }
  function loadState() { return loadJSON(LS_KEY); }
  function saveState(s) { saveJSON(LS_KEY, s); }
  let state = loadState();

  // Ожидания замера калибровки. Backfill: если откат уже идёт (state есть), а записи
  // замера нет (старая версия/первый запуск) — создаём её, чтобы НЕ потерять текущий запуск.
  let calibPending = loadJSON(CALIB_PENDING_KEY);
  for (const id of Object.keys(state)) {
    if (!calibPending[id]) calibPending[id] = { predicted: state[id], started: null, backfilled: true };
  }
  saveJSON(CALIB_PENDING_KEY, calibPending);
  // Видели ли действие на откате (отсутствующим в меню) в этой сессии. Замер считаем
  // «точным», только если видели — иначе возврат пойман «по факту открытия» (оценка-сверху).
  const sawAbsent = {};

  // Детектор сна/разрыва: если между тиками прошло сильно больше секунды — комп спал
  // или вкладка была заморожена. Замер считаем точным, только если в последние
  // RELIABLE_WINDOW_MS до возврата разрывов НЕ было (ранний сон точность не портит,
  // если мод работал вживую в момент возврата).
  let lastGapTs = 0;            // когда в последний раз был разрыв в работе
  let maxGapMs = 0;
  let lastTickTs = Date.now();
  const GAP_THRESHOLD_MS = 5000;
  const RELIABLE_WINDOW_MS = 120000; // 2 минуты непрерывной работы перед возвратом

  // --- Чтение уровня нюха из DOM --------------------------------------------
  // Навык рисуется как .skill#smell > .level (cw3.html).
  function readSkillLevel(skill) {
    const el = document.querySelector('#' + skill + ' .level');
    if (!el) return 0;
    const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // --- Наблюдение за меню действий ------------------------------------------
  // #akten — контейнер с кнопками-действиями <a class="dey" data-id="...">.
  // Логика старта отката привязана к РЕАЛЬНОМУ выполнению действия, а не к простому
  // исчезновению из меню (иначе переход в другую локацию, где действия нет, даст
  // ложный откат). Машина состояний:
  //   клик по действию → pending[id]  →  меню скрылось (пошёл каст) → sawCast
  //   → меню вернулось: id отсутствует = выполнено → старт отката; id есть = отмена/нет отката.
  const pending = new Set(); // id, по которым кликнули и ждём исхода
  let sawCast = false;       // между кликом и возвратом меню был «каст» (меню пряталось)
  let menuVisiblePrev = false;

  function DEBUG() { return localStorage.getItem('cwmod_cd_debug') === '1'; }
  function log(...a) { if (DEBUG()) console.log('[cwmod-cd]', ...a); }

  function presentKnownIds(akten) {
    const set = new Set();
    akten.querySelectorAll('a.dey[data-id]').forEach(a => {
      const id = parseInt(a.getAttribute('data-id'), 10);
      if (KNOWN[id]) set.add(id);
    });
    return set;
  }

  function startCooldown(id) {
    const skill = KNOWN[id].skill;
    const level = readSkillLevel(skill);
    const secs = cooldownSeconds(skill, level);
    if (secs <= 0) { log('действие', id, 'без отката (ур.', level, ')'); return; }
    const now = Date.now();
    state[id] = now + secs * 1000;
    saveState(state);
    maxGapMs = 0; // новая серия наблюдения
    // кладём «ожидание замера» — переживёт закрытие компа, снимется при фактическом возврате
    calibPending[id] = { predicted: state[id], started: now, level: level, skill: skill, backfilled: false };
    saveJSON(CALIB_PENDING_KEY, calibPending);
    log('старт отката', KNOWN[id].name, '| навык', skill, 'ур.', level,
        '| длительность', secs, 'с | вернётся в', new Date(state[id]).toLocaleTimeString());
  }

  // Фактический возврат действия → записываем замер в постоянный лог.
  function recordCalib(id, now) {
    const p = calibPending[id];
    if (!p) return;
    const deltaSec = Math.round((now - p.predicted) / 1000);
    const entry = {
      action: id, name: KNOWN[id] ? KNOWN[id].name : String(id),
      level: p.level != null ? p.level : null,
      predicted: new Date(p.predicted).toLocaleString(),
      observed: new Date(now).toLocaleString(),
      deltaSec: deltaSec,
      // Надёжность замера:
      //  - backfill / не видели действие на откате → возврат «по факту открытия» → верхняя оценка;
      //  - разрыв в последние RELIABLE_WINDOW_MS → возврат мог быть пойман сразу после пробуждения;
      //  - иначе мод видел откат вживую и работал перед возвратом → точный.
      via: (p.backfilled || !sawAbsent[id]) ? 'оценка-сверху (было доступно при открытии)'
           : ((now - lastGapTs) < RELIABLE_WINDOW_MS) ? 'неточный (возврат сразу после разрыва)'
           : 'точный (пойман вживую)',
      presenceSec: Math.round((now - lastGapTs) / 1000), // сколько непрерывно работал до возврата
      note: p.backfilled ? 'запуск подхвачен backfill' : '',
    };
    const logArr = (() => { try { return JSON.parse(localStorage.getItem(CALIB_LOG_KEY)) || []; } catch (e) { return []; } })();
    logArr.push(entry);
    saveJSON(CALIB_LOG_KEY, logArr);
    delete calibPending[id];
    saveJSON(CALIB_PENDING_KEY, calibPending);
    log('ЗАМЕР записан:', KNOWN[id] ? KNOWN[id].name : id,
        '| расхождение', deltaSec, 'с |', entry.via);
  }

  function scan() {
    const akten = document.getElementById('akten');
    const visible = !!akten;

    if (!visible) {
      // меню скрыто (каст другого/этого действия, иной вид). Если ждём исход клика —
      // значит каст реально пошёл.
      if (menuVisiblePrev && pending.size) sawCast = true;
      menuVisiblePrev = false;
      return;
    }

    const cur = presentKnownIds(akten);
    const now = Date.now();

    // Отмечаем, что видели действие на откате (отсутствует в открытом меню) — это делает
    // будущий замер его возврата «точным», а не «оценкой-сверху».
    for (const idStr of Object.keys(KNOWN)) {
      const kid = parseInt(idStr, 10);
      if (!cur.has(kid)) sawAbsent[kid] = true;
    }

    // Разрешаем исход ожидающих действий только после того, как был каст (меню пряталось).
    if (!menuVisiblePrev && sawCast && pending.size) {
      for (const id of [...pending]) {
        if (!cur.has(id)) startCooldown(id); // выполнено → откат
        else log('действие', id, 'вернулось сразу — отмена/без отката');
        pending.delete(id);
      }
      sawCast = false;
    }

    // Сервер снова показал действие → фактический возврат. Снимаем отображение и
    // записываем замер калибровки (если его ждали — в т.ч. с прошлой сессии).
    for (const id of cur) {
      if (state[id]) { delete state[id]; saveState(state); }
      if (calibPending[id]) recordCalib(id, now);
    }

    menuVisiblePrev = true;
  }

  // Клик по кнопке действия: запоминаем намерение выполнить (если это известный откат).
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.dey[data-id]');
    if (!a) return;
    const id = parseInt(a.getAttribute('data-id'), 10);
    if (KNOWN[id]) { pending.add(id); sawCast = false; log('клик по', KNOWN[id].name); }
  }, true);

  // --- Отрисовка «призрачных» серых кнопок с отсчётом -----------------------
  function fmt(ms) {
    if (ms <= 0) return '0:00';
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // Серый «призрак» действия. Используем родной класс .dey, чтобы размер и отступы
  // совпали с настоящими кнопками (встаёт в тот же ряд как ещё один слот).
  function makeChip(id, leftMs) {
    const a = document.createElement('a');
    a.className = 'dey';
    a.setAttribute('data-cwmod-cd', id); // маркер нашего узла (не data-id — чтобы scan его не считал)
    a.href = '#';
    a.style.cssText = 'position:relative;pointer-events:none;opacity:.55;filter:grayscale(1);';
    a.title = KNOWN[id].name + ' — доступно через ' + fmt(leftMs);
    const img = document.createElement('img');
    img.src = 'actions/' + id + '.png';
    const t = document.createElement('div');
    t.textContent = fmt(leftMs);
    t.style.cssText = 'position:absolute;left:0;right:0;bottom:0;text-align:center;' +
                      'font:bold 13px/1.5 sans-serif;color:#fff;background:rgba(0,0,0,.55);';
    a.appendChild(img);
    a.appendChild(t);
    return a;
  }

  function render() {
    const now = Date.now();
    // чистим истёкшие откаты
    for (const idStr of Object.keys(state)) {
      if (!KNOWN[idStr] || state[idStr] <= now) { delete state[idStr]; saveState(state); }
    }
    // снимаем свои прошлые призраки (перерисуем заново с новым временем)
    document.querySelectorAll('[data-cwmod-cd]').forEach(n => n.remove());

    // Рисуем ТОЛЬКО когда меню действий реально на экране (#akten есть). Если идёт
    // «каст» другого действия или открыт другой вид — меню скрыто, и призрака быть не должно.
    const parent = document.getElementById('akten');
    if (!parent) return;

    for (const idStr of Object.keys(state)) {
      const id = parseInt(idStr, 10);
      parent.appendChild(makeChip(id, state[id] - now));
    }
  }

  // --- Демо-режим (для показа Почтовику без ожидания реального часа) ---------
  // Включение: localStorage.cwmod_cd_demo = '1' или кнопка «демо» внизу.
  function demoFire() {
    state[13] = Date.now() + 30 * 1000; // фейковый 30-секундный откат «Принюхаться»
    saveState(state);
    render();
  }
  function mountDemoButton() {
    if (localStorage.getItem(DEMO_KEY) !== '1') return;
    const btn = document.createElement('button');
    btn.textContent = '🧪 демо кулдаун (30 с)';
    btn.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:4px 8px;' +
                        'font:12px sans-serif;cursor:pointer;';
    btn.addEventListener('click', demoFire);
    document.body.appendChild(btn);
  }

  // --- Самопроверка (вызывать в консоли: cwmodCd.selfcheck()) ----------------
  // Подтверждает перед первым реальным кликом, что версия правильная и селекторы
  // цепляются за живой DOM. Не выполняет никаких действий — только читает.
  function selfcheck() {
    const akten = document.getElementById('akten');
    const ids = akten ? [...akten.querySelectorAll('a.dey[data-id]')]
                          .map(a => parseInt(a.getAttribute('data-id'), 10)) : null;
    const lvlEl = document.querySelector('#smell .level');
    const level = lvlEl ? parseInt((lvlEl.textContent || '').replace(/[^\d]/g, ''), 10) : null;
    const r = {
      version: VERSION,
      akten_найден: !!akten,
      tr_actions_найден: !!document.getElementById('tr_actions'),
      действия_в_меню: ids,
      принюхаться_13_в_меню: !!(ids && ids.includes(13)),
      уровень_нюха: level,
      расчётный_откат_сек: (level != null) ? cooldownSeconds('smell', level) : null,
      всё_готово: !!(akten && document.getElementById('tr_actions') && ids && ids.includes(13) && level != null),
    };
    (console.table || console.log)(r);
    return r;
  }

  // --- Запуск ----------------------------------------------------------------
  const mo = new MutationObserver(() => scan());
  function boot() {
    const root = document.getElementById('tr_actions') || document.body;
    mo.observe(root, { childList: true, subtree: true });
    scan();
    mountDemoButton();
    setInterval(() => {
      const now = Date.now();
      const gap = now - lastTickTs;
      if (gap > GAP_THRESHOLD_MS) { lastGapTs = now; if (gap > maxGapMs) maxGapMs = gap; }
      lastTickTs = now;
      scan(); render();
    }, 1000);
    render();
    window.cwmodCd = {
      version: VERSION,
      selfcheck,
      state: () => state,
      // Прочитать накопленные замеры калибровки (переживают закрытие компа).
      calib: () => {
        let arr = []; try { arr = JSON.parse(localStorage.getItem(CALIB_LOG_KEY)) || []; } catch (e) {}
        (arr.length ? (console.table || console.log) : console.log)(arr.length ? arr : 'замеров пока нет');
        return arr;
      },
      // Что ещё ждёт фактического возврата (напр. текущий запуск).
      pending: () => { console.log(calibPending); return calibPending; },
    };
    console.log('[cwmod-cd] версия ' + VERSION + ' загружена. ' +
                'Проверка: cwmodCd.selfcheck() | Замеры: cwmodCd.calib()');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
