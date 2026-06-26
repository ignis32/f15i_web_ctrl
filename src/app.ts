/**
 * F15i Web Client — main UI controller.
 */

import './style.css';
import { F15iTransport, type FxChainEntry, type TransportEvent } from './transport.js';
import {
  presetLabel, eqWireToDb, volToDb,
  wireToDisplayStr, wireMax, wireToSlider, sliderToWire,
  cmdGetDeviceInfo, cmdGetGlobalParams, cmdGetActiveInfo, cmdGetBatteryInfo,
  cmdGetPresetNames, cmdReadPreset, cmdGetFxParams,
  cmdSetFxParams, cmdSetGlobalParams,
  cmdRenameAmp, cmdSavePresetName, cmdLoadPreset, cmdFactoryReset,
  cmdFxAdd, cmdFxReplace, cmdFxRemove, cmdFxMove,
  cmdSelectTool, cmdGetDrumBpm, cmdDrumMute, cmdDrumPlayStop, cmdLooperAction,
  TOOL_TUNER, TOOL_DRUM, TOOL_LOOPER,
  LOOPER_RECORD, LOOPER_PLAY, LOOPER_STOP, LOOPER_UNDO, LOOPER_DELETE,
  GD_DRUM_SYNC,
  GD_BYPASS, GD_EQ_BAND, GD_GAIN, GD_SLEEP, GD_EQ_ENABLE,
  GD_BRIGHTNESS, GD_VSPACE, GD_LIGHTING, GD_LIGHT_COLOR, GD_LYRIC,
  MIXER_CH, LIGHTING_COLORS, LIGHTING_COLOR_NAMES, LIGHTING_MODE_NAMES,
  validateMnrsFile,
  mnrsSlotToEff, mnrsEffToSlot,
  type ParamDef, type MnrsSlot,
} from './protocol.js';
import {
  FX_CAT, CAT_COLOR, GNR_PARAMS, GIR_PARAMS, DRUM_TRACKS,
  getCatName, getEffectEntry,
  CAT_IDS,
} from './catalogue.js';

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const transport = new F15iTransport();

let _selectedSlot: number | null = null;
let _paramDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 150;

// MNRS slot cache: loaded on demand when Add dialog opens for cat 2/3, or param editor opens for MNRS
const _mnrsSlotCache: { gnr: MnrsSlot[]; gir: MnrsSlot[] } = { gnr: [], gir: [] };

async function _loadMnrsSlotCache(cat: 'gnr' | 'gir'): Promise<void> {
  if (!transport.isConnected) return;
  const slots = await transport.getMnrsSlots(cat);
  _mnrsSlotCache[cat] = slots;
}

async function _refreshChain(delayMs = 400): Promise<void> {
  await new Promise(r => setTimeout(r, delayMs));
  if (!transport.isConnected) return;
  await transport.write(cmdReadPreset(_loadedPreset));
}

// Active tool
let _activeTool: number = 0; // 0 = none, TOOL_TUNER/DRUM/LOOPER

// The preset the user explicitly loaded (or the startup preset).
let _loadedPreset = 1;

// Drum state
const _drumState = { bpm: 120, vol: 60, trackIdx: 0, playing: false, looperVol: 60 };

// Note names for tuner
const _NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function qs<T extends Element>(sel: string, ctx: ParentNode = document): T {
  const el = ctx.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}

function showToast(msg: string, type: 'ok' | 'error' | '' = '', ms = 2000): void {
  const el = qs<HTMLDivElement>('#toast');
  el.textContent = msg;
  el.className = type ? `show ${type}` : 'show';
  clearTimeout((el as any)._timer);
  (el as any)._timer = setTimeout(() => { el.className = ''; }, ms);
}

