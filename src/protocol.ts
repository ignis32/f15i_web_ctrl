/**
 * Mooer F15i BLE protocol implementation.
 */

// ---------------------------------------------------------------------------
// BLE UUIDs
// ---------------------------------------------------------------------------

export const SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
export const WRITE_UUID   = "0000fff3-0000-1000-8000-00805f9b34fb";
export const NOTIFY_UUID  = "0000fff2-0000-1000-8000-00805f9b34fb";

// ---------------------------------------------------------------------------
// CRC-16/XMODEM
// ---------------------------------------------------------------------------

const _CRC_TABLE: number[] = (() => {
  const tbl: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
    tbl.push(crc & 0xFFFF);
  }
  return tbl;
})();

export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc = ((crc << 8) ^ _CRC_TABLE[((crc >> 8) ^ b) & 0xFF]) & 0xFFFF;
  }
  return crc;
}

// ---------------------------------------------------------------------------
// Packet framing
// ---------------------------------------------------------------------------

export function makePacket(payload: number[] | Uint8Array): Uint8Array {
  const p = Array.from(payload);
  const n = p.length;
  const len_lo = n & 0xFF;
  const len_hi = (n >> 8) & 0xFF;
  const crcInput = new Uint8Array([len_lo, len_hi, ...p]);
  const crc = crc16(crcInput) ^ 0xFFFF;
  return new Uint8Array([0xAA, 0x55, len_lo, len_hi, ...p, (crc >> 8) & 0xFF, crc & 0xFF]);
}

// ---------------------------------------------------------------------------
// Reassembler
// ---------------------------------------------------------------------------

export class Reassembler {
  private _buf: number[] = [];
  private _expected = 0;

  feed(data: Uint8Array): Uint8Array[] {
    for (const b of data) this._buf.push(b);
    const out: Uint8Array[] = [];

    while (true) {
      if (this._expected === 0) {
        if (this._buf.length < 4) break;
        if (this._buf[0] !== 0xAA || this._buf[1] !== 0x55) {
          let idx = this._buf.length;
          for (let i = 0; i < this._buf.length - 1; i++) {
            if (this._buf[i] === 0xAA && this._buf[i + 1] === 0x55) { idx = i; break; }
          }
          this._buf = this._buf.slice(idx);
          if (this._buf.length < 4) break;
        }
        const plen = this._buf[2] | (this._buf[3] << 8);
        this._expected = 4 + plen + 2;
      }

      if (this._buf.length >= this._expected) {
        out.push(new Uint8Array(this._buf.slice(0, this._expected)));
        this._buf = this._buf.slice(this._expected);
        this._expected = 0;
      } else {
        break;
      }
    }
    return out;
  }

  reset(): void { this._buf = []; this._expected = 0; }
}

// ---------------------------------------------------------------------------
// MNRS constants and helpers
// ---------------------------------------------------------------------------

export const MNRS_SLOT_OFFSET   = 99;
export const MNRS_EFF_IDX_MIN   = 100;
export const MNRS_EFF_IDX_MAX   = 109;
export const MNRS_EFF_IDX_SAVED = 200;

export function isMnrsEff(catId: number, effIdx: number): boolean {
  return (catId === 2 || catId === 3) &&
    ((effIdx >= MNRS_EFF_IDX_MIN && effIdx <= MNRS_EFF_IDX_MAX) || effIdx === MNRS_EFF_IDX_SAVED);
}

export function mnrsSlotToEff(slot: number): number {
  return MNRS_SLOT_OFFSET + slot;
}

export function mnrsEffToSlot(effIdx: number): number | null {
  if (effIdx >= MNRS_EFF_IDX_MIN && effIdx <= MNRS_EFF_IDX_MAX) return effIdx - MNRS_SLOT_OFFSET;
  return null;
}

// ---------------------------------------------------------------------------
// Structured parsers
// ---------------------------------------------------------------------------

export interface FxParamsParsed {
  slot: number;
  catId: number;
  params: number[]; // [enabled, effIdx, slider0, ...]
}

export function parseFxParamsPayload(d: Uint8Array): FxParamsParsed | null {
  if (d.length < 3) return null;
  const slot = d[0], catId = d[1], bcount = d[2];
  const raw = d.slice(3, 3 + bcount);
  const params: number[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    params.push(raw[i] | (raw[i + 1] << 8));
  }
  return { slot, catId, params };
}

export interface EffectEntry {
  slot: number;
  catId: number;
  effIdx: number;
  enabled: number;
  params: number[]; // sliders only (params[2:] in the full array)
}

