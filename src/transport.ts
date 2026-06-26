/**
 * Web Bluetooth transport + session state for the Mooer F15i.
 *
 * Uses Web Bluetooth API (Chrome/Edge only, HTTPS required).
 */

import {
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID,
  Reassembler,
  parseFxParamsPayload, parsePresetParams, parsePresetNames,
  parseMnrsSlotList, parseDrumListResponse,
  cmdListGnrSlots, cmdListGirSlots,
  mnrsUploadPackets,
  type FxParamsParsed, type PresetParsed, type MnrsSlot, type PresetNamesParsed,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Action-ID counters
// ---------------------------------------------------------------------------

const ACTION_RANGES: [number, number][] = [
  [0x00, 0x31],  // ADD
  [0x32, 0x63],  // REMOVE
  [0x64, 0x95],  // REPLACE
  [0x96, 0xC7],  // MOVE
];

class ActionIdCounters {
  private _vals = [0x00, 0x32, 0x64, 0x96];

  next(op: 0 | 1 | 2 | 3): number {
    const id = this._vals[op];
    const [, max] = ACTION_RANGES[op];
    const [min]   = ACTION_RANGES[op];
    this._vals[op] = id + 1 > max ? min : id + 1;
    return id;
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface FxState {
  slot: number;
  catId: number;
  effIdx: number;
  enabled: number;
  params: number[]; // slider values
}

export interface FxChainEntry {
  slot: number;
  catId: number;
  effIdx: number;
  enabled: number;
  params: number[];
}

export interface SessionState {
  fxState: Map<number, FxState>;          // slot → FxState
  fxChain: FxChainEntry[];                // ordered chain from last preset read
  mnrsNames: Record<number, string>;      // type(1=GNR,2=GIR) → name
  globalParamsD: Uint8Array | null;       // raw 0x12 response payload
  fxBudget: number[];                     // 9 values (per-cat)
  presetNames: Record<number, string>;    // presetId(1–80) → name
  activePreset: number;
  deviceName: string;
  batteryPct: number | null;
  batteryStatus: number | null;
  firmwareVersion: string;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type TransportEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'preset_loaded'; parsed: PresetParsed }
  | { type: 'fx_params'; parsed: FxParamsParsed }
  | { type: 'global_params'; d: Uint8Array }
  | { type: 'preset_names'; parsed: PresetNamesParsed }
  | { type: 'fx_budget'; budget: number[] }
  | { type: 'battery'; pct: number; status: number }
  | { type: 'tuner'; raw: number; dev: number }
  | { type: 'drum_state'; d: Uint8Array }
  | { type: 'drum_bpm'; bpm: number }
  | { type: 'looper_state'; d: Uint8Array }
  | { type: 'mnrs_ack'; slot: number }
  | { type: 'mnrs_slots'; catType: number; slots: MnrsSlot[] }
  | { type: 'device_info'; d: Uint8Array }
  | { type: 'error'; msg: string };

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

export class F15iTransport {
  private _device: BluetoothDevice | null = null;
  private _server: BluetoothRemoteGATTServer | null = null;
  private _writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private _notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private _reassembler = new Reassembler();
  private _actionIds = new ActionIdCounters();

  readonly state: SessionState = {
    fxState: new Map(),
    fxChain: [],
    mnrsNames: {},
    globalParamsD: null,
    fxBudget: [],
    presetNames: {},
    activePreset: 1,
    deviceName: '',
    batteryPct: null,
    batteryStatus: null,
    firmwareVersion: '',
  };

  private _listeners: Array<(e: TransportEvent) => void> = [];

  // FIFO queue for MNRS slot-list responses (response has no cat-type header)
  private _mnrsSlotsQueue: Array<(slots: MnrsSlot[]) => void> = [];
  private _mnrsAckResolve: ((slot: number) => void) | null = null;

  on(listener: (e: TransportEvent) => void): () => void {
    this._listeners.push(listener);
    return () => { this._listeners = this._listeners.filter(l => l !== listener); };
  }

  private _emit(e: TransportEvent): void {
    for (const l of this._listeners) l(e);
  }

  get isConnected(): boolean {
    return !!this._server?.connected;
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge on desktop.');
    }

    this._device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'F15i' },
        { namePrefix: 'F15' },
        { namePrefix: 'Mooer' },
        { namePrefix: 'iAMP' },
      ],
      optionalServices: [SERVICE_UUID],
    });

    this._device.addEventListener('gattserverdisconnected', () => {
      this._writeChar = null;
      this._notifyChar = null;
      this._server = null;
      this._reassembler.reset();
      this._emit({ type: 'disconnected' });
    });

    this._server = await this._device.gatt!.connect();
    const service = await this._server.getPrimaryService(SERVICE_UUID);
    this._writeChar  = await service.getCharacteristic(WRITE_UUID);
    this._notifyChar = await service.getCharacteristic(NOTIFY_UUID);

    this._notifyChar.addEventListener('characteristicvaluechanged', (ev: Event) => {
      const target = ev.target as BluetoothRemoteGATTCharacteristic;
      const dv = target.value!;
      const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      console.log('[BLE RX]', Array.from(raw).map(b => b.toString(16).padStart(2,'0')).join(' '));
      const packets = this._reassembler.feed(raw);
      for (const pkt of packets) this._handlePacket(pkt);
    });
    await this._notifyChar.startNotifications();
    console.log('[BLE] notifications started on', NOTIFY_UUID);

    this._emit({ type: 'connected' });
  }

  async disconnect(): Promise<void> {
    if (this._server?.connected) {
      this._server.disconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  async write(pkt: Uint8Array): Promise<void> {
    if (!this._writeChar) throw new Error('Not connected');
    console.log('[BLE TX]', Array.from(pkt).map(b => b.toString(16).padStart(2,'0')).join(' '));
    await this._writeChar.writeValueWithResponse(pkt.buffer as ArrayBuffer);
  }

  async writeAll(pkts: Uint8Array[]): Promise<void> {
    for (const p of pkts) await this.write(p);
  }

  // ---------------------------------------------------------------------------
  // Notification handler
  // ---------------------------------------------------------------------------

  private _handlePacket(pkt: Uint8Array): void {
    if (pkt.length < 5) return;
    // pkt = [0xAA, 0x55, len_lo, len_hi, cmd, ...payload, crc_hi, crc_lo]
    const plen = pkt[2] | (pkt[3] << 8);
    const payload = pkt.slice(4, 4 + plen);
    if (payload.length === 0) return;
    const cmd = payload[0];
    const d   = payload.slice(1);

    switch (cmd) {
      case 0x02: { // device info response
        // Firmware version: find 'V' byte, read null-terminated ASCII string
        const vIdx = d.indexOf(0x56); // ord('V')
        if (vIdx !== -1) {
          let end = vIdx + 1;
          while (end < d.length && d[end] !== 0) end++;
          this.state.firmwareVersion = new TextDecoder().decode(d.slice(vIdx, end));
        }
        this._emit({ type: 'device_info', d });
        break;
      }

      case 0x12: // global params
        this.state.globalParamsD = new Uint8Array(d);
        if (d.length > 0) this.state.activePreset = d[0];
        this._emit({ type: 'global_params', d: new Uint8Array(d) });
        break;

      case 0x22: // preset params (full chain)
      {
        const parsed = parsePresetParams(d);
        if (parsed) {
          this.state.fxChain = parsed.effects.map(e => ({ ...e }));
          Object.assign(this.state.mnrsNames, parsed.mnrsNames);
          // Sync fxState from chain
          for (const e of parsed.effects) {
            this.state.fxState.set(e.slot, { ...e });
          }
          this._emit({ type: 'preset_loaded', parsed });
        }
        break;
      }

      case 0x24: // single fx params
      {
        const parsed = parseFxParamsPayload(d);
        if (parsed) {
          const { slot, catId, params } = parsed;
          const enabled  = params[0] ?? 0;
          const effIdx   = params[1] ?? 0;
          const sliders  = params.slice(2);
          this.state.fxState.set(slot, { slot, catId, effIdx, enabled, params: sliders });
          this._emit({ type: 'fx_params', parsed });
        }
        break;
      }

      case 0x2A: // preset names
      {
        const parsed = parsePresetNames(d);
        if (parsed) {
          Object.assign(this.state.presetNames, parsed.names);
          this._emit({ type: 'preset_names', parsed });
        }
        break;
      }

      case 0x2C: // fx budget
        this.state.fxBudget = Array.from(d);
        this._emit({ type: 'fx_budget', budget: Array.from(d) });
        break;

      case 0x45: // tuner
        if (d.length >= 2) {
          this._emit({ type: 'tuner', raw: d[0], dev: d[1] });
        }
        break;

      case 0x62: // MNRS upload ACK
      {
        const slot = d[1] ?? 0; // ACK payload: [proto_type, slot, 0x00, chunk_idx]
        if (this._mnrsAckResolve) {
          const resolve = this._mnrsAckResolve;
          this._mnrsAckResolve = null;
          resolve(slot);
        }
        this._emit({ type: 'mnrs_ack', slot });
        break;
      }

      case 0x66: // MNRS slot list response — raw 59-byte entries, no header
      {
        const slots = parseMnrsSlotList(d);
        const resolve = this._mnrsSlotsQueue.shift();
        if (resolve) resolve(slots);
        this._emit({ type: 'mnrs_slots', catType: 0, slots });
        break;
      }

      case 0x92: // battery
        if (d.length >= 2) {
          this.state.batteryPct    = d[0];
          this.state.batteryStatus = d[1];
          this._emit({ type: 'battery', pct: d[0], status: d[1] });
        }
        break;

      case 0x18: // drum state (338-byte block with float32 fields — different layout from 0x12)
      case 0x48:
        this._emit({ type: 'drum_state', d });
        break;

      case 0x93: // drum BPM notification (response to 0x91 in drum-tool context, u16 LE)
        if (d.length >= 2) this._emit({ type: 'drum_bpm', bpm: d[0] | (d[1] << 8) });
        break;

      case 0x4E: // looper state
        this._emit({ type: 'looper_state', d });
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // High-level helpers
  // ---------------------------------------------------------------------------

  nextActionId(op: 0 | 1 | 2 | 3): number { return this._actionIds.next(op); }

  /** Sends the GNR or GIR slot-list request and resolves when the 0x66 response arrives. */
  async getMnrsSlots(cat: 'gnr' | 'gir'): Promise<MnrsSlot[]> {
    return new Promise((resolve) => {
      this._mnrsSlotsQueue.push(resolve);
      const pkt = cat === 'gnr' ? cmdListGnrSlots() : cmdListGirSlots();
      this.write(pkt).catch(() => {
        const idx = this._mnrsSlotsQueue.indexOf(resolve);
        if (idx >= 0) this._mnrsSlotsQueue.splice(idx, 1);
        resolve([]);
      });
    });
  }

  /**
   * Uploads an MNRS file with stop-and-wait ACK per chunk.
   * @param onProgress (chunkSent, totalChunks) callback
   */
  async uploadMnrs(
    fileBytes: Uint8Array,
    slot: number,
    name: string,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const packets = mnrsUploadPackets(fileBytes, slot, name);
    const total = packets.length;
    for (let i = 0; i < packets.length; i++) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._mnrsAckResolve = null;
          reject(new Error(`Upload timeout on chunk ${i}`));
        }, 5000);

        this._mnrsAckResolve = () => {
          clearTimeout(timeout);
          resolve();
        };

        this.write(packets[i]).catch(reject);
      });
      onProgress?.(i + 1, total);
    }
  }
}