function setStatus(tx: string | null, rx: string | null): void {
  if (tx !== null) qs<HTMLElement>('#status-tx').textContent = `TX: ${tx}`;
  if (rx !== null) qs<HTMLElement>('#status-rx').textContent = `RX: ${rx}`;
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

qs<HTMLButtonElement>('#btn-connect').addEventListener('click', async () => {
  if (transport.isConnected) {
    await transport.disconnect();
  } else {
    try {
      await transport.connect();
    } catch (e: any) {
      showToast(String(e.message ?? e), 'error', 4000);
    }
  }
});

transport.on(async (e: TransportEvent) => {
  switch (e.type) {
    case 'connected':
      _onConnected();
      break;
    case 'disconnected':
      _onDisconnected();
      break;
    case 'preset_loaded':
      setStatus(null, `Preset loaded: ${e.parsed.name}`);
      renderFxChain();
      selectSlot(_selectedSlot);
      break;
    case 'fx_params':
      setStatus(null, `FxParams slot ${e.parsed.slot}`);
      _refreshSlotCard(e.parsed.slot);
      if (_selectedSlot === e.parsed.slot) renderParamEditor();
      break;
    case 'global_params':
      setStatus(null, 'Global params');
      _syncSettingsFromGlobal(e.d);
      break;
    case 'preset_names':
      renderPresetList();
      break;
    case 'fx_budget':
      break;
    case 'battery':
      qs<HTMLElement>('#battery-label').textContent = `Battery: ${e.pct}%`;
      setStatus(null, `Battery ${e.pct}%`);
      break;
    case 'tuner':
      _onTuner(e.raw, e.dev);
      break;
    case 'drum_state':
      break;
    case 'drum_bpm': {
      const bpm = Math.max(40, Math.min(260, e.bpm));
      _drumState.bpm = bpm;
      qs<HTMLInputElement>('#drum-bpm').value = String(bpm);
      qs<HTMLElement>('#drum-bpm-val').textContent = String(bpm);
      break;
    }
    case 'error':
      showToast(e.msg, 'error');
      break;
  }
});

async function _onConnected(): Promise<void> {
  const btnConnect = qs<HTMLButtonElement>('#btn-connect');
  btnConnect.textContent = 'Disconnect';
  btnConnect.classList.add('connected');

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function send(pkt: Uint8Array, label: string): Promise<void> {
    setStatus(label, null);
    await transport.write(pkt);
  }

  try {
    await send(cmdGetDeviceInfo(), 'GetDeviceInfo');
    await delay(300);
    await send(cmdGetActiveInfo(), 'GetActiveInfo');
    await delay(300);
    await send(cmdGetBatteryInfo(), 'GetBatteryInfo');
    await delay(300);
    await send(cmdGetGlobalParams(), 'GetGlobalParams');
    await delay(300);
    _loadedPreset = transport.state.activePreset || 1;
    await send(cmdGetPresetNames(1, 80), 'GetPresetNames');
    await delay(300);
    await send(cmdReadPreset(_loadedPreset), `ReadPreset ${_loadedPreset}`);
  } catch (e: any) {
    showToast(`Startup error: ${e.message ?? e}`, 'error', 4000);
  }
}

function _onDisconnected(): void {
  const btnConnect = qs<HTMLButtonElement>('#btn-connect');
  btnConnect.textContent = 'Connect';
  btnConnect.classList.remove('connected');
  qs<HTMLElement>('#battery-label').textContent = '';
  qs<HTMLElement>('#chain-empty').classList.remove('hidden');
  qs<HTMLElement>('#btn-add-fx').classList.add('hidden');
  renderFxChain();
  setStatus('—', '—');
  showToast('Disconnected', '', 2000);
}

// ---------------------------------------------------------------------------
// Preset list
// ---------------------------------------------------------------------------

function renderPresetList(): void {
  const ul = qs<HTMLUListElement>('#preset-list');
  ul.innerHTML = '';
  const names = transport.state.presetNames;
  for (let n = 1; n <= 80; n++) {
    const li = document.createElement('li');
    li.dataset.preset = String(n);
    const num = document.createElement('span');
    num.className = 'preset-num';
    num.textContent = presetLabel(n);
    li.appendChild(num);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = names[n] ?? '';
    li.appendChild(nameSpan);
    li.addEventListener('click', () => _loadPreset(n));
    ul.appendChild(li);
  }
  updatePresetHighlight(_loadedPreset);
}

function updatePresetHighlight(active: number): void {
  document.querySelectorAll('#preset-list li').forEach(el => {
    const li = el as HTMLLIElement;
    li.classList.toggle('active', li.dataset.preset === String(active));
  });
}

async function _loadPreset(n: number): Promise<void> {
  if (!transport.isConnected) return;
  _selectedSlot = null;
  _loadedPreset = n;
  updatePresetHighlight(n);
  const pkt = cmdLoadPreset(n, transport.state.globalParamsD);
  setStatus(`LoadPreset ${n}`, null);
  await transport.write(pkt);
  // Firmware sends 0x12 but not always 0x22 — request chain explicitly.
  _refreshChain(500);
}

// Populate initial preset list
for (let n = 1; n <= 80; n++) {
  const li = document.createElement('li');
  li.dataset.preset = String(n);
  const num = document.createElement('span');
  num.className = 'preset-num';
  num.textContent = presetLabel(n);
  li.appendChild(num);
  const nameSpan = document.createElement('span');
  nameSpan.textContent = '';
  li.appendChild(nameSpan);
  li.addEventListener('click', () => _loadPreset(n));
  qs<HTMLUListElement>('#preset-list').appendChild(li);
}

// ---------------------------------------------------------------------------
// FX chain
// ---------------------------------------------------------------------------

function renderFxChain(): void {
  const panel = qs<HTMLDivElement>('#fx-chain-panel');
  // Remove existing cards and arrows
  panel.querySelectorAll('.fx-slot-card, .fx-chain-arrow').forEach(el => el.remove());

  const chain = transport.state.fxChain;
  const addBtn = qs<HTMLButtonElement>('#btn-add-fx');
  const emptyLabel = qs<HTMLElement>('#chain-empty');

  if (!transport.isConnected) {
    emptyLabel.classList.remove('hidden');
    addBtn.classList.add('hidden');
    return;
  }

  // Connected: always show add button; hide the "connect to view" placeholder.
  emptyLabel.classList.add('hidden');
  addBtn.classList.remove('hidden');

  if (chain.length === 0) return;

  for (let i = 0; i < chain.length; i++) {
    if (i > 0) {
      const arrow = document.createElement('div');
      arrow.className = 'fx-chain-arrow';
      arrow.textContent = '→';
      panel.insertBefore(arrow, addBtn);
    }
    panel.insertBefore(_buildSlotCard(chain[i], i, chain.length), addBtn);
  }
}

function _buildSlotCard(entry: FxChainEntry, chainIdx: number, chainLen: number): HTMLDivElement {
  const { slot, catId, effIdx, enabled } = entry;
  const isMnrs = (catId === 2 || catId === 3) && effIdx >= 100;
  const catColor = CAT_COLOR[catId] ?? '#888';
  const catName = getCatName(catId);
  const effName = isMnrs
    ? (transport.state.mnrsNames[catId === 2 ? 1 : 2] ?? (catId === 2 ? 'GNR' : 'GIR'))
    : (getEffectEntry(catId, effIdx)?.[0] ?? `Effect ${effIdx}`);

  const card = document.createElement('div');
  card.className = 'fx-slot-card' + (enabled ? '' : ' disabled') + (isMnrs ? ' mnrs' : '');
  card.dataset.slot = String(slot);
  card.style.borderColor = slot === _selectedSlot ? 'var(--accent)' : '';
  if (slot === _selectedSlot) card.classList.add('selected');

  card.innerHTML = `
    <div class="fx-card-top">
      <span class="fx-cat-label" style="color:${catColor}">${catName}</span>
      <span class="fx-slot-num">S${slot}</span>
    </div>
    <div class="fx-card-mid">
      <div class="fx-name" title="${effName}">${effName}</div>
      <button class="fx-enable-toggle ${enabled ? 'on' : 'off'}" title="Enable/disable"></button>
    </div>
    <div class="fx-card-bottom">
      <button class="fx-move-btn" data-dir="-1" ${chainIdx === 0 ? 'disabled' : ''}>◀</button>
      <button class="fx-move-btn" data-dir="1"  ${chainIdx === chainLen - 1 ? 'disabled' : ''}>▶</button>
      <button class="fx-remove-btn" title="Remove">✕</button>
    </div>
  `;

  card.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.classList.contains('fx-enable-toggle')) return;
    if (t.classList.contains('fx-move-btn')) return;
    if (t.classList.contains('fx-remove-btn')) return;
    selectSlot(slot);
  });

  card.querySelector('.fx-enable-toggle')!.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _toggleEnable(slot);
  });

  card.querySelectorAll('.fx-move-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const dir = parseInt((btn as HTMLElement).dataset.dir ?? '0');
      _moveFx(chainIdx, dir);
    });
  });

  card.querySelector('.fx-remove-btn')!.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!window.confirm(`Remove ${effName}?`)) return;
    _removeFx(slot);
  });

  return card;
}

function _refreshSlotCard(slot: number): void {
  const existing = document.querySelector<HTMLElement>(`#fx-chain-panel .fx-slot-card[data-slot="${slot}"]`);
  if (!existing) return;
  const chain = transport.state.fxChain;
  const idx = chain.findIndex(e => e.slot === slot);
  if (idx < 0) return;
  // fxState has the freshest enabled/catId/effIdx; fxChain may lag behind.
  const st = transport.state.fxState.get(slot);
  const entry = st ? { ...chain[idx], enabled: st.enabled, catId: st.catId, effIdx: st.effIdx } : chain[idx];
  const fresh = _buildSlotCard(entry, idx, chain.length);
  existing.replaceWith(fresh);
}

function selectSlot(slot: number | null): void {
  _selectedSlot = slot;
  document.querySelectorAll('.fx-slot-card').forEach(c => {
    const el = c as HTMLElement;
    const isThis = el.dataset.slot === String(slot);
    el.classList.toggle('selected', isThis);
    el.style.borderColor = isThis ? 'var(--accent)' : '';
  });
  renderParamEditor();
}

async function _toggleEnable(slot: number): Promise<void> {
  if (!transport.isConnected) return;
  const st = transport.state.fxState.get(slot);
  if (!st) return;
  const newEnabled = st.enabled ? 0 : 1;
  // Update fxState and refresh the card optimistically before the send.
  transport.state.fxState.set(slot, { ...st, enabled: newEnabled });
  _refreshSlotCard(slot);
  const params = [newEnabled, st.effIdx, ...st.params];
  const pkt = cmdSetFxParams(slot, st.catId, params);
  setStatus(`FxEnable S${slot}`, null);
  await transport.write(pkt);
}

async function _moveFx(chainIdx: number, dir: number): Promise<void> {
  if (!transport.isConnected) return;
  const chain = transport.state.fxChain;
  const targetIdx = chainIdx + dir;
  if (targetIdx < 0 || targetIdx >= chain.length) return;
  const fromSlot = chain[chainIdx].slot;
  const toSlot   = chain[targetIdx].slot;
  const actionId = transport.nextActionId(3);
  const pkt = cmdFxMove(fromSlot, toSlot, actionId);
  setStatus(`Move S${fromSlot}→S${toSlot}`, null);
  await transport.write(pkt);
  _refreshChain();
}