export interface PresetParsed {
  presetId: number;
  name: string;
  effects: EffectEntry[];
  mnrsNames: Record<number, string>; // type (1=GNR, 2=GIR) → name
}

function decodeAscii(bytes: Uint8Array): string {
  const nullIdx = bytes.indexOf(0);
  const slice = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
  try { return new TextDecoder('latin1').decode(slice).replace(/[^\x20-\x7E]/g, '?'); }
  catch { return ''; }
}

export function parsePresetParams(d: Uint8Array): PresetParsed | null {
  if (d.length < 22) return null;
  const presetId = d[0];
  const name = decodeAscii(d.slice(1, 21)).trim();
  const effects: EffectEntry[] = [];
  let pos = 21;
  let lastSlot = 0;

  while (pos + 2 <= d.length) {
    const slot = d[pos];
    const catId = d[pos + 1];
    if (slot === 0 && catId === 0) break;
    if (slot < lastSlot) break;
    lastSlot = slot;
    const byteCount = (pos + 2 < d.length) ? d[pos + 2] : 0;
    pos += 3;
    const raw = d.slice(pos, pos + byteCount);
    pos += byteCount;
    if (catId === 0) continue;
    const vals: number[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) vals.push(raw[i] | (raw[i + 1] << 8));
    effects.push({
      slot,
      catId,
      effIdx:  vals.length > 1 ? vals[1] : 0,
      enabled: vals.length > 0 ? vals[0] : 0,
      params:  vals.length > 2 ? vals.slice(2) : [],
    });
  }

  const mnrsNames: Record<number, string> = {};
  const MNRS_STRIDE = 52;
  while (pos + MNRS_STRIDE <= d.length) {
    const hasData = d[pos];
    const entryType = d[pos + 1];
    if (hasData && (entryType === 1 || entryType === 2)) {
      const n = decodeAscii(d.slice(pos + 2, pos + MNRS_STRIDE)).trim();
      if (n) mnrsNames[entryType] = n;
    }
    pos += MNRS_STRIDE;
  }

  return { presetId, name, effects, mnrsNames };
}

export interface PresetNamesParsed {
  start: number;
  names: Record<number, string>; // preset_id (1-based) → name
}

export function parsePresetNames(d: Uint8Array): PresetNamesParsed | null {
  if (d.length < 2) return null;
  const start = d[0];
  const namesRaw = d.slice(2);
  const stride = 20;
  const count = Math.floor(namesRaw.length / stride);
  const names: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const presetId = start + i;
    const chunk = namesRaw.slice(i * stride, (i + 1) * stride);
    const name = decodeAscii(chunk).trim();
    if (name) names[presetId] = name;
  }
  return { start, names };
}

export interface MnrsSlot {
  slot: number;
  occupied: boolean;
  name: string;
}

export function parseMnrsSlotList(d: Uint8Array): MnrsSlot[] {
  const STRIDE = 59;
  const result: MnrsSlot[] = [];
  for (let i = 0; i + STRIDE <= d.length; i += STRIDE) {
    const entry = d.slice(i, i + STRIDE);
    if (entry.length < 6) continue;
    const slot = entry[1] | (entry[2] << 8);
    const occupied = entry[3] !== 0;
    let name = decodeAscii(entry.slice(5, STRIDE)).trim();
    if (name === 'Empty') name = '';
    result.push({ slot, occupied, name });
  }
  return result;
}

export interface DrumTrackEntry {
  idx: number;
  name: string;
}

export function parseDrumListResponse(d: Uint8Array): DrumTrackEntry[] {
  const STRIDE = 59;
  const result: DrumTrackEntry[] = [];
  for (let i = 0; i + STRIDE <= d.length; i += STRIDE) {
    const entry = d.slice(i, i + STRIDE);
    if (entry.length < 6 || !entry[3]) continue;
    const trackNum = entry[1] | (entry[2] << 8);
    const name = decodeAscii(entry.slice(5, STRIDE)).trim();
    if (name) result.push({ idx: trackNum, name });
  }
  return result;
}

export interface LooperState {
  state: number;
  muted: boolean;
}

export function parseLooperState(d: Uint8Array): LooperState | null {
  if (d.length < 2) return null;
  return { state: d[0], muted: d[1] !== 0 };
}

export interface LooperPosition {
  totalMs: number;
  posMs: number;
  active: boolean;
}

