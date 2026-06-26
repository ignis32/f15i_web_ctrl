/**
 * F15i effect catalogue — all effects, parameters, and drum tracks.
 *
 * ParamDef encoding:
 *   - Direct (wire == display value): min >= 0 AND step == 1.0
 *   - Index (wire = round((display - min) / step)): min < 0 OR step != 1.0
 */

import type { ParamDef } from './protocol.js';

// ---------------------------------------------------------------------------
// ParamDef helpers
// ---------------------------------------------------------------------------

function P(name: string, min: number, max: number, step = 1.0, unit = '', allowOff = false): ParamDef {
  return { name, min, max, step, unit, allowOff };
}

// ---------------------------------------------------------------------------
// Shared sub-defs reused across effects
// ---------------------------------------------------------------------------

const _PRE  = P('Pre Delay',  0,   200,  1,    'ms');
const _TONE = P('Tone',       0,   100,  1);
const _TIME = P('Time',       40,  2500, 1,    'ms');
const _SEMI = P('Pitch',     -12,   12,  0.1,  'semi');
const _CENT = P('Pitch',    -100,  100,  1.0,  'Cent');
const _FDBACK = P('Feedback', 0,   100,  1,    '%');

// EQ dB bands: -16..+16dB, step 0.5 → wire 0..64, 32 = 0dB
const _EQ_BAND = P('EQ', -16, 16, 0.5, 'dB');

// LowCut / HighCut — non-linear stepped values matching original app behaviour.
// Wire 0 = OFF; otherwise wire value = Hz cutoff directly.
function _seq(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  if (step > 0) { for (let v = from; v <= to; v += step) out.push(v); }
  else          { for (let v = from; v >= to; v += step) out.push(v); }
  return out;
}
const _LC_VALS  = [0, ..._seq(20, 100, 1),       ..._seq(110,   600,    10)];
const _HC_VALS  = [0, ..._seq(20000, 10000, -1000), ..._seq(9900, 2000, -100)];
const _B1F_VALS = [..._seq(40,   100,    1),  ..._seq(110,   600,    10)];
const _B2F_VALS = [..._seq(200,  1000,  10),  ..._seq(1100, 1900,   100)];
const _B3F_VALS = [..._seq(600,  1000,  10),  ..._seq(1100, 7000,   100)];
const _B4F_VALS = [..._seq(1500, 10000, 100), ..._seq(11000, 20000, 1000)];

function PV(name: string, vals: number[], unit = '', allowOff = false): ParamDef {
  return { name, min: 0, max: 0, step: 1, unit, allowOff, values: vals };
}

function _LC(): ParamDef { return PV('Low Cut',  _LC_VALS, 'Hz', true); }
function _HC(): ParamDef { return PV('High Cut', _HC_VALS, 'Hz', true); }

const _LC_200  = _LC();
const _HC_FULL = _HC();
const _LC_EQ   = _LC();
const _HC_EQ   = _HC();

// ---------------------------------------------------------------------------
// Category colour map
// ---------------------------------------------------------------------------

export const CAT_COLOR: Record<number, string> = {
  1: '#FF6B35',
  2: '#FFD700',
  3: '#9E9E9E',
  4: '#4FC3F7',
  5: '#AB47BC',
  6: '#26C6DA',
  7: '#66BB6A',
  8: '#7986CB',
  9: '#26A69A',
};

// ---------------------------------------------------------------------------
// OD/DS — category 1 (22 effects)
// ---------------------------------------------------------------------------

const _OD = (): ParamDef[] => [P('Gain',0,100), P('Tone',0,100), P('Vol',0,100)];

const OD_EFFECTS: [string, ParamDef[]][] = [
  ['Pure Boost',      _OD()],
  ['Flex Boost',      _OD()],
  ['Tube DR',         _OD()],
  ['808',             _OD()],
  ['Gold Clon',       _OD()],
  ['D-Drive',         _OD()],
  ['Jimmy OD',        _OD()],
  ['Full DR',         _OD()],
  ['Beebee Pre',      _OD()],
  ['Beebee+',         _OD()],
  ['Black Rat',       _OD()],
  ['Grey Faze',       _OD()],
  ['Muffy',           _OD()],
  ['Full DS',         _OD()],
  ['Shred',           _OD()],
  ['Riet',            _OD()],
  ['MTL Zone',        _OD()],
  ['MTL Master',      _OD()],
  ['Obsessive Dist',  _OD()],
  ['ODR 1',           _OD()],
  ['BE OD',           _OD()],
  ['Solo',            _OD()],
];