async function _removeFx(slot: number): Promise<void> {
  if (!transport.isConnected) return;
  const actionId = transport.nextActionId(1);
  const pkt = cmdFxRemove(slot, actionId);
  setStatus(`Remove S${slot}`, null);
  await transport.write(pkt);
  if (_selectedSlot === slot) { _selectedSlot = null; renderParamEditor(); }
  _refreshChain();
}

qs<HTMLButtonElement>('#btn-add-fx').addEventListener('click', () => {
  if (!transport.isConnected) return;
  openAddEffectDialog();
});

// ---------------------------------------------------------------------------
// Param editor
// ---------------------------------------------------------------------------

function renderParamEditor(): void {
  const header = qs<HTMLElement>('#param-editor-header');
  const rows = qs<HTMLElement>('#param-rows');
  rows.innerHTML = '';

  const slot = _selectedSlot;
  if (!slot) {
    header.textContent = 'Select an effect to edit';
    return;
  }

  const st = transport.state.fxState.get(slot);
  if (!st) {
    header.textContent = `Slot ${slot} — no data`;
    return;
  }

  const { catId, effIdx } = st;
  const isMnrs = (catId === 2 || catId === 3) && effIdx >= 100;
  const catName = getCatName(catId);

  if (isMnrs) {
    const cacheKey = catId === 2 ? 'gnr' : 'gir';
    const slotNum = mnrsEffToSlot(effIdx) ?? 1;
    const cachedSlots = _mnrsSlotCache[cacheKey];
    const activeEntry = cachedSlots.find(c => c.slot === slotNum);
    const savedName = activeEntry?.name || transport.state.mnrsNames[catId === 2 ? 1 : 2] || (catId === 2 ? 'GNR' : 'GIR');
    header.textContent = `${catName} — Slot ${slotNum}: ${savedName} (MNRS)`;

    // Slot selector row
    const slotRow = document.createElement('div');
    slotRow.className = 'param-cat-row';
    slotRow.innerHTML = '<label>Slot</label>';
    const slotSel = document.createElement('select');
    if (cachedSlots.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'Loading…';
      slotSel.appendChild(opt);
    } else {
      for (let s = 1; s <= 10; s++) {
        const c = cachedSlots.find(x => x.slot === s);
        const opt = document.createElement('option');
        opt.value = String(s);
        opt.textContent = `${s}: ${c ? (c.occupied ? (c.name || '(unnamed)') : 'Empty') : 'Empty'}`;
        if (s === slotNum) opt.selected = true;
        opt.disabled = !(c?.occupied);
        slotSel.appendChild(opt);
      }
    }
    slotRow.appendChild(slotSel);
    rows.appendChild(slotRow);

    slotSel.addEventListener('change', async () => {
      const newSlot = parseInt(slotSel.value);
      const newEffIdx = mnrsSlotToEff(newSlot);
      if (newEffIdx === effIdx) return;
      const pkts = cmdFxReplace(slot, catId, newEffIdx,
        transport.nextActionId(2), catId, effIdx);
      setStatus(`MNRSSwitch S${slot} slot${newSlot}`, null);
      await transport.writeAll(pkts);
      await new Promise(r => setTimeout(r, 300));
      await transport.write(cmdGetFxParams(slot));
    });

    // Load slot names if cache is empty
    if (cachedSlots.length === 0 && transport.isConnected) {
      _loadMnrsSlotCache(cacheKey).then(() => renderParamEditor());
    }

    const paramList = catId === 2 ? GNR_PARAMS : GIR_PARAMS;
    _buildParamRows(rows, slot, catId, st.params, paramList);
    return;
  }

  // Non-MNRS: show cat + effect selectors, then params
  const catEntry = FX_CAT[catId];
  const effEntry = getEffectEntry(catId, effIdx);
  if (!catEntry || !effEntry) {
    header.textContent = `${catName} — Effect ${effIdx}`;
    return;
  }

  header.textContent = `${catName} — ${effEntry[0]}`;

  // Category selector
  const catRow = document.createElement('div');
  catRow.className = 'param-cat-row';
  catRow.innerHTML = `<label>Category</label>`;
  const catSel = document.createElement('select');
  for (const id of CAT_IDS) {
    const opt = document.createElement('option');
    opt.value = String(id);
    opt.textContent = getCatName(id);
    if (id === catId) opt.selected = true;
    catSel.appendChild(opt);
  }
  catRow.appendChild(catSel);
  rows.appendChild(catRow);

  // Effect selector
  const effRow = document.createElement('div');
  effRow.className = 'param-cat-row';
  effRow.innerHTML = `<label>Effect</label>`;
  const effSel = document.createElement('select');
  _populateEffectSelect(effSel, catId, effIdx);
  effRow.appendChild(effSel);
  rows.appendChild(effRow);

  catSel.addEventListener('change', async () => {
    const newCat = parseInt(catSel.value);
    _populateEffectSelect(effSel, newCat, 0);
  });

  effSel.addEventListener('change', async () => {
    if (!transport.isConnected) return;
    const newCat = parseInt(catSel.value);
    const newEff = parseInt(effSel.value);
    const newSt = transport.state.fxState.get(slot);
    if (!newSt) return;
    if (newCat === newSt.catId && newEff === newSt.effIdx) return;

    const entry = getEffectEntry(newCat, newEff);
    const defaults = entry ? entry[1].map(() => 50) : [];
    const params = [newSt.enabled, newEff, ...defaults];
    const pkts = cmdFxReplace(slot, newCat, newEff,
      transport.nextActionId(2), newSt.catId, newSt.effIdx);
    setStatus(`Replace S${slot}`, null);
    await transport.writeAll(pkts);
    // Request updated params
    await transport.write(cmdGetFxParams(slot));
  });

  // Param sliders
  _buildParamRows(rows, slot, catId, st.params, effEntry[1]);
}

function _populateEffectSelect(sel: HTMLSelectElement, catId: number, currentEff: number): void {
  sel.innerHTML = '';
  const cat = FX_CAT[catId];
  if (!cat) return;
  cat.effects.forEach(([name], idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = name;
    if (idx === currentEff) opt.selected = true;
    sel.appendChild(opt);
  });
}

function _buildParamRows(
  container: HTMLElement,
  slot: number,
  catId: number,
  wireVals: number[],
  params: ParamDef[],
): void {
  params.forEach((p, i) => {
    const wire = wireVals[i] ?? 0;
    const wMax = wireMax(p);

    const row = document.createElement('div');
    row.className = 'param-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'param-name';
    nameEl.textContent = p.name;
    nameEl.title = p.name;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'param-slider';
    slider.min = '0';
    slider.max = String(wMax);
    slider.value = String(wireToSlider(p, wire));

    if (p.values) {
      const dlId = `pdl-${slot}-${i}`;
      const dl = document.createElement('datalist');
      dl.id = dlId;
      p.values.forEach((_, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        dl.appendChild(opt);
      });
      slider.setAttribute('list', dlId);
      row.appendChild(dl);
    }

    const valEl = document.createElement('div');
    valEl.className = 'param-value';
    valEl.textContent = wireToDisplayStr(wire, p);

    slider.addEventListener('input', () => {
      const wireVal = sliderToWire(p, parseInt(slider.value));
      valEl.textContent = wireToDisplayStr(wireVal, p);
      _scheduleParamSend(slot, catId, i, wireVal);
    });

    row.appendChild(nameEl);
    row.appendChild(slider);
    row.appendChild(valEl);
    container.appendChild(row);
  });
}