export function parseLooperPosition(d: Uint8Array): LooperPosition | null {
  if (d.length < 8) return null;
  const total = d[0] | (d[1] << 8);
  const pos = d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] * 0x1000000);
  const active = d.length > 8 ? d[8] !== 0 : false;
  return { totalMs: total, posMs: pos, active };
}

// ---------------------------------------------------------------------------
// Preset numbering
// ---------------------------------------------------------------------------

export function presetLabel(n: number): string {
  n = Math.max(1, Math.min(80, n));
  return `${Math.floor((n - 1) / 4)}${'_abcd'[(n - 1) % 4 + 1]}`;
}

// ---------------------------------------------------------------------------
// Volume / EQ helpers
// ---------------------------------------------------------------------------

export function volToDb(v: number, master = false): number {
  return Math.round((v * 0.5 - (master ? 30.0 : 36.0)) * 10) / 10;
}

export function dbToVol(db: number, master = false): number {
  const offset = master ? 30.0 : 36.0;
  return Math.max(0, Math.min(72, Math.round((db + offset) * 2)));
}

export function eqWireToDb(v: number): number {
  return Math.round((v - 24) * 0.5 * 10) / 10;
}

export function eqDbToWire(db: number): number {
  return Math.max(0, Math.min(48, Math.round(db * 2 + 24)));
}

export function sleepDecode(v: number): string {
  return v === 0xFF ? 'Never' : `${v} min`;
}

// ---------------------------------------------------------------------------
// Global settings byte offsets  (indices into d[] after cmd byte)
// ---------------------------------------------------------------------------

export const GD_BYPASS      = 1;
export const GD_EQ_BAND     = [2, 3, 4, 5] as const;
export const GD_GAIN        = 6;
export const GD_SLEEP       = 7;
// d[8..27] = model name
export const GD_EQ_ENABLE   = 48;
export const GD_BRIGHTNESS  = 74;
export const GD_VSPACE      = 75;
export const GD_LIGHTING    = 77;
export const GD_LIGHT_COLOR = 78;
export const GD_LYRIC       = 90;

export const EQ_FREQS = ['100Hz', '350Hz', '1800Hz', '4000Hz'] as const;

// (mute_idx, vol_idx) per channel
export const MIXER_CH = {
  bt:     [28, 29] as const,
  usb:    [30, 31] as const,
  inst:   [32, 33] as const,
  master: [34, 36] as const,
} as const;

// (wireValue, '#RRGGBB')  wireValue is a single-bit bitmask for d[GD_LIGHT_COLOR]
export const LIGHTING_COLORS: [number, string][] = [
  [0x01, '#3D6EFF'],   // Blue
  [0x80, '#AA44FF'],   // Purple
  [0x40, '#FFDD00'],   // Yellow
  [0x20, '#00CCEE'],   // Cyan
  [0x10, '#FF8800'],   // Orange
  [0x08, '#44BB44'],   // Green
  [0x04, '#EE3333'],   // Red
  [0x02, '#FF99BB'],   // Pink
  [0x00, '#FFFFFF'],   // White / None
];
export const LIGHTING_COLOR_NAMES = ['Blue','Purple','Yellow','Cyan','Orange','Green','Red','Pink','White'];
export const LIGHTING_MODE_NAMES: Record<number, string> = {
  0: 'Close', 1: 'Solid', 2: 'Slow Flash', 3: 'Signal Sync',
};

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export const PRESET_NAME_MAX_BYTES = 20;
export const TOOL_DRUM   = 1;
export const TOOL_TUNER  = 2;
export const TOOL_LOOPER = 3;
export const LOOPER_RECORD = 1;
export const LOOPER_STOP   = 2;
export const LOOPER_UNDO   = 3;  // undo last overdub layer → state 5
export const LOOPER_DELETE = 4;  // clear all loops → state 7 (deleting) → idle
export const LOOPER_PLAY   = 5;

export const GD_DRUM_SYNC = 45;  // globalParamsD offset: drum sync 0=off 1=on

export const cmdGetDeviceInfo    = () => makePacket([0x01, 0x01]);
export const cmdGetGlobalParams  = () => makePacket([0x11]);
export const cmdGetActiveInfo    = () => makePacket([0xA9]);
export const cmdGetBatteryInfo   = () => makePacket([0x91]);
export const cmdGetChainState    = () => makePacket([0x2B]);
export const cmdSetFstConnect    = () => makePacket([0x95]);
export const cmdFactoryReset     = () => makePacket([0xA1]);