// ---------------------------------------------------------------------------
// Amp — category 2 (55 effects + MNRS GNR slots appended at runtime)
// ---------------------------------------------------------------------------

const _AMP = (): ParamDef[] => [P('Gain',0,100),P('Bass',0,100),P('Mid',0,100),P('Treble',0,100),P('Presence',0,100),P('Master',0,100)];

const AMP_EFFECTS: [string, ParamDef[]][] = [
  ['65 US DLX',       _AMP()],
  ['65 US TW',        _AMP()],
  ['59 US Bass',      _AMP()],
  ['US Sonic',        _AMP()],
  ['US Blues CL',     _AMP()],
  ['US Blues OD',     _AMP()],
  ['E650 CL',         _AMP()],
  ['Powerbell CL',    _AMP()],
  ['Blacknight CL',   _AMP()],
  ['Mark III CL',     _AMP()],
  ['Mark V CL',       _AMP()],
  ['Tri Rec CL',      _AMP()],
  ['Rockvrb CL',      _AMP()],
  ['Dr Zee 18 JR',    _AMP()],
  ['Dr Zee Reck',     _AMP()],
  ['Jet 100H CL',     _AMP()],
  ['Jazz 120',        _AMP()],
  ['UK 30 CL',        _AMP()],
  ['UK 30 OD',        _AMP()],
  ['HWT 103',         _AMP()],
  ['PV 5050 CL',      _AMP()],
  ['Regal Tone CL',   _AMP()],
  ['Regal Tone OD1',  _AMP()],
  ['Carol CL',        _AMP()],
  ['Cardeff',         _AMP()],
  ['EV 5050 CL',      _AMP()],
  ['HT Club CL',      _AMP()],
  ['Hugen CL',        _AMP()],
  ['Koche OD',        _AMP()],
  ['J800',            _AMP()],
  ['J900',            _AMP()],
  ['PLX 100',         _AMP()],
  ['E650 DS',         _AMP()],
  ['Powerbell DS',    _AMP()],
  ['Blacknight DS',   _AMP()],
  ['Mark III DS',     _AMP()],
  ['Mark V DS',       _AMP()],
  ['Tri Rec DS',      _AMP()],
  ['Rockvrb DS',      _AMP()],
  ['Citrus 30',       _AMP()],
  ['Citrus 50',       _AMP()],
  ['Slow 100 CR',     _AMP()],
  ['Slow 100 DS',     _AMP()],
  ['Jet 100H OD',     _AMP()],
  ['PV 5050 DS',      _AMP()],
  ['Regal Tone OD2',  _AMP()],
  ['Carol OD',        _AMP()],
  ['EV 5050 DS',      _AMP()],
  ['HT Club DS',      _AMP()],
  ['Hugen OD',        _AMP()],
  ['Hugen DS',        _AMP()],
  ['Koche DS',        _AMP()],
  ['Mvrkbass 500',    _AMP()],
  ['Ampog SVT 4',     _AMP()],
  ['Akuila 750 CL',   _AMP()],
];

// ---------------------------------------------------------------------------
// Cab — category 3 (0 built-in effects; MNRS GIR slots appended at runtime)
// ---------------------------------------------------------------------------

const CAB_EFFECTS: [string, ParamDef[]][] = [];

// ---------------------------------------------------------------------------
// Dyna — category 4 (4 effects)
// ---------------------------------------------------------------------------

const DYNA_EFFECTS: [string, ParamDef[]][] = [
  ['Red Comp',     [P('Sensitive', 0,100), P('Level', 0,100)]],
  ['Yellow Comp',  [P('Attack', 0,100), P('Ratio', 0,100), P('Threshold', 0,100), P('Level', 0,100)]],
  ['Noise Killer', [P('Threshold', 0,100), P('Level', 0,100)]],
  ['Intel Reducer',[P('Threshold', 0,100), P('Depth', 0,100), P('Level', 0,100)]],
];

// ---------------------------------------------------------------------------
// Filter — category 5 (3 effects)
// ---------------------------------------------------------------------------