function _scheduleParamSend(slot: number, catId: number, paramIdx: number, wireVal: number): void {
  if (_paramDebounceTimer !== null) clearTimeout(_paramDebounceTimer);
  _paramDebounceTimer = setTimeout(async () => {
    _paramDebounceTimer = null;
    if (!transport.isConnected) return;
    const st = transport.state.fxState.get(slot);
    if (!st) return;
    // Build full params array: [enabled, effIdx, ...sliders]
    const sliders = [...st.params];
    while (sliders.length <= paramIdx) sliders.push(0);
    sliders[paramIdx] = wireVal;
    transport.state.fxState.set(slot, { ...st, params: sliders });
    const fullParams = [st.enabled, st.effIdx, ...sliders];
    const pkt = cmdSetFxParams(slot, catId, fullParams);
    setStatus(`SetFxParams S${slot}`, null);
    await transport.write(pkt);
  }, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Add Effect dialog
// ---------------------------------------------------------------------------

let _addSelectedCat = 1;
let _addSelectedEff = 0;

function openAddEffectDialog(): void {
  const dialog = qs<HTMLDialogElement>('#dialog-add');
  _addSelectedCat = 1;
  _addSelectedEff = 0;
  _renderAddCatList();
  _renderAddEffList();
  dialog.showModal();
}

function _renderAddCatList(): void {
  const ul = qs<HTMLUListElement>('#add-cat-list');
  ul.innerHTML = '';
  const budget = transport.state.fxBudget;

  for (const id of CAT_IDS) {
    const li = document.createElement('li');
    const b = budget[id - 1] ?? 3;
    const budgSpan = document.createElement('span');
    budgSpan.className = b === 0 ? 'cat-budget-no' : b === 1 ? 'cat-budget-one' : 'cat-budget-ok';
    budgSpan.textContent = b === 0 ? '✗' : b === 1 ? '!' : '✓';
    li.textContent = getCatName(id);
    li.appendChild(budgSpan);
    li.dataset.cat = String(id);
    if (id === _addSelectedCat) li.classList.add('active');
    li.addEventListener('click', () => {
      _addSelectedCat = id;
      _addSelectedEff = 0;
      ul.querySelectorAll('li').forEach(l => l.classList.remove('active'));
      li.classList.add('active');
      _renderAddEffList();
      // Load MNRS slot names on demand when the category is first selected.
      if (id === 2 && _mnrsSlotCache.gnr.length === 0 && transport.isConnected) {
        _loadMnrsSlotCache('gnr').then(() => { if (_addSelectedCat === 2) _renderAddEffList(); });
      } else if (id === 3 && _mnrsSlotCache.gir.length === 0 && transport.isConnected) {
        _loadMnrsSlotCache('gir').then(() => { if (_addSelectedCat === 3) _renderAddEffList(); });
      }
    });
    ul.appendChild(li);
  }
}

function _renderAddEffList(): void {
  const ul = qs<HTMLUListElement>('#add-eff-list');
  ul.innerHTML = '';
  const cat = FX_CAT[_addSelectedCat];
  if (!cat) return;

  cat.effects.forEach(([name], idx) => {
    const li = document.createElement('li');
    li.textContent = name;
    li.dataset.eff = String(idx);
    if (idx === _addSelectedEff) li.classList.add('active');
    li.addEventListener('click', () => {
      _addSelectedEff = idx;
      ul.querySelectorAll('li').forEach(l => l.classList.remove('active'));
      li.classList.add('active');
    });
    ul.appendChild(li);
  });

  // MNRS entries for Amp (cat=2) and Cab (cat=3)
  if (_addSelectedCat === 2 || _addSelectedCat === 3) {
    const sep = document.createElement('li');
    sep.style.cssText = 'color:var(--text-dim);font-size:10px;padding:2px 8px;pointer-events:none';
    sep.textContent = '── MNRS ──';
    ul.appendChild(sep);
    const cacheKey = _addSelectedCat === 2 ? 'gnr' : 'gir';
    const cachedSlots = _mnrsSlotCache[cacheKey];
    for (let s = 1; s <= 10; s++) {
      const li = document.createElement('li');
      const effIdx = mnrsSlotToEff(s);
      const cached = cachedSlots.find(c => c.slot === s);
      const label = cached
        ? (cached.occupied ? (cached.name || '(unnamed)') : 'Empty')
        : (cachedSlots.length === 0 ? '...' : 'Empty');
      const selectable = cached?.occupied === true;
      li.textContent = `Slot ${s}: ${label}`;
      li.dataset.eff = String(effIdx);
      if (!selectable) {
        li.style.cssText = 'color:var(--text-dim);opacity:0.5;pointer-events:none';
      } else {
        if (effIdx === _addSelectedEff) li.classList.add('active');
        li.addEventListener('click', () => {
          _addSelectedEff = effIdx;
          ul.querySelectorAll('li').forEach(l => l.classList.remove('active'));
          li.classList.add('active');
        });
      }
      ul.appendChild(li);
    }
  }
}

qs<HTMLButtonElement>('#btn-add-cancel').addEventListener('click', () => {
  qs<HTMLDialogElement>('#dialog-add').close();
});

qs<HTMLButtonElement>('#btn-add-ok').addEventListener('click', async () => {
  if (!transport.isConnected) return;

  if ((_addSelectedCat === 2 || _addSelectedCat === 3) && _addSelectedEff >= 100) {
    const cacheKey = _addSelectedCat === 2 ? 'gnr' : 'gir';
    const slotNum = mnrsEffToSlot(_addSelectedEff) ?? 0;
    const cached = _mnrsSlotCache[cacheKey].find(s => s.slot === slotNum);
    if (!cached?.occupied) {
      showToast('Select an occupied MNRS slot', 'error');
      return;
    }
  }

  qs<HTMLDialogElement>('#dialog-add').close();
  const chain = transport.state.fxChain;
  const nextSlot = chain.length > 0 ? (chain[chain.length - 1].slot + 1) : 1;
  const actionId = transport.nextActionId(0);
  const pkt = cmdFxAdd(nextSlot, _addSelectedCat, _addSelectedEff, actionId);
  setStatus(`AddFx S${nextSlot}`, null);
  await transport.write(pkt);
  await new Promise(r => setTimeout(r, 400));
  await transport.write(cmdReadPreset(_loadedPreset));
});

// ---------------------------------------------------------------------------
// Save preset dialog
// ---------------------------------------------------------------------------

qs<HTMLButtonElement>('#btn-ble-flag').addEventListener('click', () => {
  const url = 'chrome://flags/#enable-web-bluetooth';
  const done = () => setStatus(`Copied — paste in Chrome address bar: ${url}`, null);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(done).catch(fallback);
  } else {
    fallback();
  }
  function fallback() {
    const inp = document.createElement('input');
    inp.value = url;
    inp.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(inp);
    inp.focus(); inp.select();
    document.execCommand('copy');
    document.body.removeChild(inp);
    done();
  }
});

qs<HTMLButtonElement>('#btn-save').addEventListener('click', () => {
  if (!transport.isConnected) return;
  const slotInput = qs<HTMLInputElement>('#save-slot');
  const nameInput = qs<HTMLInputElement>('#save-name');
  slotInput.value = String(_loadedPreset);
  nameInput.value = transport.state.presetNames[_loadedPreset] ?? '';
  qs<HTMLElement>('#save-slot-label').textContent = presetLabel(_loadedPreset);
  qs<HTMLDialogElement>('#dialog-save').showModal();
});

qs<HTMLInputElement>('#save-slot').addEventListener('input', () => {
  const n = parseInt(qs<HTMLInputElement>('#save-slot').value);
  qs<HTMLElement>('#save-slot-label').textContent = presetLabel(n);
  const name = transport.state.presetNames[n];
  if (name) qs<HTMLInputElement>('#save-name').value = name;
});

qs<HTMLButtonElement>('#btn-save-cancel').addEventListener('click', () => {
  qs<HTMLDialogElement>('#dialog-save').close();
});

qs<HTMLButtonElement>('#btn-save-ok').addEventListener('click', async () => {
  qs<HTMLDialogElement>('#dialog-save').close();
  if (!transport.isConnected) return;
  const slot = parseInt(qs<HTMLInputElement>('#save-slot').value);
  const name = qs<HTMLInputElement>('#save-name').value.trim();

  setStatus(`SavePreset ${slot}`, null);
  await transport.write(cmdSavePresetName(slot, name));
  if (transport.state.globalParamsD) {
    const d = new Uint8Array(transport.state.globalParamsD);
    d[0] = slot;
    await transport.write(cmdSetGlobalParams(d));
  }
  transport.state.presetNames[slot] = name;
  renderPresetList();
  showToast(`Saved to slot ${presetLabel(slot)}`, 'ok');
});

// ---------------------------------------------------------------------------
// MNRS dialog
// ---------------------------------------------------------------------------

type MnrsCategory = { protoType: number; label: string; bodyId: string };
const _MNRS_CATS: MnrsCategory[] = [
  { protoType: 2, label: 'GNR', bodyId: 'mnrs-gnr-body' },
  { protoType: 1, label: 'GIR', bodyId: 'mnrs-gir-body' },
];

let _pendingMnrsUpload: { cat: 'gnr' | 'gir'; slot: number; name: string; bytes: Uint8Array } | null = null;

qs<HTMLButtonElement>('#btn-mnrs').addEventListener('click', async () => {
  if (!transport.isConnected) { showToast('Not connected', 'error'); return; }
  qs<HTMLDialogElement>('#dialog-settings').close();
  qs<HTMLDialogElement>('#dialog-mnrs').showModal();
  await _refreshMnrsSlots();
});

qs<HTMLButtonElement>('#btn-mnrs-refresh').addEventListener('click', _refreshMnrsSlots);
qs<HTMLButtonElement>('#btn-mnrs-close').addEventListener('click', () => {
  qs<HTMLDialogElement>('#dialog-mnrs').close();
});

async function _refreshMnrsSlots(): Promise<void> {
  qs<HTMLElement>('#mnrs-status').textContent = 'Loading...';
  const gnr = await transport.getMnrsSlots('gnr');
  const gir = await transport.getMnrsSlots('gir');
  _renderMnrsTable('mnrs-gnr-body', gnr, 'gnr');
  _renderMnrsTable('mnrs-gir-body', gir, 'gir');
  qs<HTMLElement>('#mnrs-status').textContent = '';
}

function _renderMnrsTable(tbodyId: string, slots: { slot: number; occupied: boolean; name: string }[], cat: 'gnr' | 'gir'): void {
  const tbody = qs<HTMLTableSectionElement>(`#${tbodyId}`);
  tbody.innerHTML = '';
  for (const s of slots) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="slot-cell">${s.slot}</td>
      <td class="name-cell">${s.occupied ? s.name || '(unnamed)' : '—'}</td>
      <td></td>
    `;
    const actionTd = tr.cells[2];
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'btn';
    uploadBtn.style.padding = '2px 8px';
    uploadBtn.style.fontSize = '11px';
    uploadBtn.textContent = 'Upload';
    uploadBtn.addEventListener('click', () => _startMnrsUpload(cat, s.slot));
    actionTd.appendChild(uploadBtn);
    tbody.appendChild(tr);
  }
}

function _startMnrsUpload(cat: 'gnr' | 'gir', slot: number): void {
  const input = qs<HTMLInputElement>('#mnrs-file-input');
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      validateMnrsFile(bytes);
    } catch (e: any) {
      showToast(String(e.message ?? e), 'error', 5000);
      return;
    }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 50);
    _pendingMnrsUpload = { cat, slot, name, bytes };
    _doMnrsUpload();
  };
  input.value = '';
  input.click();
}

async function _doMnrsUpload(): Promise<void> {
  if (!_pendingMnrsUpload) return;
  const { slot, name, bytes } = _pendingMnrsUpload;
  const statusEl = qs<HTMLElement>('#mnrs-status');
  const bar = qs<HTMLElement>('#mnrs-progress-bar');
  statusEl.textContent = 'Uploading...';
  bar.style.width = '0%';
  try {
    await transport.uploadMnrs(bytes, slot, name, (sent, total) => {
      bar.style.width = `${Math.round(100 * sent / total)}%`;
      statusEl.textContent = `Uploading chunk ${sent}/${total}...`;
    });
    bar.style.width = '100%';
    statusEl.textContent = 'Upload complete!';
    showToast('Upload complete', 'ok');
    await _refreshMnrsSlots();
  } catch (e: any) {
    statusEl.textContent = `Error: ${e.message ?? e}`;
    showToast(`Upload failed: ${e.message ?? e}`, 'error', 5000);
  }
  _pendingMnrsUpload = null;
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

// Populate sleep select
const sleepSel = qs<HTMLSelectElement>('#set-sleep');
for (const v of [0xFF, 1, 5, 10, 20, 30, 60]) {
  const opt = document.createElement('option');
  opt.value = String(v);
  opt.textContent = v === 0xFF ? 'Never' : `${v} min`;
  sleepSel.appendChild(opt);
}

// Populate lighting mode select
const lightingSel = qs<HTMLSelectElement>('#set-lighting-mode');
for (const [val, name] of Object.entries(LIGHTING_MODE_NAMES)) {
  const opt = document.createElement('option');
  opt.value = val;
  opt.textContent = name;
  lightingSel.appendChild(opt);
}

// Build color swatches
const swatchContainer = qs<HTMLDivElement>('#color-swatches');
LIGHTING_COLORS.forEach(([wireVal, hex], i) => {
  const sw = document.createElement('div');
  sw.className = 'color-swatch';
  sw.style.background = hex;
  sw.title = LIGHTING_COLOR_NAMES[i];
  sw.dataset.wire = String(wireVal);
  sw.addEventListener('click', () => {
    swatchContainer.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    _sendSettings();
  });
  swatchContainer.appendChild(sw);
});

qs<HTMLButtonElement>('#btn-settings').addEventListener('click', () => {
  if (transport.state.globalParamsD) _syncSettingsFromGlobal(transport.state.globalParamsD);
  qs<HTMLDialogElement>('#dialog-settings').showModal();
});

qs<HTMLButtonElement>('#btn-settings-close').addEventListener('click', () => {
  qs<HTMLDialogElement>('#dialog-settings').close();
});

qs<HTMLButtonElement>('#btn-factory-reset').addEventListener('click', async () => {
  if (!transport.isConnected) { showToast('Not connected', 'error'); return; }
  const answer = window.prompt('This erases ALL presets and settings.\n\nType RESET to confirm:');
  if (answer?.trim() !== 'RESET') return;
  qs<HTMLDialogElement>('#dialog-settings').close();
  await transport.write(cmdFactoryReset());
  showToast('Factory reset sent', 'ok', 3000);
});

qs<HTMLButtonElement>('#btn-rename-amp').addEventListener('click', async () => {
  if (!transport.isConnected || !transport.state.globalParamsD) {
    showToast('Not connected', 'error'); return;
  }
  const d = transport.state.globalParamsD;
  const nameBytes = d.slice(8, 28);
  let nameEnd = nameBytes.indexOf(0);
  if (nameEnd === -1) nameEnd = 20;
  const currentFull = new TextDecoder().decode(nameBytes.slice(0, nameEnd));
  const currentSuffix = currentFull.startsWith('F15i') ? currentFull.slice(4) : currentFull;
  const suffix = window.prompt(
    'Enter amp name suffix (max 16 chars).\nThe name will be saved as "F15i" + your input.\nLeave empty to use default (F15iF15i).',
    currentSuffix,
  );
  if (suffix === null) return; // cancelled
  const clamped = suffix.slice(0, 16);
  await transport.write(cmdRenameAmp(clamped, d));
  showToast('Amp renamed — reconnect to see new name', 'ok', 4000);
});

function _syncSettingsFromGlobal(d: Uint8Array): void {
  if (d.length < 91) return;

  // Device info
  qs<HTMLElement>('#set-firmware-ver').textContent = transport.state.firmwareVersion || '—';
  const nameBytes = d.slice(8, 28);
  let nameEnd = nameBytes.indexOf(0);
  if (nameEnd === -1) nameEnd = 20;
  const ampName = new TextDecoder().decode(nameBytes.slice(0, nameEnd));
  qs<HTMLElement>('#set-amp-name-display').textContent = ampName || '—';

  _setSlider('#set-gain', d[GD_GAIN], '#set-gain-val', String(d[GD_GAIN]));
  _setSlider('#set-eq0', d[GD_EQ_BAND[0]], '#set-eq0-val', `${eqWireToDb(d[GD_EQ_BAND[0]])}dB`);
  _setSlider('#set-eq1', d[GD_EQ_BAND[1]], '#set-eq1-val', `${eqWireToDb(d[GD_EQ_BAND[1]])}dB`);
  _setSlider('#set-eq2', d[GD_EQ_BAND[2]], '#set-eq2-val', `${eqWireToDb(d[GD_EQ_BAND[2]])}dB`);
  _setSlider('#set-eq3', d[GD_EQ_BAND[3]], '#set-eq3-val', `${eqWireToDb(d[GD_EQ_BAND[3]])}dB`);
  qs<HTMLInputElement>('#set-bypass').checked = d[GD_BYPASS] !== 0;
  qs<HTMLInputElement>('#set-eq-enable').checked = d[GD_EQ_ENABLE] !== 0;
  qs<HTMLSelectElement>('#set-sleep').value = String(d[GD_SLEEP]);
  _setSlider('#set-bright', d[GD_BRIGHTNESS], '#set-bright-val', String(d[GD_BRIGHTNESS]));
  qs<HTMLInputElement>('#set-vspace').checked = d[GD_VSPACE] !== 0;
  qs<HTMLInputElement>('#set-lyric').checked = d[GD_LYRIC] !== 0;
  qs<HTMLSelectElement>('#set-lighting-mode').value = String(d[GD_LIGHTING]);

  const colorByte = d[GD_LIGHT_COLOR];
  swatchContainer.querySelectorAll<HTMLElement>('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', parseInt(sw.dataset.wire ?? '0') === colorByte);
  });

  // Mixer
  const _mvol = (v: number, master: boolean) => {
    const db = volToDb(v, master);
    return `${db >= 0 ? '+' : ''}${db}dB`;
  };
  const btV = d[MIXER_CH.bt[1]];
  const btM = d[MIXER_CH.bt[0]] !== 0;
  _setSlider('#set-bt-vol', btV, '#set-bt-vol-val', _mvol(btV, false));
  qs<HTMLInputElement>('#set-bt-mute').checked = btM;

  const usbV = d[MIXER_CH.usb[1]];
  const usbM = d[MIXER_CH.usb[0]] !== 0;
  _setSlider('#set-usb-vol', usbV, '#set-usb-vol-val', _mvol(usbV, false));
  qs<HTMLInputElement>('#set-usb-mute').checked = usbM;

  const instV = d[MIXER_CH.inst[1]];
  const instM = d[MIXER_CH.inst[0]] !== 0;
  _setSlider('#set-inst-vol', instV, '#set-inst-vol-val', _mvol(instV, false));
  qs<HTMLInputElement>('#set-inst-mute').checked = instM;

  const masterV = d[MIXER_CH.master[1]];
  const masterM = d[MIXER_CH.master[0]] !== 0;
  _setSlider('#set-master-vol', masterV, '#set-master-vol-val', _mvol(masterV, true));
  qs<HTMLInputElement>('#set-master-mute').checked = masterM;
}

function _setSlider(sliderSel: string, val: number, labelSel: string, label: string): void {
  qs<HTMLInputElement>(sliderSel).value = String(val);
  qs<HTMLElement>(labelSel).textContent = label;
}

// Wire up all settings controls with debounced live-send
const _settingsInputs = [
  '#set-gain', '#set-eq0', '#set-eq1', '#set-eq2', '#set-eq3',
  '#set-bright', '#set-bt-vol', '#set-usb-vol', '#set-inst-vol', '#set-master-vol',
];
const _settingsChecks = ['#set-bypass', '#set-eq-enable', '#set-vspace', '#set-lyric', '#set-bt-mute', '#set-usb-mute', '#set-inst-mute', '#set-master-mute'];
const _settingsSelects = ['#set-sleep', '#set-lighting-mode'];

let _settingsDebounce: ReturnType<typeof setTimeout> | null = null;

function _scheduleSettingsSend(): void {
  if (_settingsDebounce) clearTimeout(_settingsDebounce);
  _settingsDebounce = setTimeout(_sendSettings, DEBOUNCE_MS);
}

// Update display values on slider move
qs<HTMLInputElement>('#set-gain').addEventListener('input', () => {
  qs<HTMLElement>('#set-gain-val').textContent = qs<HTMLInputElement>('#set-gain').value;
  _scheduleSettingsSend();
});
['eq0','eq1','eq2','eq3'].forEach((k, i) => {
  qs<HTMLInputElement>(`#set-${k}`).addEventListener('input', () => {
    const v = parseInt(qs<HTMLInputElement>(`#set-${k}`).value);
    qs<HTMLElement>(`#set-${k}-val`).textContent = `${eqWireToDb(v)}dB`;
    _scheduleSettingsSend();
  });
});
['bt-vol','usb-vol','inst-vol'].forEach(k => {
  qs<HTMLInputElement>(`#set-${k}`).addEventListener('input', () => {
    const v = parseInt(qs<HTMLInputElement>(`#set-${k}`).value);
    qs<HTMLElement>(`#set-${k}-val`).textContent = `${volToDb(v) >= 0 ? '+' : ''}${volToDb(v)}dB`;
    _scheduleSettingsSend();
  });
});
qs<HTMLInputElement>('#set-master-vol').addEventListener('input', () => {
  const v = parseInt(qs<HTMLInputElement>('#set-master-vol').value);
  qs<HTMLElement>('#set-master-vol-val').textContent = `${volToDb(v, true) >= 0 ? '+' : ''}${volToDb(v, true)}dB`;
  _scheduleSettingsSend();
});
qs<HTMLInputElement>('#set-bright').addEventListener('input', () => {
  qs<HTMLElement>('#set-bright-val').textContent = qs<HTMLInputElement>('#set-bright').value;
  _scheduleSettingsSend();
});
_settingsChecks.forEach(sel => qs<HTMLInputElement>(sel).addEventListener('change', _scheduleSettingsSend));
_settingsSelects.forEach(sel => qs<HTMLSelectElement>(sel).addEventListener('change', _scheduleSettingsSend));