export function cmdGetPresetNames(start = 1, count = 80): Uint8Array {
  return makePacket([0x29, start & 0xFF, count & 0xFF]);
}

export function cmdReadPreset(presetId: number): Uint8Array {
  return makePacket([0x21, presetId & 0xFF]);
}

export function cmdGetFxParams(slot: number): Uint8Array {
  return makePacket([0x23, slot & 0xFF]);
}

export function cmdSetFxParams(slot: number, catId: number, params: number[]): Uint8Array {
  const body: number[] = [];
  for (const v of params) {
    const clamped = Math.max(0, Math.min(0xFFFF, Math.round(v)));
    body.push(clamped & 0xFF, (clamped >> 8) & 0xFF);
  }
  return makePacket([0x25, slot & 0xFF, catId & 0xFF, body.length, ...body]);
}

export function cmdSetGlobalParams(d: Uint8Array | number[]): Uint8Array {
  return makePacket([0x13, ...d]);
}

export function cmdLoadPreset(presetId: number, globalParamsD: Uint8Array | null): Uint8Array {
  presetId = Math.max(1, Math.min(80, presetId));
  if (globalParamsD) {
    const d = new Uint8Array(globalParamsD);
    d[0] = presetId;
    return makePacket([0x13, ...d]);
  }
  // Fallback template when no cached global params are available.
  const tail = new Uint8Array([
    0x00, 0x18, 0x18, 0x18, 0x18, 0x09, 0xFF, 0x46, 0x31, 0x35, 0x69, 0x46, 0x31, 0x35, 0x69, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2F, 0x00, 0x2F, 0x00,
    0x36, 0x01, 0x01, 0x2A, 0x2A, 0x00, 0x3C, 0x3C, 0x00, 0x00, 0x0A, 0x01, 0x00, 0x3C, 0x01, 0x00,
    0xFF, 0x00, 0x3C, 0x01, 0x00, 0x46, 0x00, 0x14, 0x00, 0x01, 0x00, 0x18, 0x00, 0x18, 0x00, 0x18,
    0x00, 0x01, 0x00, 0x28, 0x00, 0x32, 0x00, 0x32, 0x00, 0x19, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01,
    0x14, 0x00, 0x64, 0x00, 0x00, 0x00, 0x01, 0x48, 0x00, 0x01,
  ]);
  return makePacket([0x13, presetId, ...tail]);
}

/** Rename the amp. suffix must be ≤16 ASCII chars; "F15i" is always prepended. */
export function cmdRenameAmp(suffix: string, globalParamsD: Uint8Array): Uint8Array {
  const fullName = 'F15i' + suffix.slice(0, 16);
  const enc = new TextEncoder().encode(fullName);
  const d = new Uint8Array(globalParamsD);
  // Zero out the 20-byte name field, then write the new name
  for (let i = 8; i < 28; i++) d[i] = 0;
  for (let i = 0; i < Math.min(enc.length, 20); i++) d[8 + i] = enc[i];
  return cmdSetGlobalParams(d);
}

export function cmdSavePresetName(slot: number, name: string): Uint8Array {
  const enc = new TextEncoder().encode(name).slice(0, PRESET_NAME_MAX_BYTES);
  const padded = new Uint8Array(PRESET_NAME_MAX_BYTES);
  padded.set(enc);
  return makePacket([0x2F, slot & 0xFF, ...padded]);
}

export function cmdFxAdd(slot: number, catId: number, effIdx: number, actionId: number): Uint8Array {
  actionId = Math.max(0x00, Math.min(0x31, actionId));
  return makePacket([0x2D, actionId, 0x01, slot & 0xFF, catId & 0xFF, effIdx & 0xFF]);
}

export function cmdFxReplace(
  slot: number, catId: number, effIdx: number, actionId: number,
  oldCat: number, oldEff: number,
): Uint8Array[] {
  actionId = Math.max(0x64, Math.min(0x95, actionId));
  return [
    makePacket([0x37, 0x01, oldCat & 0xFF, oldEff & 0xFF]),
    makePacket([0x2D, actionId, 0x02, slot & 0xFF, catId & 0xFF, effIdx & 0xFF]),
    makePacket([0x37, 0x00, 0x00, 0x00]),
  ];
}

export function cmdFxRemove(slot: number, actionId: number): Uint8Array {
  actionId = Math.max(0x32, Math.min(0x63, actionId));
  return makePacket([0x2D, actionId, 0x03, slot & 0xFF]);
}

