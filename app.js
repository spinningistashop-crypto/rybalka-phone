'use strict';
/* Код Спиннингиста — запись уловов на телефоне. Работает без интернета, всё хранится на телефоне. */
const APP_VERSION = '1.1';
const FORMAT_PHONE = 'rybalka-phone-v1';
const FORMAT_CATALOG = 'rybalka-catalog-v1';
const CONDS = ['С берега', 'С лодки', 'Со льда'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const fmtDate = iso => iso.split('-').reverse().join('.');
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const byRu = (a, b) => a.localeCompare(b, 'ru');

/* ------------------------------ хранилище на телефоне (IndexedDB) ------------------------------ */
let _db = null;
function openDB() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const r = indexedDB.open('rybalka-phone', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('entries', { keyPath: 'uid' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _db;
}
function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
const entGet = uid => tx('entries', 'readonly', s => s.get(uid));
const entPut = e => tx('entries', 'readwrite', s => s.put(e));
const entDel = uid => tx('entries', 'readwrite', s => s.delete(uid));
const entAll = () => tx('entries', 'readonly', s => s.getAll());

/* ------------------------------ состояние ------------------------------ */
let catalog = null;          // справочник, полученный с Mac
let editingUid = null;       // какой выезд сейчас правим
let cond = CONDS[0];
let recent = [];             // недавно использованные приманки
let prepared = null;         // заранее собранный файл для отправки
let storageOk = null;        // проверка, что телефон сохраняет данные

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.style.display = 'none'; }, isErr ? 5500 : 2600);
}

/* ------------------------------ вкладки и тема ------------------------------ */
function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.bar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'list') refreshList();
  if (name === 'more') renderMore();
  window.scrollTo(0, 0);
}
$$('.bar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

const THEME_KEY = 'rybalka-phone-theme';
function paintThemeBtn() { $('#themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'; }
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  paintThemeBtn();
});

/* ------------------------------ справочник ------------------------------ */
const waterNames = () => (catalog ? catalog.waters.slice().sort(byRu) : []);
const spotNames = w => (catalog ? catalog.spots.filter(s => s.water === w).map(s => s.name).sort(byRu) : []);
const speciesNames = () => (catalog ? catalog.species.slice().sort(byRu) : []);
const lureKey = l => l.brand + '|' + l.model;
const lureLabel = l => l.brand + ' — ' + l.model;
const findLure = (brand, model) => (catalog ? catalog.lures.find(l => l.brand === brand && l.model === model) : null);

function searchLures(q) {
  if (!catalog) return [];
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    const seen = new Set(), out = [];
    recent.concat((catalog.recent_lures || []).map(l => lureKey(l))).forEach(k => {
      if (seen.has(k)) return; seen.add(k);
      const [b, ...m] = k.split('|'); const l = findLure(b, m.join('|'));
      if (l) out.push(l);
    });
    return out.slice(0, 8);
  }
  return catalog.lures.filter(l => { const hay = lureLabel(l).toLowerCase(); return tokens.every(t => hay.includes(t)); }).slice(0, 8);
}

async function setCatalog(obj, silent) {
  if (!obj || obj.format !== FORMAT_CATALOG || !Array.isArray(obj.waters) || !Array.isArray(obj.lures)) {
    throw new Error('Это не файл справочника. Нужен файл «Справочник для телефона» из приложения на Mac.');
  }
  catalog = obj;
  await kvSet('catalog', obj);
  fillWater();
  $$('#catches .catch').forEach(refreshSpecies);
  renderMore(); updateBanners();
  if (!silent) toast(`Справочник загружен: водоёмов ${obj.waters.length}, приманок ${obj.lures.length}`);
}