async function _sendSettings(): Promise<void> {
  if (!transport.isConnected || !transport.state.globalParamsD) return;
  const d = new Uint8Array(transport.state.globalParamsD);
  d[0] = _loadedPreset;

  d[GD_GAIN]     = parseInt(qs<HTMLInputElement>('#set-gain').value);
  d[GD_BYPASS]   = qs<HTMLInputElement>('#set-bypass').checked ? 1 : 0;
  d[GD_SLEEP]    = parseInt(qs<HTMLSelectElement>('#set-sleep').value);
  d[GD_EQ_ENABLE]= qs<HTMLInputElement>('#set-eq-enable').checked ? 1 : 0;
  d[GD_EQ_BAND[0]] = parseInt(qs<HTMLInputElement>('#set-eq0').value);
  d[GD_EQ_BAND[1]] = parseInt(qs<HTMLInputElement>('#set-eq1').value);
  d[GD_EQ_BAND[2]] = parseInt(qs<HTMLInputElement>('#set-eq2').value);
  d[GD_EQ_BAND[3]] = parseInt(qs<HTMLInputElement>('#set-eq3').value);
  d[GD_BRIGHTNESS] = parseInt(qs<HTMLInputElement>('#set-bright').value);
  d[GD_VSPACE]   = qs<HTMLInputElement>('#set-vspace').checked ? 1 : 0;
  d[GD_LYRIC]    = qs<HTMLInputElement>('#set-lyric').checked ? 1 : 0;
  d[GD_LIGHTING] = parseInt(qs<HTMLSelectElement>('#set-lighting-mode').value);

  const activeSwatch = swatchContainer.querySelector<HTMLElement>('.color-swatch.active');
  if (activeSwatch) d[GD_LIGHT_COLOR] = parseInt(activeSwatch.dataset.wire ?? '0');

  // Mixer
  d[MIXER_CH.bt[0]]  = qs<HTMLInputElement>('#set-bt-mute').checked ? 1 : 0;
  d[MIXER_CH.bt[1]]  = parseInt(qs<HTMLInputElement>('#set-bt-vol').value);
  d[MIXER_CH.usb[0]] = qs<HTMLInputElement>('#set-usb-mute').checked ? 1 : 0;
  d[MIXER_CH.usb[1]] = parseInt(qs<HTMLInputElement>('#set-usb-vol').value);
  d[MIXER_CH.inst[0]]= qs<HTMLInputElement>('#set-inst-mute').checked ? 1 : 0;
  d[MIXER_CH.inst[1]]= parseInt(qs<HTMLInputElement>('#set-inst-vol').value);
  d[MIXER_CH.master[0]] = qs<HTMLInputElement>('#set-master-mute').checked ? 1 : 0;
  d[MIXER_CH.master[1]] = parseInt(qs<HTMLInputElement>('#set-master-vol').value);

  setStatus('SetGlobalParams', null);
  await transport.write(cmdSetGlobalParams(d));
}