const FILTER_EFFECTS: [string, ParamDef[]][] = [
  ['TouchWah',  [P('Attack', 0,100), P('Peak', 0,100), P('Sensitive', 0,100), P('Level', 0,100)]],
  ['AutoWah',   [P('Rate', 0,100), P('Peak', 0,100), P('Range', 0,100), P('Level', 0,100)]],
  ['Q-Filter',  [P('Rate', 0,100), P('Q', 0,100), P('Mix', 0,100)]],
];

// ---------------------------------------------------------------------------
// Mod — category 6 (17 effects)
// ---------------------------------------------------------------------------

const MOD_EFFECTS: [string, ParamDef[]][] = [
  ['Phaser',      [P('Rate',0,100), P('Level',0,100), P('Depth',0,100)]],
  ['Step Phaser', [P('Rate',0,100), P('Level',0,100), P('Depth',0,100)]],
  ['Flanger',     [P('Rate',0,100), P('Mix',0,100), P('Feedback',0,100)]],
  ['Jet Flanger', [P('Rate',0,100), P('Mix',0,100), P('Feedback',0,100)]],
  ['Tremolo',     [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100)]],
  ['Stutter',     [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100)]],
  ['Vibrato',     [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100)]],
  ['Rotary',      [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100)]],
  ['Ring',        [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100)]],
  ['Poly Shift',  [P('Mix',0,100), P('Tone',0,100), P('Pitch',-12,12,0.1,'semi')]],
  ['Ana Chorus',  [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100), P('Depth',0,100)]],
  ['Tri Chorus',  [P('Rate',0,100), P('Mix',0,100), P('Tone',0,100), P('Depth',0,100)]],
  ['Lofi',        [P('Sample',0,100), P('Mix',0,100), P('Bit',0,100)]],
  ['Slow Gear',   [P('Rise',0,100), P('Level',0,100)]],
  ['Panner',      [P('Rate',0,100), P('Tone',0,100), P('Depth',0,100), P('Duty',0,100)]],
  ['Detune',      [P('Pitch',-100,100,1,'Cent'), P('Tone',0,100), P('Mix',0,100)]],
  ['Octave',      [P('Sub',0,100), P('SubTone',0,100), P('Upper',0,100), P('UpperTone',0,100), P('Dry',0,100)]],
];

// ---------------------------------------------------------------------------
// Delay — category 7 (12 effects)
// ---------------------------------------------------------------------------

const _DLY = (): ParamDef[] => [P('Level',0,100), P('Feedback',0,100), P('Time',40,2500,1,'ms')];

const DELAY_EFFECTS: [string, ParamDef[]][] = [
  ['Digital',       _DLY()],
  ['Analog',        _DLY()],
  ['Real Echo',     _DLY()],
  ['Tape',          _DLY()],
  ['Mod',           _DLY()],
  ['Reverse',       _DLY()],
  ['PingPong',      _DLY()],
  ['Crystal',       [..._DLY(), P('Depth',0,100), P('Rate',0,100)]],
  ['Rainbow',       [..._DLY(), P('Depth',0,100), P('Rate',0,100)]],
  ['Vintage Delay', [..._DLY(), P('Bit',0,100), P('SRate',0,100)]],
  ['Galaxy Delay',  [..._DLY(), P('ModRate',0,100), P('ModDepth',0,100), P('Attack',0,100)]],
  ['Sweep',         [..._DLY(), P('Rate',0,100), P('Range',300,4000)]],
];

// ---------------------------------------------------------------------------
// Reverb — category 8 (9 effects)
// ---------------------------------------------------------------------------

const _RVB = (): ParamDef[] => [_PRE, P('Level',0,100), P('Decay',0,100), P('Tone',0,100)];

const REVERB_EFFECTS: [string, ParamDef[]][] = [
  ['Room',          _RVB()],
  ['Hall',          _RVB()],
  ['Plate',         _RVB()],
  ['Spring',        _RVB()],
  ['Mod',           _RVB()],
  ['Shimmer',       _RVB()],
  ['Fl-Reverb',     [..._RVB(), P('Rate',0,100), P('Feedback',0,100), P('ModDelay',0,100), P('ModLevel',0,100)]],
  ['Reverse Rev',   _RVB()],
  ['Dist Reverb',   [..._RVB(), P('Gain',0,100), P('Dist Level',0,100)]],
];

