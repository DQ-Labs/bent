// Shared Project Schema, 8 Global Circuit-Bend Macros, Procedural Video Generators,
// and Default 16-Pad Traktor Kontrol F1 Configuration for Bent.

export const CANVAS_PRESETS = [
  { id: '1080p', label: '1920 × 1080 (16:9 Full HD)', width: 1920, height: 1080 },
  { id: '720p', label: '1280 × 720 (16:9 HD Ready)', width: 1280, height: 720 },
  { id: 'crt-ntsc', label: '640 × 480 (4:3 Retro NTSC CRT)', width: 640, height: 480 },
  { id: 'square', label: '1080 × 1080 (1:1 Square)', width: 1080, height: 1080 },
  { id: 'vertical', label: '1080 × 1920 (9:16 Vertical)', width: 1080, height: 1920 }
];

export const PAD_KEY_BINDINGS = [
  '1', '2', '3', '4',
  'Q', 'W', 'E', 'R',
  'A', 'S', 'D', 'F',
  'Z', 'X', 'C', 'V'
];

export const GLOBAL_MACROS = [
  {
    index: 0,
    id: 'chromaPhase',
    shortName: 'CHROMA PHASE',
    name: 'Knob 1 — YIQ Chroma Phase & NTSC Bleed',
    controlType: 'knob',
    column: 1,
    defaultValue: 0.0,
    color: '#ff3864',
    description: 'Shifts composite YIQ color sub-carrier phase and cross-modulates luma into rainbow NTSC artifacts.'
  },
  {
    index: 1,
    id: 'hSyncTear',
    shortName: 'H-SYNC TEAR',
    name: 'Knob 2 — CRT H-Sync Tear & VHS Tracking',
    controlType: 'knob',
    column: 2,
    defaultValue: 0.0,
    color: '#00f5d4',
    description: 'Corrupts horizontal scanline sync timing, adding line shear, tracking noise bars, and vertical hold jitter.'
  },
  {
    index: 2,
    id: 'feedbackWarp',
    shortName: 'FBACK WARP',
    name: 'Knob 3 — Dirty Mixer Feedback Warp',
    controlType: 'knob',
    column: 3,
    defaultValue: 0.25,
    color: '#ffbe0b',
    description: 'Controls recursive zoom, spin rotation, and YIQ hue drift inside the framebuffer feedback loop.'
  },
  {
    index: 3,
    id: 'pixelMelt',
    shortName: 'PIXEL MELT',
    name: 'Knob 4 — Threshold Melt & Block Corrupt',
    controlType: 'knob',
    column: 4,
    defaultValue: 0.0,
    color: '#b5179e',
    description: 'Sorts and smears scanline pixels above a luma threshold while quantizing UV macroblocks.'
  },
  {
    index: 4,
    id: 'wavefoldDrive',
    shortName: 'WAVEFOLDER',
    name: 'Fader 1 — Op-Amp Analog Wavefolder',
    controlType: 'fader',
    column: 1,
    defaultValue: 0.0,
    color: '#ff6b8b',
    description: 'Overdrives video signal voltage through a multi-stage triangle/sine wavefolder for solarized neon contours.'
  },
  {
    index: 5,
    id: 'wobbulator',
    shortName: 'WOBBULATOR',
    name: 'Fader 2 — Rutt-Etra Scanline Deflection',
    controlType: 'fader',
    column: 2,
    defaultValue: 0.0,
    color: '#00bbf9',
    description: 'Displaces CRT scanlines horizontally and vertically using pixel luminance and live audio wave energy.'
  },
  {
    index: 6,
    id: 'feedbackMix',
    shortName: 'FBACK MIX',
    name: 'Fader 3 — Ping-Pong Frame Feedback Decay',
    controlType: 'fader',
    column: 3,
    defaultValue: 0.0,
    color: '#fee440',
    description: 'Crossfades recursive framebuffer delay feedback from 0% clean up to self-oscillating video tunnels.'
  },
  {
    index: 7,
    id: 'datamoshHold',
    shortName: 'MOSH HOLD',
    name: 'Fader 4 — Luma-Key Datamosh Smear',
    controlType: 'fader',
    column: 4,
    defaultValue: 0.0,
    color: '#c77dff',
    description: 'Holds prior reference frames and pushes frozen pixels using the optical luma delta of incoming motion.'
  }
];