// ---------------------------------------------------------------------------
// Tools panel
// ---------------------------------------------------------------------------

document.querySelectorAll('.tools-tab').forEach(btn => {
  btn.addEventListener('click', async () => {
    const tab = (btn as HTMLElement).dataset.tab ?? '';
    document.querySelectorAll('.tools-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#tools-content > div').forEach(d => d.classList.add('hidden'));
    qs<HTMLElement>(`#tab-${tab}`).classList.remove('hidden');

    if (!transport.isConnected) return;
    if (tab === 'tuner') {
      _activeTool = TOOL_TUNER;
      await transport.write(cmdSelectTool(TOOL_TUNER));
    } else if (tab === 'drum') {
      _activeTool = TOOL_DRUM;
      _syncDrumFromGlobal();
      await transport.write(cmdSelectTool(TOOL_DRUM));
      await new Promise(r => setTimeout(r, 200));
      await transport.write(cmdGetDrumBpm());
    } else if (tab === 'looper') {
      _activeTool = TOOL_LOOPER;
      await transport.write(cmdSelectTool(TOOL_LOOPER));
    }
  });
});

// ── Tuner ──────────────────────────────────────────────────────────────────
// Tuner activates automatically when the tab is opened (cmdSelectTool(TOOL_TUNER)).