/* ------------------------------ форма: шапка выезда ------------------------------ */
function paintCond() {
  $$('#fCond button').forEach(b => b.classList.toggle('on', b.dataset.c === cond));
}
function initCond() {
  const box = $('#fCond');
  box.innerHTML = CONDS.map(c => `<button type="button" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  box.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { cond = b.dataset.c; paintCond(); } });
  paintCond();
}
function fillSelect(sel, values, before, after, keep) {
  const prev = keep === undefined ? sel.value : keep;
  sel.innerHTML = '';
  before.concat(values.map(v => [v, v])).concat(after).forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
  });
  if ($$('option', sel).some(o => o.value === prev)) sel.value = prev;
}
function fillWater(keep) {
  const has = waterNames().length > 0;
  fillSelect($('#fWater'), waterNames(), has ? [['', '— выбери водоём —']] : [], [['__new__', '＋ Другой водоём…']], keep);
  if (!has) $('#fWater').value = '__new__';
  onWater();
}
function onWater(keepSpot) {
  const isNew = $('#fWater').value === '__new__';
  $('#fWaterNew').classList.toggle('hidden', !isNew);
  fillSelect($('#fSpot'), isNew ? [] : spotNames($('#fWater').value), [['', '— без места —']], [['__new__', '＋ Другое место…']], keepSpot);
  onSpot();
}
function onSpot() { $('#fSpotNew').classList.toggle('hidden', $('#fSpot').value !== '__new__'); }
$('#fWater').addEventListener('change', () => onWater(''));
$('#fSpot').addEventListener('change', onSpot);

/* ------------------------------ форма: карточки уловов ------------------------------ */
function compressImage(file, max = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось обработать фото')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
    img.src = url;
  });
}
const blobToDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

function refreshSpecies(el) {
  const c = el._c, names = speciesNames();
  const known = names.includes(c.species);
  const otherMode = c.otherSpecies || !names.length || (c.species && !known);
  $('.sp-chips', el).innerHTML = names.map(n => `<button type="button" class="chip${!otherMode && c.species === n ? ' on' : ''}" data-s="${esc(n)}">${esc(n)}</button>`).join('')
    + `<button type="button" class="chip${otherMode ? ' on' : ''}" data-s="__other__">＋ другая</button>`;
  const inp = $('.sp-new', el);
  inp.classList.toggle('hidden', !otherMode);
  if (otherMode && c.species && !known && !inp.value) inp.value = c.species;
}

function addCatch(init) {
  const c = Object.assign({ lure: null, species: '', otherSpecies: false, qty: 1, weight: '', photo: null }, init || {});
  const el = document.createElement('div');
  el.className = 'card catch'; el._c = c;
  el.innerHTML = `
    <div class="row-head"><b class="ctitle"></b><button class="link rm" type="button">убрать</button></div>
    <div class="lure-box">
      <label>Приманка<input class="lure-q" placeholder="Начни вводить бренд или модель" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <div class="suggest"></div>
    </div>
    <div class="chosen hidden"><span class="ch-text"></span><button class="link ch-x" type="button">✕</button></div>
    <button class="link nl-toggle" type="button">Приманки нет в списке</button>
    <div class="newlure hidden">
      <div class="two"><label>Бренд<input class="nl-brand"></label><label>Модель<input class="nl-model"></label></div>
      <div class="two"><label>Категория<input class="nl-cat" placeholder="Воблеры…"></label><label>Тип<input class="nl-type" placeholder="Минноу…"></label></div>
    </div>
    <div class="field-title">Рыба</div>
    <div class="chips sp-chips"></div>
    <input class="sp-new hidden" placeholder="Название рыбы" style="margin-bottom:12px;">
    <div class="two">
      <div><div class="field-title">Количество</div>
        <div class="stepper"><button type="button" class="qm">−</button><output class="qv">1</output><button type="button" class="qp">＋</button></div></div>
      <label>Вес, г (необязательно)<input class="weight" type="number" inputmode="numeric" min="1"></label>
    </div>
    <div class="photo-row">
      <label class="btn ghost filebtn" style="margin:0;">📷 Фото<input class="photo" type="file" accept="image/*" hidden></label>
      <img class="pthumb hidden" alt=""><button class="link ph-x hidden" type="button">убрать</button>
    </div>`;
  $('#catches').appendChild(el);

  const lureQ = $('.lure-q', el), sug = $('.suggest', el);
  const showSuggest = () => {
    sug.innerHTML = searchLures(lureQ.value).map(l =>
      `<button type="button" class="sug" data-k="${esc(lureKey(l))}">${esc(lureLabel(l))}<small>${esc(l.category)} · ${esc(l.type)}</small></button>`).join('');
  };
  const chooseLure = l => {
    c.lure = { brand: l.brand, model: l.model, category: l.category, type: l.type };
    $('.ch-text', el).textContent = lureLabel(l);
    $('.chosen', el).classList.remove('hidden'); $('.lure-box', el).classList.add('hidden');
    $('.nl-toggle', el).classList.add('hidden'); $('.newlure', el).classList.add('hidden');
  };
  lureQ.addEventListener('input', showSuggest);
  lureQ.addEventListener('focus', showSuggest);
  sug.addEventListener('click', e => {
    const b = e.target.closest('.sug'); if (!b) return;
    const [br, ...m] = b.dataset.k.split('|'); const l = findLure(br, m.join('|')); if (l) chooseLure(l);
  });
  $('.ch-x', el).addEventListener('click', () => {
    c.lure = null; $('.chosen', el).classList.add('hidden'); $('.lure-box', el).classList.remove('hidden');
    $('.nl-toggle', el).classList.remove('hidden'); lureQ.value = ''; showSuggest();
  });
  $('.nl-toggle', el).addEventListener('click', () => $('.newlure', el).classList.toggle('hidden'));

  $('.sp-chips', el).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.s === '__other__') { c.otherSpecies = true; c.species = ''; }
    else { c.otherSpecies = false; c.species = b.dataset.s; $('.sp-new', el).value = ''; }
    refreshSpecies(el);
    if (c.otherSpecies) $('.sp-new', el).focus();
  });
  const qv = $('.qv', el);
  $('.qm', el).addEventListener('click', () => { c.qty = Math.max(1, c.qty - 1); qv.textContent = c.qty; });
  $('.qp', el).addEventListener('click', () => { c.qty += 1; qv.textContent = c.qty; });

  const thumb = $('.pthumb', el), phx = $('.ph-x', el);
  const showPhoto = () => {
    if (thumb._url) URL.revokeObjectURL(thumb._url);
    if (c.photo) { thumb._url = URL.createObjectURL(c.photo); thumb.src = thumb._url; }
    thumb.classList.toggle('hidden', !c.photo); phx.classList.toggle('hidden', !c.photo);
  };
  $('.photo', el).addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { c.photo = await compressImage(f); showPhoto(); } catch (err) { toast(err.message, true); }
    e.target.value = '';
  });
  phx.addEventListener('click', () => { c.photo = null; showPhoto(); });
  $('.rm', el).addEventListener('click', () => { el.remove(); if (!$$('#catches .catch').length) addCatch(); renumber(); });

  // восстановление при правке записи
  qv.textContent = c.qty;
  if (c.weight) $('.weight', el).value = c.weight;
  if (c.lure) {
    if (findLure(c.lure.brand, c.lure.model)) chooseLure(c.lure);
    else {
      $('.newlure', el).classList.remove('hidden');
      $('.nl-brand', el).value = c.lure.brand; $('.nl-model', el).value = c.lure.model;
      $('.nl-cat', el).value = c.lure.category || ''; $('.nl-type', el).value = c.lure.type || '';
    }
  }
  showPhoto(); refreshSpecies(el); renumber();
  return el;
}
function renumber() { $$('#catches .catch').forEach((el, i) => { $('.ctitle', el).textContent = 'Улов ' + (i + 1); }); }
$('#addCatch').addEventListener('click', () => { const el = addCatch(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

/* ------------------------------ сохранение выезда ------------------------------ */
function collectEntry() {
  const date = $('#fDate').value;
  if (!date) throw new Error('Укажи дату');
  const wsel = $('#fWater').value;
  const water = wsel === '__new__' ? $('#fWaterNew').value.trim() : wsel;
  if (!water) throw new Error('Выбери водоём');
  const ssel = $('#fSpot').value;
  const spot = ssel === '__new__' ? $('#fSpotNew').value.trim() : ssel;

  const catches = $$('#catches .catch').map((el, i) => {
    const c = el._c, n = i + 1;
    let lure;
    const nb = $('.nl-brand', el).value.trim(), nm = $('.nl-model', el).value.trim();
    const nlOpen = !$('.newlure', el).classList.contains('hidden');
    if (nlOpen && (nb || nm)) {
      if (!nb || !nm) throw new Error(`Улов ${n}: у новой приманки нужны бренд и модель`);
      lure = { brand: nb, model: nm, category: $('.nl-cat', el).value.trim(), type: $('.nl-type', el).value.trim() };
    } else if (c.lure) {
      lure = { brand: c.lure.brand, model: c.lure.model, category: c.lure.category, type: c.lure.type };
    } else throw new Error(`Улов ${n}: выбери приманку`);
    const otherVisible = !$('.sp-new', el).classList.contains('hidden');
    const sp = otherVisible ? $('.sp-new', el).value.trim() : c.species;
    if (!sp) throw new Error(`Улов ${n}: выбери рыбу`);
    const w = parseInt($('.weight', el).value, 10);
    return { lure, species: { name: sp }, qty: c.qty, weight_g: w > 0 ? w : null, photo: c.photo || null };
  });
  return { date, condition: cond, water: { name: water }, spot: spot ? { name: spot } : null, catches };
}

async function saveTrip() {
  let e;
  try { e = collectEntry(); } catch (err) { toast(err.message, true); return; }
  const old = editingUid ? await entGet(editingUid) : null;
  const entry = Object.assign({ uid: editingUid || uuid(), created: old ? old.created : Date.now(), updated: Date.now(), status: 'pending', exported_at: null }, e);
  await entPut(entry);
  e.catches.forEach(c => { const k = lureKey(c.lure); recent = [k].concat(recent.filter(x => x !== k)).slice(0, 12); });
  await kvSet('recent', recent);
  await kvSet('last', { water: $('#fWater').value, waterNew: $('#fWaterNew').value, spot: $('#fSpot').value, cond });
  endEdit();
  $('#catches').innerHTML = ''; addCatch();
  schedulePrepare(); updateBadge();
  toast(old ? 'Изменения сохранены ✅' : 'Выезд сохранён ✅ Уловов: ' + e.catches.length);
  window.scrollTo(0, 0);
}
$('#saveTrip').addEventListener('click', saveTrip);

function endEdit() { editingUid = null; $('#editBanner').classList.add('hidden'); $('#saveTrip').textContent = 'Сохранить выезд'; }
$('#cancelEdit').addEventListener('click', () => { endEdit(); $('#catches').innerHTML = ''; addCatch(); });

async function startEdit(uid) {
  const e = await entGet(uid); if (!e) return;
  editingUid = uid;
  $('#fDate').value = e.date; cond = e.condition; paintCond();
  const w = e.water.name;
  if (waterNames().includes(w)) { fillWater(w); $('#fWater').value = w; onWater(''); }
  else { fillWater('__new__'); $('#fWater').value = '__new__'; onWater(''); $('#fWaterNew').value = w; }
  if (e.spot) {
    if (spotNames($('#fWater').value).includes(e.spot.name)) $('#fSpot').value = e.spot.name;
    else { $('#fSpot').value = '__new__'; onSpot(); $('#fSpotNew').value = e.spot.name; }
  } else $('#fSpot').value = '';
  onSpot();
  $('#catches').innerHTML = '';
  e.catches.forEach(c => addCatch({ lure: c.lure, species: c.species.name, qty: c.qty, weight: c.weight_g || '', photo: c.photo || null }));
  $('#editBanner').classList.remove('hidden'); $('#saveTrip').textContent = 'Сохранить изменения';
  showView('new');
}

/* ------------------------------ вкладка «Выезды» ------------------------------ */
async function updateBadge() {
  const pend = (await entAll()).filter(e => e.status !== 'exported').length;
  const b = $('#badge'); b.textContent = pend; b.classList.toggle('hidden', pend === 0);
}
const entryHtml = e => {
  const lines = e.catches.map(c => `${esc(c.species.name)} ×${c.qty}${c.weight_g ? ' · ' + c.weight_g + ' г' : ''}${c.photo ? ' · 📷' : ''} — ${esc(c.lure.brand)} ${esc(c.lure.model)}`).join('<br>');
  return `<div class="entry" data-uid="${esc(e.uid)}"><b>${esc(fmtDate(e.date))}</b> · ${esc(e.water.name)}${e.spot ? ', ' + esc(e.spot.name) : ''} · ${esc(e.condition)}
    <small>${lines}</small><div class="acts"><button data-act="edit">✏️ Изменить</button><button data-act="del">🗑 Удалить</button></div></div>`;
};
async function refreshList() {
  const all = (await entAll()).sort((a, b) => b.date.localeCompare(a.date) || b.updated - a.updated);
  const pend = all.filter(e => e.status !== 'exported'), sent = all.filter(e => e.status === 'exported');
  $('#pendingBox').innerHTML = pend.length
    ? `<div class="card"><h3>Ждут отправки (${pend.length})</h3>${pend.map(entryHtml).join('')}</div>`
    : '<div class="card"><p class="hint">Пока нет записей, ожидающих отправки.</p></div>';
  $('#sentBox').innerHTML = sent.length
    ? `<div class="card"><h3>Отправлено на Mac (${sent.length})</h3>${sent.map(entryHtml).join('')}
        <button id="clearSent" class="btn primary wide" style="margin-top:12px;">✅ Загрузил на Mac — убрать отправленные</button>
        <button id="resendAll" class="btn ghost wide">Отправить ещё раз</button></div>` : '';
  $('#sendBtn').disabled = pend.length === 0;
  $('#sendHint').textContent = pend.length ? `К отправке: ${pend.length}. Файл откроется в окне «Поделиться» — выбери AirDrop и свой Mac.`
    : 'Когда появятся записи, их можно будет отправить на Mac.';
  updateBadge();
  if (pend.length && !prepared) schedulePrepare();
}
$('#view-list').addEventListener('click', async e => {
  const act = e.target.closest('button[data-act]');
  if (act) {
    const uid = act.closest('.entry').dataset.uid;
    if (act.dataset.act === 'edit') return startEdit(uid);
    if (act.dataset.act === 'del' && confirm('Удалить этот выезд с телефона?')) { await entDel(uid); schedulePrepare(); refreshList(); }
    return;
  }
  if (e.target.id === 'clearSent' && confirm('Убрать с телефона все отправленные записи? Убедись, что они загружены на Mac.')) {
    for (const x of (await entAll()).filter(x => x.status === 'exported')) await entDel(x.uid);
    refreshList(); toast('Отправленные записи убраны');
  }
  if (e.target.id === 'resendAll') sendToMac(true);
});

/* ------------------------------ отправка на Mac ------------------------------ */
async function buildExportFile(entries) {
  const out = { format: FORMAT_PHONE, exported_at: new Date().toISOString(), app_version: APP_VERSION, entries: [] };
  for (const e of entries) {
    const copy = { uid: e.uid, date: e.date, condition: e.condition, water: e.water, spot: e.spot, catches: [] };
    for (const c of e.catches) {
      copy.catches.push({ lure: c.lure, species: c.species, qty: c.qty, weight_g: c.weight_g, photo: c.photo ? await blobToDataURL(c.photo) : null });
    }
    out.entries.push(copy);
  }
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return new File([JSON.stringify(out)], `rybalka_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`, { type: 'application/json' });
}
let prepTimer = null;
function schedulePrepare() {
  prepared = null; clearTimeout(prepTimer);
  prepTimer = setTimeout(async () => {
    const pend = (await entAll()).filter(e => e.status !== 'exported');
    if (!pend.length) return;
    try { prepared = { file: await buildExportFile(pend), uids: pend.map(e => e.uid).sort().join(',') }; } catch (err) { prepared = null; }
  }, 250);
}
function download(file) {
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function sendToMac(resendAll) {
  const all = await entAll();
  const list = all.filter(e => resendAll || e.status !== 'exported');
  if (!list.length) return;
  const key = list.map(e => e.uid).sort().join(',');
  let pack = (!resendAll && prepared && prepared.uids === key) ? prepared : null;
  if (!pack) {
    toast('Готовлю файл…');
    pack = { file: await buildExportFile(list), uids: key };
    if (!resendAll) prepared = pack;
  }
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [pack.file] })) {
    try { await navigator.share({ files: [pack.file], title: 'Записи с рыбалки' }); done = true; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  if (!done) download(pack.file);
  for (const e of list) { if (e.status !== 'exported') { e.status = 'exported'; e.exported_at = Date.now(); await entPut(e); } }
  prepared = null;
  toast('Файл передан. Загрузи его на Mac: «Данные» → «Записи с телефона».');
  refreshList();
}
$('#sendBtn').addEventListener('click', () => sendToMac(false));

/* ------------------------------ вкладка «Ещё» ------------------------------ */
function renderMore() {
  $('#catStatus').textContent = catalog
    ? `Загружен ${catalog.exported_at ? fmtDate(catalog.exported_at.slice(0, 10)) : ''}: водоёмов ${catalog.waters.length}, мест ${catalog.spots.length}, приманок ${catalog.lures.length}, видов ${catalog.species.length}.`
    : 'Справочник ещё не загружен. Без него можно вводить названия вручную, но с ним быстрее и без опечаток.';
  $('#aboutInfo').textContent = `Версия ${APP_VERSION}. ${isStandalone() ? 'Открыто со значка.' : 'Открыто в Safari (лучше со значка на экране «Домой»).'} `
    + `Хранилище телефона: ${storageOk === null ? 'проверяю…' : storageOk ? 'работает' : 'НЕ РАБОТАЕТ — записи не сохранятся'}. `
    + 'Записи хранятся только на этом телефоне, пока ты не отправишь их на Mac.';
}
function parseCatalogText(t) {
  try { return JSON.parse(String(t).trim()); }
  catch (e) { throw new Error('Не удалось прочитать справочник: нужен текст/файл «Справочник для телефона» из приложения на Mac.'); }
}
$$('.cat-file').forEach(inp => inp.addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await setCatalog(parseCatalogText(await f.text())); } catch (err) { toast(err.message || 'Не удалось прочитать файл', true); }
  e.target.value = '';
}));
$$('.cat-paste').forEach(b => b.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    await setCatalog(parseCatalogText(t));
  } catch (err) {
    if (err && /справочник/i.test(err.message || '')) { toast(err.message, true); return; }
    toast('Не удалось прочитать буфер обмена. Открой «Ещё» и вставь текст справочника вручную.', true);
    showView('more'); setTimeout(() => $('#catText').focus(), 200);
  }
}));
$('#catTextBtn').addEventListener('click', async () => {
  try { await setCatalog(parseCatalogText($('#catText').value)); $('#catText').value = ''; } catch (err) { toast(err.message || 'Не получилось', true); }
});
$('#catHelp').addEventListener('click', () => showView('more'));
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
async function updateBanners() {
  $('#catBanner').classList.toggle('hidden', !!catalog);
  let hide = false; try { hide = !!(await kvGet('hideSafari')); } catch (e) {}
  $('#safariBanner').classList.toggle('hidden', isStandalone() || hide);
}
$('#safariOk').addEventListener('click', async () => { try { await kvSet('hideSafari', 1); } catch (e) {} updateBanners(); });

/* ------------------------------ запуск ------------------------------ */
(async function init() {
  paintThemeBtn(); initCond();
  $('#fDate').value = todayIso();
  try {
    await kvSet('ping', Date.now()); storageOk = true;
  } catch (err) { storageOk = false; toast('Телефон не даёт сохранять данные в этом режиме: ' + err.message, true); }
  try {
    catalog = await kvGet('catalog') || null;
    recent = await kvGet('recent') || [];
    fillWater();
    const last = await kvGet('last');
    if (last) {
      if (last.cond) { cond = last.cond; paintCond(); }
      if (last.water && $$('option', $('#fWater')).some(o => o.value === last.water)) { $('#fWater').value = last.water; onWater(''); }
      if (last.water === '__new__') $('#fWaterNew').value = last.waterNew || '';
      if (last.spot && $$('option', $('#fSpot')).some(o => o.value === last.spot)) { $('#fSpot').value = last.spot; onSpot(); }
    }
  } catch (err) { toast('Не удалось открыть хранилище телефона: ' + err.message, true); fillWater(); }
  addCatch();
  updateBadge(); renderMore(); updateBanners();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