export function cmdFxMove(fromSlot: number, toSlot: number, actionId: number): Uint8Array {
  actionId = Math.max(0x96, Math.min(0xC7, actionId));
  return makePacket([0x2D, actionId, 0x04, fromSlot & 0xFF, toSlot & 0xFF]);
}

export function cmdSelectTool(tool: number): Uint8Array {
  return makePacket([0x41, tool & 0xFF]);
}

export function cmdGetList(cat: number, start: number, end: number): Uint8Array {
  return makePacket([0x65, cat & 0xFF,
    start & 0xFF, (start >> 8) & 0xFF,
    end   & 0xFF, (end   >> 8) & 0xFF]);
}

export const cmdListGnrSlots = () => cmdGetList(2, 1, 10);  // GNR protoType=2
export const cmdListGirSlots = () => cmdGetList(1, 1, 10);  // GIR protoType=1

export const cmdGetDrumState = () => makePacket([0x17]);
// In drum-tool context (after cmdSelectTool(TOOL_DRUM)) 0x91 fetches BPM → 0x93 response.
// In default context 0x91 fetches battery → 0x92 response.
export const cmdGetDrumBpm   = () => makePacket([0x91]);
export const cmdDrumMute     = () => makePacket([0x4a, 0x01]);

export function cmdDrumPlayStop(playing: boolean): Uint8Array {
  return makePacket([0x47, playing ? 0x01 : 0x00, 0x00, 0x00]);
}

export function cmdLooperAction(action: number): Uint8Array {
  return makePacket([0x4d, action & 0xFF]);
}

export function cmdGetLooperInfo(slot = 1): Uint8Array {
  return makePacket([0x53, slot & 0xFF, (slot >> 8) & 0xFF]);
}

// ---------------------------------------------------------------------------
// MNRS file upload (cmd 0x61 / ACK 0x62)
// ---------------------------------------------------------------------------

const MNRS_MAGIC       = [0x6d, 0x6f, 0x6f, 0x65, 0x72, 0x67, 0x65, 0x00]; // "mooerge\0"
const MNRS_INFO_TAG    = [0x69, 0x6e, 0x66, 0x6f]; // "info"
const MNRS_DATA_TAG    = [0x64, 0x61, 0x74, 0x61]; // "data"
const MNRS_DATA_OFFSET = 84;
const MNRS_CHUNK_DATA  = 400;
const MNRS_MAX_NAME    = 50;

const MNRS_TYPE_MAP: Record<number, [number, number, string]> = {
  0x02: [0x02, 10324, 'gnr'],  // preamp — proto_type 0x02
  0x04: [0x01,  4180, 'gir'],  // cab IR  — proto_type 0x01
};

function bytesEqual(a: Uint8Array | number[], b: number[]): boolean {
  if (a.length < b.length) return false;
  return b.every((v, i) => a[i] === v);
}

function readU32LE(d: Uint8Array, offset: number): number {
  return (d[offset] | (d[offset+1] << 8) | (d[offset+2] << 16)) + d[offset+3] * 0x1000000;
}

export interface MnrsMeta {
  type: 'gnr' | 'gir';
  protoType: number;
  payload: Uint8Array;
  totalChunks: number;
}

export function validateMnrsFile(data: Uint8Array): MnrsMeta {
  if (data.length < MNRS_DATA_OFFSET)
    throw new Error(`File too small (${data.length} bytes)`);
  if (!bytesEqual(data.slice(0, 8), MNRS_MAGIC))
    throw new Error(`Not a Mooer MNRS file (bad magic)`);
  if (!bytesEqual(data.slice(12, 16), MNRS_INFO_TAG))
    throw new Error(`Missing 'info' chunk tag at offset 12`);
  if (!bytesEqual(data.slice(76, 80), MNRS_DATA_TAG))
    throw new Error(`Missing 'data' chunk tag at offset 76`);

  const fileType = data[20];
  if (fileType === 0x03)
    throw new Error(`ENTIRE preamp+cab capture (type 0x03) — use individual P- or C- files`);
  if (!MNRS_TYPE_MAP[fileType])
    throw new Error(`Unknown MNRS type byte 0x${fileType.toString(16)} at offset 20`);

  const [protoType, expectedSize, label] = MNRS_TYPE_MAP[fileType];
  if (data.length !== expectedSize)
    throw new Error(`${label.toUpperCase()} file must be exactly ${expectedSize} bytes (got ${data.length})`);

  const dataLen = readU32LE(data, 80);
  const expectedData = expectedSize - MNRS_DATA_OFFSET;
  if (dataLen !== expectedData)
    throw new Error(`'data' length field says ${dataLen} bytes, expected ${expectedData}`);

  const payload = data.slice(MNRS_DATA_OFFSET);
  const totalChunks = 1 + Math.ceil(payload.length / MNRS_CHUNK_DATA);
  return { type: label as 'gnr' | 'gir', protoType, payload, totalChunks };
}