qs<HTMLButtonElement>('#btn-tuner-mute').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdDrumMute());
});

function _onTuner(raw: number, dev: number): void {
  const note = _NOTE_NAMES[((raw - 2) % 12 + 12) % 12];
  const cents = Math.round((dev - 16) * 3.1);
  qs<HTMLElement>('#tuner-note').textContent = note;
  qs<HTMLElement>('#tuner-cents').textContent = cents === 0 ? 'In tune' : `${cents > 0 ? '+' : ''}${cents}¢`;
  _drawTunerMeter(cents);
}

const CENTS_GOOD = 5;   // ±5¢  → green
const CENTS_OK   = 15;  // ±15¢ → yellow (beyond = red)

function _drawTunerMeter(cents: number): void {
  const canvas = qs<HTMLCanvasElement>('#tuner-meter');
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const half = cx - 6;
  const xAt = (c: number) => cx + (c / 50) * half;

  // Track bar
  const trackY = Math.floor(h / 2) - 4;
  const trackH = 8;
  ctx.fillStyle = '#404040';
  ctx.fillRect(6, trackY, w - 12, trackH);

  // Green in-tune zone
  const gx = xAt(-CENTS_GOOD);
  ctx.fillStyle = '#1a4a1a';
  ctx.fillRect(gx, trackY, xAt(CENTS_GOOD) - gx + 1, trackH);

  // Tick marks
  function tick(c: number, color: string, extra: number) {
    const x = Math.round(xAt(c));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, trackY - extra);
    ctx.lineTo(x, trackY + trackH + extra);
    ctx.stroke();
  }
  tick(-50, '#555', 2); tick(50, '#555', 2);
  tick(-25, '#555', 2); tick(25, '#555', 2);
  tick(-CENTS_GOOD, '#44aa44', 5); tick(CENTS_GOOD, '#44aa44', 5);
  tick(0, '#cccccc', 8);  // centre — tallest, white

  // Needle
  const c = Math.max(-50, Math.min(50, cents));
  const nc = Math.abs(c) <= CENTS_GOOD ? '#44aa44'
           : Math.abs(c) <= CENTS_OK   ? '#ccaa22'
                                        : '#cc3333';
  const nx = Math.round(xAt(c));
  ctx.fillStyle = nc;
  ctx.fillRect(nx - 1, trackY - 10, 3, trackH + 20);
}

// ── Drum ───────────────────────────────────────────────────────────────────