// ---------------------------------------------------------------------------
// EQ — category 9 (2 effects)
// ---------------------------------------------------------------------------

const EQ_EFFECTS: [string, ParamDef[]][] = [
  ['5BandEQ', [
    P('100Hz',  -16, 16, 0.5, 'dB'),
    P('250Hz',  -16, 16, 0.5, 'dB'),
    P('630Hz',  -16, 16, 0.5, 'dB'),
    P('1600Hz', -16, 16, 0.5, 'dB'),
    P('4000Hz', -16, 16, 0.5, 'dB'),
    P('Level',    0, 100),
  ]],
  ['CustomEQ', [
    P('B1 Gain', -16, 16, 0.5, 'dB'), PV('B1 Freq', _B1F_VALS, 'Hz'), P('B1 Q', 0.2, 10.0, 0.1),
    P('B2 Gain', -16, 16, 0.5, 'dB'), PV('B2 Freq', _B2F_VALS, 'Hz'), P('B2 Q', 0.2, 10.0, 0.1),
    P('B3 Gain', -16, 16, 0.5, 'dB'), PV('B3 Freq', _B3F_VALS, 'Hz'), P('B3 Q', 0.2, 10.0, 0.1),
    P('B4 Gain', -16, 16, 0.5, 'dB'), PV('B4 Freq', _B4F_VALS, 'Hz'), P('B4 Q', 0.2, 10.0, 0.1),
    _LC_EQ, _HC_EQ,
    P('Level', 0, 100),
  ]],
];

// ---------------------------------------------------------------------------
// MNRS param defs (GNR / GIR)
// ---------------------------------------------------------------------------

export const GNR_PARAMS: ParamDef[] = [
  P('Gain', 0, 100),
  P('Bass', 0, 100),
  P('Mid',  0, 100),
  P('Treble', 0, 100),
  P('Presence', 0, 100),
  P('Master', 0, 100),
];

export const GIR_PARAMS: ParamDef[] = [
  P('Level', 0, 100),
  _LC(),
  _HC(),
];

// ---------------------------------------------------------------------------
// FX_CAT: all effect categories and their effects
// ---------------------------------------------------------------------------

export interface CatEntry {
  name: string;
  effects: [string, ParamDef[]][];
}

export const FX_CAT: Record<number, CatEntry> = {
  1: { name: 'OD',     effects: OD_EFFECTS     },
  2: { name: 'Amp',    effects: AMP_EFFECTS     },
  3: { name: 'Cab',    effects: CAB_EFFECTS     },
  4: { name: 'Dyna',   effects: DYNA_EFFECTS    },
  5: { name: 'Filter', effects: FILTER_EFFECTS  },
  6: { name: 'Mod',    effects: MOD_EFFECTS     },
  7: { name: 'Delay',  effects: DELAY_EFFECTS   },
  8: { name: 'Reverb', effects: REVERB_EFFECTS  },
  9: { name: 'EQ',     effects: EQ_EFFECTS      },
};

export const CAT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export function getCatName(catId: number): string {
  return FX_CAT[catId]?.name ?? `Cat${catId}`;
}

/** Returns the name and ParamDef list for a built-in effect. Returns null for MNRS slots. */
export function getEffectEntry(catId: number, effIdx: number): [string, ParamDef[]] | null {
  const cat = FX_CAT[catId];
  if (!cat) return null;
  const entry = cat.effects[effIdx];
  return entry ?? null;
}

// ---------------------------------------------------------------------------
// Drum catalogue
// ---------------------------------------------------------------------------

const DRUM_GENRES = ['POP','ROCK','BLUES','FUNK','JAZZ','METAL','METRONOME'] as const;

/** 70 tracks (0-based index in catalogue, 1-based in protocol). */
export const DRUM_TRACKS: string[] = [];
for (const genre of DRUM_GENRES) {
  for (let n = 1; n <= 10; n++) {
    DRUM_TRACKS.push(`${genre} ${n}`);
  }
}

/** Convert 0-based catalogue index → 1-based protocol index. */
export const drumCatToProto = (catIdx: number): number => catIdx + 1;

/** Convert 1-based protocol index → 0-based catalogue index. */
export const drumProtoToCat = (protoIdx: number): number => protoIdx - 1;