function buildMnrsChunk(protoType: number, slot: number, totalChunks: number,
                         chunkIdx: number, chunkPayload: Uint8Array): Uint8Array {
  const header = [protoType, slot & 0xFF, 0x00, totalChunks & 0xFF, chunkIdx & 0xFF,
                  chunkPayload.length & 0xFF, (chunkPayload.length >> 8) & 0xFF];
  return makePacket([0x61, ...header, ...chunkPayload]);
}

export function mnrsUploadPackets(fileBytes: Uint8Array, slot: number, name: string): Uint8Array[] {
  if (slot < 1 || slot > 10) throw new Error(`slot must be 1–10, got ${slot}`);
  name = name.trim();
  if (!name) throw new Error('name must not be empty');
  if (name.length > MNRS_MAX_NAME) throw new Error(`name too long (max ${MNRS_MAX_NAME} chars)`);

  const meta = validateMnrsFile(fileBytes);
  const nameBytes = new TextEncoder().encode(name.slice(0, MNRS_MAX_NAME));
  const { protoType, payload, totalChunks } = meta;

  const packets: Uint8Array[] = [];
  packets.push(buildMnrsChunk(protoType, slot, totalChunks, 0, nameBytes));
  for (let idx = 1, offset = 0; offset < payload.length; idx++, offset += MNRS_CHUNK_DATA) {
    const chunk = payload.slice(offset, offset + MNRS_CHUNK_DATA);
    packets.push(buildMnrsChunk(protoType, slot, totalChunks, idx, chunk));
  }
  return packets;
}

// ---------------------------------------------------------------------------
// Parameter encoding
// ---------------------------------------------------------------------------

export interface ParamDef {
  name: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  allowOff: boolean;
  // If set, slider position is an index into this array; wire value = values[index].
  // Allows non-linear stepping (e.g. LowCut: 0=OFF, 20-100 step 1, 110-600 step 10).
  values?: number[];
}

export function usesIndex(p: ParamDef): boolean {
  return p.min < 0 || p.step < 1;
}

function _closestIdx(values: number[], wire: number): number {
  let best = 0, bestDist = Math.abs(values[0] - wire);
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i] - wire);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Maps device wire value → slider position (index for values-params, wire for others).
export function wireToSlider(p: ParamDef, wire: number): number {
  if (p.values) return _closestIdx(p.values, wire);
  return wire;
}

// Maps slider position → device wire value to send over BLE.
export function sliderToWire(p: ParamDef, sliderPos: number): number {
  if (p.values) return p.values[Math.max(0, Math.min(sliderPos, p.values.length - 1))] ?? 0;
  return sliderPos;
}

export function wireToDisplay(p: ParamDef, wire: number): number {
  if (p.allowOff && wire === 0) return 0;
  if (p.values) return wire;
  return usesIndex(p) ? p.min + wire * p.step : wire;
}

export function displayToWire(p: ParamDef, display: number): number {
  if (p.allowOff && display === 0) return 0;
  if (p.values) return p.values[_closestIdx(p.values, display)] ?? 0;
  return usesIndex(p) ? Math.round((display - p.min) / p.step) : Math.round(display);
}

export function wireMax(p: ParamDef): number {
  if (p.values) return p.values.length - 1;
  return usesIndex(p) ? Math.round((p.max - p.min) / p.step) : p.max;
}

export function wireToDisplayStr(wire: number, p: ParamDef | null): string {
  if (!p) return String(wire);
  if (p.allowOff && wire === 0) return 'OFF';
  if (p.values) return p.unit ? `${wire}${p.unit}` : String(wire);
  if (!usesIndex(p)) return p.unit ? `${wire}${p.unit}` : String(wire);
  const display = p.min + wire * p.step;
  const showSign = p.min < 0;
  const stepStr = p.step.toString().replace(/0+$/, '').replace(/\.$/, '');
  const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
  const formatted = decimals > 0
    ? (showSign ? (display >= 0 ? '+' : '') : '') + display.toFixed(decimals)
    : (showSign ? (display >= 0 ? '+' : '') : '') + Math.round(display).toString();
  return p.unit ? `${formatted}${p.unit}` : formatted;
}