async function _sendDrumGlobalParam(patch: {
  bpm?: number; vol?: number; track?: number; looperVol?: number; drumSync?: boolean;
}): Promise<void> {
  if (!transport.isConnected || !transport.state.globalParamsD) return;
  const d = new Uint8Array(transport.state.globalParamsD);
  d[0] = _loadedPreset;
  if (patch.bpm !== undefined) {
    const b = Math.max(40, Math.min(260, patch.bpm));
    d[40] = b & 0xFF; d[41] = (b >> 8) & 0xFF;
  }
  if (patch.vol     !== undefined) d[39] = Math.max(0, Math.min(100, patch.vol));
  if (patch.track   !== undefined) d[42] = patch.track & 0xFF;
  if (patch.looperVol !== undefined) d[46] = Math.max(0, Math.min(100, patch.looperVol));
  if (patch.drumSync  !== undefined) d[GD_DRUM_SYNC] = patch.drumSync ? 1 : 0;
  transport.state.globalParamsD = d;
  await transport.write(cmdSetGlobalParams(d));
}

// Populate drum track list
const drumList = qs<HTMLUListElement>('#drum-track-list');
DRUM_TRACKS.forEach((name, idx) => {
  const li = document.createElement('li');
  li.textContent = name;
  li.dataset.idx = String(idx);
  li.addEventListener('click', async () => {
    drumList.querySelectorAll('li').forEach(l => l.classList.remove('active'));
    li.classList.add('active');
    _drumState.trackIdx = idx;
    await _sendDrumGlobalParam({ track: idx });
  });
  drumList.appendChild(li);
});

let _drumBpmTimer: ReturnType<typeof setTimeout> | null = null;
qs<HTMLInputElement>('#drum-bpm').addEventListener('input', () => {
  const v = parseInt(qs<HTMLInputElement>('#drum-bpm').value);
  qs<HTMLElement>('#drum-bpm-val').textContent = String(v);
  _drumState.bpm = v;
  if (_drumBpmTimer) clearTimeout(_drumBpmTimer);
  _drumBpmTimer = setTimeout(() => _sendDrumGlobalParam({ bpm: v }), DEBOUNCE_MS);
});

qs<HTMLInputElement>('#drum-vol').addEventListener('input', () => {
  const v = parseInt(qs<HTMLInputElement>('#drum-vol').value);
  qs<HTMLElement>('#drum-vol-val').textContent = String(v);
  _drumState.vol = v;
  _sendDrumGlobalParam({ vol: v });
});

qs<HTMLInputElement>('#looper-vol').addEventListener('input', () => {
  const v = parseInt(qs<HTMLInputElement>('#looper-vol').value);
  qs<HTMLElement>('#looper-vol-val').textContent = String(v);
  _drumState.looperVol = v;
  _sendDrumGlobalParam({ looperVol: v });
});

qs<HTMLInputElement>('#drum-sync').addEventListener('change', () => {
  _sendDrumGlobalParam({ drumSync: qs<HTMLInputElement>('#drum-sync').checked });
});

qs<HTMLButtonElement>('#btn-drum-play').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  _drumState.playing = true;
  qs<HTMLButtonElement>('#btn-drum-play').classList.add('playing');
  await transport.write(cmdDrumPlayStop(true));
});

qs<HTMLButtonElement>('#btn-drum-stop').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  _drumState.playing = false;
  qs<HTMLButtonElement>('#btn-drum-play').classList.remove('playing');
  await transport.write(cmdDrumPlayStop(false));
});

function _applyDrumFields(d: Uint8Array): void {
  if (d.length < 47) return;
  const vol      = d[39];
  const bpm      = d[40] | (d[41] << 8);
  const trackIdx = d[42];
  const lVol     = d[46];
  _drumState.vol = vol; _drumState.bpm = bpm;
  _drumState.trackIdx = trackIdx; _drumState.looperVol = lVol;

  qs<HTMLInputElement>('#drum-bpm').value = String(bpm);
  qs<HTMLElement>('#drum-bpm-val').textContent = String(bpm);
  qs<HTMLInputElement>('#drum-vol').value = String(vol);
  qs<HTMLElement>('#drum-vol-val').textContent = String(vol);
  qs<HTMLInputElement>('#looper-vol').value = String(lVol);
  qs<HTMLElement>('#looper-vol-val').textContent = String(lVol);

  drumList.querySelectorAll<HTMLLIElement>('li').forEach(li => {
    li.classList.toggle('active', parseInt(li.dataset.idx ?? '-1') === trackIdx);
  });

  if (d.length > GD_DRUM_SYNC) {
    qs<HTMLInputElement>('#drum-sync').checked = d[GD_DRUM_SYNC] !== 0;
  }
}

function _syncDrumFromGlobal(): void {
  if (transport.state.globalParamsD) _applyDrumFields(transport.state.globalParamsD);
}

// ── Looper ─────────────────────────────────────────────────────────────────

qs<HTMLButtonElement>('#btn-looper-rec').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdLooperAction(LOOPER_RECORD));
});

qs<HTMLButtonElement>('#btn-looper-play').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdLooperAction(LOOPER_PLAY));
});

qs<HTMLButtonElement>('#btn-looper-stop').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdLooperAction(LOOPER_STOP));
});

qs<HTMLButtonElement>('#btn-looper-undo').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdLooperAction(LOOPER_UNDO));
});

qs<HTMLButtonElement>('#btn-looper-delete').addEventListener('click', async () => {
  if (!transport.isConnected) return;
  await transport.write(cmdLooperAction(LOOPER_DELETE));
});

transport.on((e: TransportEvent) => {
  if (e.type !== 'looper_state') return;
  const d = e.d;
  const stateNames: Record<number, string> = { 0:'Idle', 1:'Recording', 2:'Playing', 3:'Overdub', 4:'Stopped', 5:'Undoing', 7:'Deleting' };
  qs<HTMLElement>('#looper-status').textContent = stateNames[d[0]] ?? 'Unknown';
});

// ---------------------------------------------------------------------------
// Panel collapse toggles
// ---------------------------------------------------------------------------

const _sidebarEl    = qs<HTMLElement>('#sidebar');
const _toolsPanelEl = qs<HTMLElement>('#tools-panel');
const _btnTogglePresets = qs<HTMLButtonElement>('#btn-toggle-presets');
const _btnToggleTools   = qs<HTMLButtonElement>('#btn-toggle-tools');

function _setPanel(panelEl: HTMLElement, btnEl: HTMLButtonElement, open: boolean): void {
  panelEl.classList.toggle('collapsed', !open);
  btnEl.classList.toggle('active', open);
}

let _presetsOpen = window.innerWidth > 680;
let _toolsOpen   = window.innerWidth > 680;
_setPanel(_sidebarEl,    _btnTogglePresets, _presetsOpen);
_setPanel(_toolsPanelEl, _btnToggleTools,   _toolsOpen);

_btnTogglePresets.addEventListener('click', () => {
  _presetsOpen = !_presetsOpen;
  _setPanel(_sidebarEl, _btnTogglePresets, _presetsOpen);
});

_btnToggleTools.addEventListener('click', () => {
  _toolsOpen = !_toolsOpen;
  _setPanel(_toolsPanelEl, _btnToggleTools, _toolsOpen);
});

qs<HTMLButtonElement>('#btn-sidebar-close').addEventListener('click', () => {
  _presetsOpen = false;
  _setPanel(_sidebarEl, _btnTogglePresets, false);
});

qs<HTMLButtonElement>('#btn-tools-close').addEventListener('click', () => {
  _toolsOpen = false;
  _setPanel(_toolsPanelEl, _btnToggleTools, false);
});

// ---------------------------------------------------------------------------
// Initial draw
// ---------------------------------------------------------------------------

renderPresetList();
_drawTunerMeter(0);

// Make sure add button is hidden until connected
qs<HTMLButtonElement>('#btn-add-fx').classList.add('hidden');