export const PROCEDURAL_CLIPS = [
  {
    id: 'clip-pm5544',
    name: 'PM5544 Broadcast Test Card',
    sourceType: 'procedural',
    generatorId: 'pm5544',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  },
  {
    id: 'clip-oscilloscope',
    name: 'Lissajous Vector Oscilloscope',
    sourceType: 'procedural',
    generatorId: 'oscilloscope',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  },
  {
    id: 'clip-cybergrid',
    name: '1984 Vector Horizon & Polyhedra',
    sourceType: 'procedural',
    generatorId: 'cybergrid',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  },
  {
    id: 'clip-contours',
    name: 'Topographic Luma Plasma',
    sourceType: 'procedural',
    generatorId: 'contours',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  },
  {
    id: 'clip-datastream',
    name: 'Telemetry Radar & Scan Matrix',
    sourceType: 'procedural',
    generatorId: 'datastream',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  },
  {
    id: 'clip-moire',
    name: 'Zone Plate Moiré Interference',
    sourceType: 'procedural',
    generatorId: 'moire',
    duration: 16.0,
    inPoint: 0.0,
    outPoint: 16.0,
    speed: 1.0,
    loopMode: 'loop',
    reverse: false,
    cropZoom: 1.0,
    flipH: false,
    flipV: false
  }
];

export function createDefaultPads() {
  const presets = [
    // Row 1 (Pads 1-4): Clean & Lightly Bent Clips
    {
      name: 'PM5544 Clean',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-pm5544',
      color: '#00f5d4',
      bendSignature: [0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'Vector Scope',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-oscilloscope',
      color: '#00bbf9',
      bendSignature: [0.1, 0.0, 0.35, 0.0, 0.0, 0.12, 0.35, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'Horizon Grid',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-cybergrid',
      color: '#ff3864',
      bendSignature: [0.18, 0.05, 0.25, 0.0, 0.15, 0.0, 0.2, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'Luma Plasma',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-contours',
      color: '#ffbe0b',
      bendSignature: [0.22, 0.0, 0.3, 0.0, 0.38, 0.1, 0.15, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },

    // Row 2 (Pads 5-8): Circuit-Bent Variations
    {
      name: 'Telemetry Radar',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-datastream',
      color: '#38b000',
      bendSignature: [0.05, 0.18, 0.2, 0.15, 0.0, 0.2, 0.25, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'Moiré Rings',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-moire',
      color: '#9b5de5',
      bendSignature: [0.35, 0.08, 0.45, 0.0, 0.45, 0.18, 0.3, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'Bent Test Card',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-pm5544',
      color: '#ff6b8b',
      bendSignature: [0.55, 0.32, 0.25, 0.12, 0.62, 0.25, 0.2, 0.0],
      speedMultiplier: 1.5,
      reverse: false
    },
    {
      name: 'Reverse Horizon',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-cybergrid',
      color: '#f15bb5',
      bendSignature: [0.4, 0.22, 0.6, 0.0, 0.3, 0.35, 0.55, 0.0],
      speedMultiplier: 1.25,
      reverse: true
    },

    // Row 3 (Pads 9-12): High-Energy / Double-Speed / Half-Time Clips
    {
      name: 'Scope Tunnel 2x',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-oscilloscope',
      color: '#4cc9f0',
      bendSignature: [0.3, 0.1, 0.72, 0.0, 0.25, 0.4, 0.78, 0.0],
      speedMultiplier: 2.0,
      reverse: false
    },
    {
      name: 'Folded Plasma',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-contours',
      color: '#ff9f1c',
      bendSignature: [0.68, 0.0, 0.35, 0.2, 0.82, 0.15, 0.25, 0.0],
      speedMultiplier: 0.75,
      reverse: false
    },
    {
      name: 'Corrupt Matrix',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-datastream',
      color: '#7209b7',
      bendSignature: [0.25, 0.55, 0.3, 0.65, 0.2, 0.45, 0.35, 0.4],
      speedMultiplier: 1.5,
      reverse: false
    },
    {
      name: 'Moiré Meltdown',
      role: 'clip',
      triggerMode: 'latch',
      clipId: 'clip-moire',
      color: '#f72585',
      bendSignature: [0.75, 0.4, 0.65, 0.5, 0.7, 0.55, 0.65, 0.3],
      speedMultiplier: 1.0,
      reverse: true
    },

    // Row 4 (Pads 13-16): Momentary Circuit-Bend FX Punches (Gate Hold)
    {
      name: 'FX: NTSC Overload',
      role: 'fx',
      triggerMode: 'gate',
      clipId: 'clip-pm5544',
      color: '#ff2a6d',
      bendSignature: [0.85, 0.15, 0.0, 0.0, 0.9, 0.0, 0.0, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'FX: VHS Sync Loss',
      role: 'fx',
      triggerMode: 'gate',
      clipId: 'clip-pm5544',
      color: '#05d5fa',
      bendSignature: [0.2, 0.92, 0.0, 0.3, 0.0, 0.85, 0.0, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'FX: Feedback Tunnel',
      role: 'fx',
      triggerMode: 'gate',
      clipId: 'clip-pm5544',
      color: '#fee440',
      bendSignature: [0.35, 0.0, 0.88, 0.0, 0.25, 0.0, 0.92, 0.0],
      speedMultiplier: 1.0,
      reverse: false
    },
    {
      name: 'FX: Datamosh Freeze',
      role: 'fx',
      triggerMode: 'gate',
      clipId: 'clip-pm5544',
      color: '#c77dff',
      bendSignature: [0.0, 0.35, 0.0, 0.88, 0.0, 0.25, 0.4, 0.95],
      speedMultiplier: 1.0,
      reverse: false
    }
  ];

  return presets.map((p, index) => ({
    index,
    label: `PAD ${index + 1}`,
    keyBinding: PAD_KEY_BINDINGS[index],
    name: p.name,
    role: p.role,
    triggerMode: p.triggerMode,
    clipId: p.clipId,
    color: p.color,
    bendSignature: [...p.bendSignature],
    speedMultiplier: p.speedMultiplier,
    reverse: p.reverse,
    quantize: false
  }));
}

export function createDemoTake(bpm = 128) {
  const beatSec = 60 / bpm; // 0.46875s at 128 BPM
  const barSec = beatSec * 4; // 1.875s
  const totalDuration = barSec * 8; // 15.0s (8 bars)

  const notes = [
    // Bar 1-2: Pad 1 (PM5544) -> Pad 3 (Horizon Grid)
    { id: 'n1', padIndex: 0, startTime: 0.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n2', padIndex: 2, startTime: barSec * 1.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    // FX Punch hits on beat 4 of bar 1 and bar 2
    { id: 'n3', padIndex: 12, startTime: beatSec * 3.0, duration: beatSec * 0.75, slipOffset: 0.0, reverse: false },
    { id: 'n4', padIndex: 13, startTime: barSec * 1.0 + beatSec * 3.0, duration: beatSec * 0.5, slipOffset: 0.0, reverse: false },
    { id: 'n5', padIndex: 13, startTime: barSec * 1.0 + beatSec * 3.5, duration: beatSec * 0.5, slipOffset: 0.0, reverse: false },

    // Bar 3-4: Pad 2 (Vector Scope) & Pad 6 (Moiré Rings)
    { id: 'n6', padIndex: 1, startTime: barSec * 2.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n7', padIndex: 5, startTime: barSec * 3.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n8', padIndex: 14, startTime: barSec * 2.5, duration: beatSec * 2.0, slipOffset: 0.0, reverse: false },
    { id: 'n9', padIndex: 15, startTime: barSec * 3.5, duration: beatSec * 2.0, slipOffset: 0.0, reverse: false },

    // Bar 5-6: Rapid VJ Cuts across Pads 7, 8, 9, 10
    { id: 'n10', padIndex: 6, startTime: barSec * 4.0, duration: beatSec * 2.0, slipOffset: 0.0, reverse: false },
    { id: 'n11', padIndex: 7, startTime: barSec * 4.5, duration: beatSec * 2.0, slipOffset: 0.0, reverse: true },
    { id: 'n12', padIndex: 8, startTime: barSec * 5.0, duration: beatSec * 2.0, slipOffset: 0.0, reverse: false },
    { id: 'n13', padIndex: 9, startTime: barSec * 5.5, duration: beatSec * 2.0, slipOffset: 0.0, reverse: false },

    // Bar 7-8: Build-up stutters + finale
    { id: 'n14', padIndex: 10, startTime: barSec * 6.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n15', padIndex: 11, startTime: barSec * 7.0, duration: barSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n16', padIndex: 12, startTime: barSec * 7.0, duration: beatSec * 0.5, slipOffset: 0.0, reverse: false },
    { id: 'n17', padIndex: 13, startTime: barSec * 7.0 + beatSec * 1.0, duration: beatSec * 0.5, slipOffset: 0.0, reverse: false },
    { id: 'n18', padIndex: 14, startTime: barSec * 7.0 + beatSec * 2.0, duration: beatSec * 1.0, slipOffset: 0.0, reverse: false },
    { id: 'n19', padIndex: 15, startTime: barSec * 7.0 + beatSec * 3.0, duration: beatSec * 1.0, slipOffset: 0.0, reverse: false }
  ];

  const automation = Array.from({ length: 8 }, (_, idx) => {
    const defVal = GLOBAL_MACROS[idx].defaultValue;
    if (idx === 0) {
      // Chroma Phase sweep
      return [
        { time: 0.0, value: 0.05 },
        { time: barSec * 2.0, value: 0.45 },
        { time: barSec * 4.0, value: 0.15 },
        { time: barSec * 6.0, value: 0.78 },
        { time: totalDuration, value: 0.1 }
      ];
    }
    if (idx === 4) {
      // Wavefolder swells
      return [
        { time: 0.0, value: 0.0 },
        { time: barSec * 1.5, value: 0.55 },
        { time: barSec * 3.0, value: 0.1 },
        { time: barSec * 5.5, value: 0.85 },
        { time: totalDuration, value: 0.2 }
      ];
    }
    if (idx === 5) {
      // Wobbulator deflection peaks on bars 3 and 7
      return [
        { time: 0.0, value: 0.0 },
        { time: barSec * 2.0, value: 0.5 },
        { time: barSec * 4.0, value: 0.05 },
        { time: barSec * 6.5, value: 0.72 },
        { time: totalDuration, value: 0.0 }
      ];
    }
    if (idx === 6) {
      // Feedback Mix builds across the phrase
      return [
        { time: 0.0, value: 0.1 },
        { time: barSec * 3.0, value: 0.45 },
        { time: barSec * 4.0, value: 0.15 },
        { time: barSec * 7.5, value: 0.82 },
        { time: totalDuration, value: 0.2 }
      ];
    }
    return [
      { time: 0.0, value: defVal },
      { time: totalDuration, value: defVal }
    ];
  });

  return {
    id: 'take-demo-1',
    name: 'Take 1 — Demo Circuit-Bend Pass (8 Bars)',
    createdAt: new Date().toISOString(),
    duration: totalDuration,
    bpm,
    notes,
    automation
  };
}

export function createDefaultProject() {
  return {
    version: 1,
    name: 'Untitled Bent Session',
    canvas: {
      presetId: '1080p',
      width: 1920,
      height: 1080,
      fps: 60,
      aspectFit: 'cover',
      crtFrameEmulation: true
    },
    audio: {
      sourceType: 'synth', // 'synth' (built-in 128 BPM electro breakbeat) or 'file'
      name: 'Built-in 128 BPM Electro Breakbeat Synth',
      filePath: null,
      bpm: 128,
      beatOffset: 0.0,
      duration: 15.0,
      quantizeGrid: '1/16' // 'bar', '1/2', '1/4', '1/8', '1/16', '1/32', 'off'
    },
    macros: GLOBAL_MACROS.map((m) => ({
      index: m.index,
      id: m.id,
      value: m.defaultValue,
      fftBand: m.index === 4 ? 'kick' : m.index === 5 ? 'sub' : 'none',
      fftAmount: m.index === 4 ? 0.3 : m.index === 5 ? 0.25 : 0.0
    })),
    clips: structuredClone(PROCEDURAL_CLIPS),
    pads: createDefaultPads(),
    takes: [createDemoTake(128)],
    activeTakeId: 'take-demo-1'
  };
}

export function validateAndNormalizeProject(raw) {
  const base = createDefaultProject();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const merged = {
    ...base,
    ...raw,
    canvas: { ...base.canvas, ...(raw.canvas || {}) },
    audio: { ...base.audio, ...(raw.audio || {}) }
  };

  if (Array.isArray(raw.macros) && raw.macros.length === 8) {
    merged.macros = base.macros.map((bm, i) => ({
      ...bm,
      ...(raw.macros[i] || {}),
      index: i
    }));
  }

  if (Array.isArray(raw.clips) && raw.clips.length > 0) {
    // Ensure built-in procedural clips are always available alongside imported file clips
    const byId = new Map();
    for (const pc of PROCEDURAL_CLIPS) {
      byId.set(pc.id, structuredClone(pc));
    }
    for (const rc of raw.clips) {
      if (rc && rc.id) {
        byId.set(rc.id, { ...byId.get(rc.id), ...rc });
      }
    }
    merged.clips = Array.from(byId.values());
  }

  if (Array.isArray(raw.pads) && raw.pads.length === 16) {
    merged.pads = base.pads.map((bp, i) => ({
      ...bp,
      ...(raw.pads[i] || {}),
      index: i,
      keyBinding: PAD_KEY_BINDINGS[i],
      bendSignature: Array.isArray(raw.pads[i]?.bendSignature) && raw.pads[i].bendSignature.length === 8
        ? raw.pads[i].bendSignature.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
        : [...bp.bendSignature]
    }));
  }

  if (Array.isArray(raw.takes) && raw.takes.length > 0) {
    const validTakes = raw.takes
      .filter((t) => t && typeof t === 'object')
      .map((t, idx) => {
        const takeDuration = Math.max(0.5, Number(t.duration) || merged.audio.duration || 15.0);
        const takeBpm = Math.max(40, Math.min(260, Number(t.bpm) || merged.audio.bpm || 128));
        const rawNotes = Array.isArray(t.notes) ? t.notes : [];
        const notes = rawNotes
          .filter((n) => n && typeof n === 'object')
          .map((n, nIdx) => ({
            id: typeof n.id === 'string' && n.id ? n.id : `take-${idx}-n${nIdx + 1}`,
            padIndex: Math.max(0, Math.min(15, Math.floor(Number(n.padIndex) || 0))),
            startTime: Math.max(0, Number(n.startTime) || 0),
            duration: Math.max(0.02, Number(n.duration) || 0.25),
            slipOffset: Math.max(0, Number(n.slipOffset) || 0),
            reverse: Boolean(n.reverse)
          }));

        const rawAuto = Array.isArray(t.automation) ? t.automation : [];
        const automation = Array.from({ length: 8 }, (_, m) => {
          const defVal = GLOBAL_MACROS[m].defaultValue;
          const lane = Array.isArray(rawAuto[m]) ? rawAuto[m] : null;
          if (!lane || lane.length === 0) {
            return [
              { time: 0.0, value: defVal },
              { time: takeDuration, value: defVal }
            ];
          }
          const cleaned = lane
            .filter((p) => p && typeof p === 'object' && Number.isFinite(Number(p.time)))
            .map((p) => ({
              time: Math.max(0, Number(p.time)),
              value: Math.max(0, Math.min(1, Number(p.value) || 0))
            }))
            .sort((a, b) => a.time - b.time);
          return cleaned.length > 0
            ? cleaned
            : [{ time: 0.0, value: defVal }, { time: takeDuration, value: defVal }];
        });

        return {
          id: typeof t.id === 'string' && t.id ? t.id : `take-${idx + 1}`,
          name: typeof t.name === 'string' && t.name ? t.name : `Take ${idx + 1}`,
          createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
          duration: takeDuration,
          bpm: takeBpm,
          notes,
          automation
        };
      });

    if (validTakes.length > 0) {
      merged.takes = validTakes;
      if (!merged.takes.some((t) => t.id === merged.activeTakeId)) {
        merged.activeTakeId = merged.takes[0].id;
      }
    }
  }

  if (raw.midiMap && typeof raw.midiMap === 'object') {
    merged.midiMap = raw.midiMap;
  }

  return merged;
}
