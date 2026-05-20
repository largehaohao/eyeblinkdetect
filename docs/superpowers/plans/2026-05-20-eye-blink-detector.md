# Eye Blink Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that detects blink rate via the webcam using MediaPipe Face Landmarker, stores per-minute aggregates locally in IndexedDB, visualizes long-term trends in a dashboard, and reminds the user when blink frequency falls below a threshold.

**Architecture:** MV3 service worker for state + aggregation + alarms; offscreen document for `getUserMedia` + MediaPipe inference (because SW has no DOM); popup + dashboard pages for UI; optional content script for fullscreen overlay reminders. All pure logic (EAR, blink FSM, aggregator, reminder policy) lives in `src/lib/` as side-effect-free TypeScript and is fully unit-tested with Vitest before any wiring.

**Tech Stack:** TypeScript, Vite (CRX builder), Vitest, `@mediapipe/tasks-vision` (local wasm + `.task` model bundled), `idb` (IndexedDB wrapper), Chart.js.

**Reference spec:** `docs/superpowers/specs/2026-05-20-eye-blink-detector-design.md`

---

## File Map

Files to create, grouped by responsibility:

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts` | Toolchain |
| `manifest.json` | MV3 declaration |
| `src/lib/ear.ts` | Landmarks → EAR (pure) |
| `src/lib/blink-fsm.ts` | EAR stream → blink events (pure FSM) |
| `src/lib/aggregator.ts` | Event stream + clock → per-minute buckets (pure) |
| `src/lib/reminder-policy.ts` | Minute buckets → reminder triggers (pure) |
| `src/lib/messages.ts` | Type-safe message protocol |
| `src/lib/db.ts` | IndexedDB schema + accessor functions |
| `src/lib/settings.ts` | Settings load/save + defaults |
| `src/background/service-worker.ts` | State machine, alarms, persistence, reminder dispatch |
| `src/offscreen/offscreen.html` + `detector.ts` | Camera + MediaPipe + EAR + blink FSM wiring |
| `src/popup/popup.html` + `popup.ts` + `popup.css` | On/off, current BPM, last-hour mini-chart |
| `src/dashboard/dashboard.html` + `dashboard.ts` + `dashboard.css` | Multi-day charts, export, settings |
| `src/content/overlay.ts` | Fullscreen overlay (injected on demand) |
| `src/models/face_landmarker.task` | Bundled MediaPipe model file |
| `src/icons/*.png` | Extension icons (16/32/48/128) |
| `tests/lib/*.test.ts` | Unit tests for the four pure modules |
| `tests/fixtures/landmarks.json` | Hand-crafted landmark fixtures (open / closed / half / side) |

Tasks 1-8 build the pure-logic core test-first. Tasks 9-15 wire those into a working extension. Task 16 polishes UX. Task 17 is acceptance.

---

## Task 1: Toolchain Bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Initialize npm and install deps**

Run:
```bash
cd /Users/zhanghao/eyeblinkdetect
npm init -y
npm install --save-dev typescript vite vitest @types/chrome @types/node @crxjs/vite-plugin
npm install @mediapipe/tasks-vision idb chart.js
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["chrome", "node", "vitest/globals"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests", "manifest.json"]
}
```

- [ ] **Step 3: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: { alias: { '@': '/src' } },
  build: { target: 'esnext', sourcemap: true }
});
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts']
  },
  resolve: { alias: { '@': '/src' } }
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.DS_Store
*.log
```

- [ ] **Step 6: Add `scripts` in `package.json`**

Edit `package.json`, replace the `scripts` block with:
```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 7: Verify build pipeline**

Run: `npx tsc --noEmit`
Expected: passes (no source files yet, so just verifies tsconfig).

Run: `npm test`
Expected: `No test files found, exiting with code 1` — that is fine for now.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts .gitignore
git commit -m "chore: toolchain bootstrap (vite + vitest + typescript + crxjs)"
```

---

## Task 2: EAR Pure Function

EAR (Eye Aspect Ratio) is the standard blink metric: `EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)` per eye, then averaged across both eyes. MediaPipe Face Landmarker returns 478 landmarks; eye keypoints are at well-known indices.

**Files:**
- Create: `src/lib/ear.ts`
- Create: `tests/lib/ear.test.ts`
- Create: `tests/fixtures/landmarks.ts`

- [ ] **Step 1: Write the fixture file**

`tests/fixtures/landmarks.ts`:
```ts
// MediaPipe Face Landmarker eye indices (478-landmark model)
export const LEFT_EYE = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 };
export const RIGHT_EYE = { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 };

type Pt = { x: number; y: number; z?: number };

function landmarksAt(coords: Record<number, Pt>): Pt[] {
  const arr: Pt[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  for (const [i, p] of Object.entries(coords)) arr[Number(i)] = p;
  return arr;
}

// Open eyes: vertical distance ~0.04, horizontal ~0.05 → EAR ~0.40
export const openEye = landmarksAt({
  [LEFT_EYE.p1]: { x: 0.40, y: 0.50 },
  [LEFT_EYE.p4]: { x: 0.45, y: 0.50 },
  [LEFT_EYE.p2]: { x: 0.415, y: 0.48 },
  [LEFT_EYE.p6]: { x: 0.415, y: 0.52 },
  [LEFT_EYE.p3]: { x: 0.435, y: 0.48 },
  [LEFT_EYE.p5]: { x: 0.435, y: 0.52 },
  [RIGHT_EYE.p1]: { x: 0.55, y: 0.50 },
  [RIGHT_EYE.p4]: { x: 0.60, y: 0.50 },
  [RIGHT_EYE.p2]: { x: 0.565, y: 0.48 },
  [RIGHT_EYE.p6]: { x: 0.565, y: 0.52 },
  [RIGHT_EYE.p3]: { x: 0.585, y: 0.48 },
  [RIGHT_EYE.p5]: { x: 0.585, y: 0.52 }
});

// Closed eyes: vertical distance ~0.005, horizontal ~0.05 → EAR ~0.10
export const closedEye = landmarksAt({
  [LEFT_EYE.p1]: { x: 0.40, y: 0.50 },
  [LEFT_EYE.p4]: { x: 0.45, y: 0.50 },
  [LEFT_EYE.p2]: { x: 0.415, y: 0.4975 },
  [LEFT_EYE.p6]: { x: 0.415, y: 0.5025 },
  [LEFT_EYE.p3]: { x: 0.435, y: 0.4975 },
  [LEFT_EYE.p5]: { x: 0.435, y: 0.5025 },
  [RIGHT_EYE.p1]: { x: 0.55, y: 0.50 },
  [RIGHT_EYE.p4]: { x: 0.60, y: 0.50 },
  [RIGHT_EYE.p2]: { x: 0.565, y: 0.4975 },
  [RIGHT_EYE.p6]: { x: 0.565, y: 0.5025 },
  [RIGHT_EYE.p3]: { x: 0.585, y: 0.4975 },
  [RIGHT_EYE.p5]: { x: 0.585, y: 0.5025 }
});

// Empty (no eye landmarks at all) for sanity
export const noEye = landmarksAt({});
```

- [ ] **Step 2: Write the failing tests**

`tests/lib/ear.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeEAR, EAR_INDICES } from '../../src/lib/ear';
import { openEye, closedEye } from '../fixtures/landmarks';

describe('computeEAR', () => {
  it('returns ~0.4 for open eyes', () => {
    const ear = computeEAR(openEye);
    expect(ear).toBeGreaterThan(0.35);
    expect(ear).toBeLessThan(0.45);
  });

  it('returns < 0.15 for closed eyes', () => {
    const ear = computeEAR(closedEye);
    expect(ear).toBeLessThan(0.15);
  });

  it('exposes the eye landmark indices it uses', () => {
    expect(EAR_INDICES.left.p1).toBe(33);
    expect(EAR_INDICES.right.p1).toBe(362);
  });

  it('throws on empty landmark array', () => {
    expect(() => computeEAR([])).toThrow();
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL (module `../../src/lib/ear` not found).

- [ ] **Step 4: Implement `src/lib/ear.ts`**

```ts
export type Landmark = { x: number; y: number; z?: number };

export const EAR_INDICES = {
  left: { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 },
  right: { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 }
} as const;

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function singleEyeEAR(lms: Landmark[], idx: typeof EAR_INDICES.left): number {
  const p1 = lms[idx.p1], p2 = lms[idx.p2], p3 = lms[idx.p3];
  const p4 = lms[idx.p4], p5 = lms[idx.p5], p6 = lms[idx.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) {
    throw new Error('EAR: missing eye landmark');
  }
  const horizontal = dist(p1, p4);
  if (horizontal === 0) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

export function computeEAR(landmarks: Landmark[]): number {
  if (landmarks.length < 478) throw new Error('EAR: expected 478 landmarks');
  const left = singleEyeEAR(landmarks, EAR_INDICES.left);
  const right = singleEyeEAR(landmarks, EAR_INDICES.right);
  return (left + right) / 2;
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npm test`
Expected: PASS, 4/4.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ear.ts tests/lib/ear.test.ts tests/fixtures/landmarks.ts
git commit -m "feat(lib): EAR computation from face landmarks"
```

---

## Task 3: Blink FSM Pure Function

State machine that consumes a stream of `(timestamp, ear, faceDetected)` tuples and emits `blink`, `face_lost`, `face_present` events.

**States:** `OPEN`, `CLOSING`, `ABSENT`

**Transitions:**
- `OPEN` + ear < closeThresh for ≥ 2 consecutive frames → `CLOSING` (record closeStartT)
- `CLOSING` + ear > openThresh → `OPEN`, emit `blink` IF `(now - closeStartT)` ∈ [50ms, 500ms]; longer is "long eye closure" (drowsy/manual close), not a blink
- any state + `faceDetected=false` for ≥ 1500ms → `ABSENT`, emit `face_lost`
- `ABSENT` + `faceDetected=true` → `OPEN`, emit `face_present`

**Files:**
- Create: `src/lib/blink-fsm.ts`
- Create: `tests/lib/blink-fsm.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/lib/blink-fsm.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createBlinkFSM, type FSMEvent } from '../../src/lib/blink-fsm';

const CFG = { closeThresh: 0.20, openThresh: 0.25, faceLostMs: 1500, minBlinkMs: 50, maxBlinkMs: 500 };

function collect(events: Array<{ t: number; ear: number; face: boolean }>): FSMEvent[] {
  const fsm = createBlinkFSM(CFG);
  const out: FSMEvent[] = [];
  for (const e of events) {
    const ev = fsm.feed(e.t, e.ear, e.face);
    out.push(...ev);
  }
  return out;
}

describe('blink FSM', () => {
  it('emits one blink for a normal close→open cycle', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 33, ear: 0.40, face: true },
      { t: 66, ear: 0.15, face: true },
      { t: 99, ear: 0.14, face: true },
      { t: 200, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'blink')).toHaveLength(1);
    expect(out.find(e => e.type === 'blink')!.t).toBe(200);
  });

  it('does not emit blink if eyes closed too briefly (chatter)', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 33, ear: 0.15, face: true },  // only 1 frame below
      { t: 66, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'blink')).toHaveLength(0);
  });

  it('does not emit blink for long eye closure (drowsy/manual)', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 33, ear: 0.15, face: true },
      { t: 66, ear: 0.14, face: true },
      { t: 1000, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'blink')).toHaveLength(0);
  });

  it('emits face_lost after 1500ms of no face', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 100, ear: 0, face: false },
      { t: 1700, ear: 0, face: false }
    ]);
    expect(out.filter(e => e.type === 'face_lost')).toHaveLength(1);
  });

  it('does not emit face_lost on transient miss (< 1500ms)', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 100, ear: 0, face: false },
      { t: 1000, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'face_lost')).toHaveLength(0);
  });

  it('emits face_present after recovery from absent', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 100, ear: 0, face: false },
      { t: 1700, ear: 0, face: false },
      { t: 2000, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'face_present')).toHaveLength(1);
  });

  it('counts multiple distinct blinks', () => {
    const out = collect([
      { t: 0, ear: 0.40, face: true },
      { t: 33, ear: 0.15, face: true },
      { t: 66, ear: 0.14, face: true },
      { t: 200, ear: 0.40, face: true },
      { t: 500, ear: 0.40, face: true },
      { t: 533, ear: 0.15, face: true },
      { t: 566, ear: 0.14, face: true },
      { t: 700, ear: 0.40, face: true }
    ]);
    expect(out.filter(e => e.type === 'blink')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/blink-fsm.ts`**

```ts
export type FSMConfig = {
  closeThresh: number;
  openThresh: number;
  faceLostMs: number;
  minBlinkMs: number;
  maxBlinkMs: number;
};

export type FSMEvent =
  | { type: 'blink'; t: number }
  | { type: 'face_lost'; t: number }
  | { type: 'face_present'; t: number };

type State = 'OPEN' | 'CLOSING' | 'ABSENT';

export function createBlinkFSM(cfg: FSMConfig) {
  let state: State = 'OPEN';
  let belowFrames = 0;
  let closeStartT = 0;
  let lastFaceT: number | null = null;

  function feed(t: number, ear: number, face: boolean): FSMEvent[] {
    const out: FSMEvent[] = [];

    if (!face) {
      if (lastFaceT === null) lastFaceT = t;
      if (state !== 'ABSENT' && t - lastFaceT >= cfg.faceLostMs) {
        state = 'ABSENT';
        belowFrames = 0;
        out.push({ type: 'face_lost', t });
      }
      return out;
    }

    // face present
    if (state === 'ABSENT') {
      state = 'OPEN';
      belowFrames = 0;
      out.push({ type: 'face_present', t });
    }
    lastFaceT = t;

    if (state === 'OPEN') {
      if (ear < cfg.closeThresh) {
        belowFrames += 1;
        if (belowFrames >= 2) {
          state = 'CLOSING';
          closeStartT = t;
        }
      } else {
        belowFrames = 0;
      }
    } else if (state === 'CLOSING') {
      if (ear > cfg.openThresh) {
        const dur = t - closeStartT;
        if (dur >= cfg.minBlinkMs && dur <= cfg.maxBlinkMs) {
          out.push({ type: 'blink', t });
        }
        state = 'OPEN';
        belowFrames = 0;
      }
    }

    return out;
  }

  return { feed };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: PASS, all blink FSM tests + earlier EAR tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blink-fsm.ts tests/lib/blink-fsm.test.ts
git commit -m "feat(lib): blink state machine with face-presence tracking"
```

---

## Task 4: Aggregator (Ring Buffer + Per-Minute Buckets)

Consumes FSM events + a clock and produces, on `tick(minuteEnd)`, a `MinuteBucket` summary.

**Files:**
- Create: `src/lib/aggregator.ts`
- Create: `tests/lib/aggregator.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/lib/aggregator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createAggregator } from '../../src/lib/aggregator';

const MIN = 60_000;

describe('aggregator', () => {
  it('counts blinks within the minute', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'blink', t: 100 });
    agg.onEvent({ type: 'blink', t: 200 });
    agg.onEvent({ type: 'blink', t: 30_000 });
    const b = agg.flush(0, MIN);
    expect(b.blinks).toBe(3);
  });

  it('excludes blinks outside the minute window', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'blink', t: 100 });          // in
    agg.onEvent({ type: 'blink', t: 70_000 });       // out
    const b = agg.flush(0, MIN);
    expect(b.blinks).toBe(1);
  });

  it('reports full face-visible time when face never lost', () => {
    const agg = createAggregator();
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(MIN);
  });

  it('subtracts face-lost intervals from faceVisibleMs', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 10_000 });
    agg.onEvent({ type: 'face_present', t: 40_000 });
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(MIN - 30_000);
  });

  it('handles face_lost crossing the minute boundary', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 50_000 });
    // no face_present in this minute → absent until minute end
    const b = agg.flush(0, MIN);
    expect(b.faceVisibleMs).toBe(50_000);
    // next minute starts in ABSENT state
    const b2 = agg.flush(MIN, 2 * MIN);
    expect(b2.faceVisibleMs).toBe(0);
  });

  it('handles face_lost in previous minute, recovered in current', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 50_000 });
    const b1 = agg.flush(0, MIN);
    expect(b1.faceVisibleMs).toBe(50_000);
    agg.onEvent({ type: 'face_present', t: MIN + 20_000 });
    const b2 = agg.flush(MIN, 2 * MIN);
    expect(b2.faceVisibleMs).toBe(MIN - 20_000);
  });

  it('marks status=insufficient when faceVisibleMs < 30s', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 5_000 });
    const b = agg.flush(0, MIN);
    expect(b.status).toBe('insufficient');
  });

  it('marks status=ok when faceVisibleMs >= 30s', () => {
    const agg = createAggregator();
    agg.onEvent({ type: 'face_lost', t: 35_000 });
    const b = agg.flush(0, MIN);
    expect(b.status).toBe('ok');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/aggregator.ts`**

```ts
import type { FSMEvent } from './blink-fsm';

export type MinuteBucket = {
  blinks: number;
  faceVisibleMs: number;
  status: 'ok' | 'insufficient';
};

type FaceEvent = { type: 'face_lost' | 'face_present'; t: number };

export function createAggregator() {
  const blinkTimes: number[] = [];
  const faceEvents: FaceEvent[] = [];
  // Track state crossing minute boundaries: if last face state was lost, the next minute starts absent.
  let presentAtFlush = true;

  function onEvent(ev: FSMEvent) {
    if (ev.type === 'blink') {
      blinkTimes.push(ev.t);
    } else {
      faceEvents.push({ type: ev.type, t: ev.t });
    }
  }

  function flush(startMs: number, endMs: number): MinuteBucket {
    const blinks = blinkTimes.filter(t => t >= startMs && t < endMs).length;

    // Replay face events within window to compute absent intervals.
    let present = presentAtFlush;
    let absentMs = 0;
    let lastT = startMs;

    const inWindow = faceEvents.filter(e => e.t >= startMs && e.t < endMs);
    for (const ev of inWindow) {
      if (!present) absentMs += ev.t - lastT;
      present = (ev.type === 'face_present');
      lastT = ev.t;
    }
    if (!present) absentMs += endMs - lastT;

    presentAtFlush = present;

    // Drop history older than the window we just flushed to keep memory bounded.
    while (blinkTimes.length && blinkTimes[0]! < endMs) blinkTimes.shift();
    while (faceEvents.length && faceEvents[0]!.t < endMs) faceEvents.shift();

    const faceVisibleMs = (endMs - startMs) - absentMs;
    return {
      blinks,
      faceVisibleMs,
      status: faceVisibleMs >= 30_000 ? 'ok' : 'insufficient'
    };
  }

  return { onEvent, flush };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: PASS for all aggregator + previous tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/aggregator.ts tests/lib/aggregator.test.ts
git commit -m "feat(lib): per-minute aggregator with face-visible time tracking"
```

---

## Task 5: Reminder Policy (Sliding Window + Cooldown)

Decides when to trigger a low-frequency reminder. Inputs: a deque of recent `MinuteBucket`s + config + last-reminder timestamp.

**Files:**
- Create: `src/lib/reminder-policy.ts`
- Create: `tests/lib/reminder-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/lib/reminder-policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { shouldRemind } from '../../src/lib/reminder-policy';
import type { MinuteBucket } from '../../src/lib/aggregator';

const CFG = {
  lowBpm: 10,
  windowMinutes: 5,
  sustainMinutes: 3,
  cooldownMs: 5 * 60_000
};

function bucket(blinks: number, faceMs = 60_000): MinuteBucket {
  return { blinks, faceVisibleMs: faceMs, status: faceMs >= 30_000 ? 'ok' : 'insufficient' };
}

describe('shouldRemind', () => {
  it('returns false if not enough data', () => {
    const buckets = [bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });

  it('fires when window avg < threshold and sustained >= sustainMinutes', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(true);
  });

  it('does not fire if recent minute is above threshold (not sustained)', () => {
    const buckets = [bucket(5), bucket(5), bucket(20), bucket(5), bucket(5)];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });

  it('respects cooldown window', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    const lastFiredAt = 100_000;
    const now = lastFiredAt + 60_000;  // 1 min later, cooldown 5 min
    expect(shouldRemind(buckets, lastFiredAt, CFG, now)).toBe(false);
  });

  it('fires again after cooldown', () => {
    const buckets = [bucket(5), bucket(5), bucket(5), bucket(5), bucket(5)];
    const lastFiredAt = 100_000;
    const now = lastFiredAt + 6 * 60_000;
    expect(shouldRemind(buckets, lastFiredAt, CFG, now)).toBe(true);
  });

  it('ignores insufficient minutes in the window', () => {
    // 3 ok minutes with blinks=5, 2 insufficient → average across only ok = 5 → low
    const buckets = [
      bucket(5),
      bucket(5),
      bucket(5),
      bucket(0, 10_000),
      bucket(0, 10_000)
    ];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(true);
  });

  it('does not fire if all minutes in window are insufficient', () => {
    const buckets = [
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000),
      bucket(0, 10_000)
    ];
    expect(shouldRemind(buckets, 0, CFG, 100_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/reminder-policy.ts`**

```ts
import type { MinuteBucket } from './aggregator';

export type ReminderConfig = {
  lowBpm: number;
  windowMinutes: number;
  sustainMinutes: number;
  cooldownMs: number;
};

function windowAvgBpm(buckets: MinuteBucket[]): number | null {
  const ok = buckets.filter(b => b.status === 'ok');
  if (ok.length === 0) return null;
  const totalBlinks = ok.reduce((s, b) => s + b.blinks, 0);
  const totalMs = ok.reduce((s, b) => s + b.faceVisibleMs, 0);
  if (totalMs === 0) return null;
  return totalBlinks / (totalMs / 60_000);
}

export function shouldRemind(
  buckets: MinuteBucket[],
  lastFiredAt: number,
  cfg: ReminderConfig,
  nowMs: number
): boolean {
  if (buckets.length < cfg.windowMinutes) return false;
  if (nowMs - lastFiredAt < cfg.cooldownMs) return false;

  const window = buckets.slice(-cfg.windowMinutes);
  const avg = windowAvgBpm(window);
  if (avg === null) return false;
  if (avg >= cfg.lowBpm) return false;

  const sustainSlice = buckets.slice(-cfg.sustainMinutes);
  if (sustainSlice.length < cfg.sustainMinutes) return false;
  for (const b of sustainSlice) {
    if (b.status !== 'ok') return false;
    const minuteBpm = b.blinks / (b.faceVisibleMs / 60_000);
    if (minuteBpm >= cfg.lowBpm) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminder-policy.ts tests/lib/reminder-policy.test.ts
git commit -m "feat(lib): reminder policy with sustain check and cooldown"
```

---

## Task 6: Messages Protocol

Type-safe contract between offscreen ↔ service worker ↔ popup/dashboard.

**Files:**
- Create: `src/lib/messages.ts`

- [ ] **Step 1: Write `src/lib/messages.ts`**

```ts
export type DetectorMsg =
  | { kind: 'blink'; t: number }
  | { kind: 'face_lost'; t: number }
  | { kind: 'face_present'; t: number }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'calibration_done'; closeThresh: number; openThresh: number };

export type ControlMsg =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'recalibrate' };

export type UIQuery =
  | { kind: 'status' }
  | { kind: 'recent_minutes'; sinceMs: number }
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'settings_get' }
  | { kind: 'settings_set'; patch: Record<string, unknown> }
  | { kind: 'toggle'; on: boolean };

export type UIEvent =
  | { kind: 'state_changed'; state: 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT' }
  | { kind: 'minute_committed'; tsMinute: number };

export const MSG_PORT = 'eye-blink-detect';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/messages.ts
git commit -m "feat(lib): type-safe message protocol"
```

---

## Task 7: IndexedDB Layer

**Files:**
- Create: `src/lib/db.ts`
- Create: `tests/lib/db.test.ts`

- [ ] **Step 1: Install fake-indexeddb for Node tests**

Run: `npm install --save-dev fake-indexeddb`

- [ ] **Step 2: Update `vitest.config.ts` to load fake-indexeddb**

Replace the file with:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/idb.ts'],
    include: ['tests/**/*.test.ts']
  },
  resolve: { alias: { '@': '/src' } }
});
```

Create `tests/setup/idb.ts`:
```ts
import 'fake-indexeddb/auto';
```

- [ ] **Step 3: Write failing DB tests**

`tests/lib/db.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB, writeMinute, getRange, listAll, clearAll } from '../../src/lib/db';

describe('db', () => {
  beforeEach(async () => {
    await openDB();
    await clearAll();
  });

  it('round-trips a minute bucket', async () => {
    await writeMinute({
      tsMinute: 1_700_000_000_000,
      blinks: 12,
      faceVisibleMs: 60_000,
      status: 'ok',
      sessionId: 's1'
    });
    const got = await getRange(1_700_000_000_000, 1_700_000_000_001);
    expect(got).toHaveLength(1);
    expect(got[0]!.blinks).toBe(12);
  });

  it('returns rows in tsMinute order', async () => {
    await writeMinute({ tsMinute: 200, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    await writeMinute({ tsMinute: 100, blinks: 2, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    const got = await getRange(0, 1000);
    expect(got.map(r => r.tsMinute)).toEqual([100, 200]);
  });

  it('listAll returns everything ordered', async () => {
    await writeMinute({ tsMinute: 1, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    await writeMinute({ tsMinute: 2, blinks: 1, faceVisibleMs: 60_000, status: 'ok', sessionId: 's' });
    const all = await listAll();
    expect(all).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `src/lib/db.ts`**

```ts
import { openDB as idbOpen, type IDBPDatabase } from 'idb';

export type MinuteRow = {
  tsMinute: number;
  blinks: number;
  faceVisibleMs: number;
  status: 'ok' | 'insufficient';
  sessionId: string;
};

export type SessionRow = {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  reason: 'manual' | 'idle' | 'error';
};

const DB_NAME = 'eye-blink-detect';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function openDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = idbOpen(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('minutes')) {
          db.createObjectStore('minutes', { keyPath: 'tsMinute' });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      }
    });
  }
  return dbPromise;
}

export async function writeMinute(row: MinuteRow): Promise<void> {
  const db = await openDB();
  await db.put('minutes', row);
}

export async function getRange(fromMs: number, toMs: number): Promise<MinuteRow[]> {
  const db = await openDB();
  const range = IDBKeyRange.bound(fromMs, toMs, false, true);
  const rows = await db.getAll('minutes', range);
  return rows.sort((a, b) => a.tsMinute - b.tsMinute);
}

export async function listAll(): Promise<MinuteRow[]> {
  const db = await openDB();
  const rows = await db.getAll('minutes');
  return rows.sort((a, b) => a.tsMinute - b.tsMinute);
}

export async function writeSession(row: SessionRow): Promise<void> {
  const db = await openDB();
  await db.put('sessions', row);
}

export async function readSetting<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return db.get('settings', key);
}

export async function writeSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  await db.put('settings', value, key);
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  await Promise.all([
    db.clear('minutes'),
    db.clear('sessions'),
    db.clear('settings')
  ]);
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db.ts tests/lib/db.test.ts tests/setup/idb.ts vitest.config.ts package.json package-lock.json
git commit -m "feat(lib): IndexedDB storage layer (minutes/sessions/settings)"
```

---

## Task 8: Settings Defaults

**Files:**
- Create: `src/lib/settings.ts`
- Create: `tests/lib/settings.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/lib/settings.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, DEFAULTS } from '../../src/lib/settings';
import { clearAll, openDB } from '../../src/lib/db';

describe('settings', () => {
  beforeEach(async () => { await openDB(); await clearAll(); });

  it('returns defaults on first load', async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULTS);
  });

  it('persists overrides and merges with defaults', async () => {
    await saveSettings({ threshold: { lowBpm: 8, windowMinutes: 5, sustainMinutes: 3 } });
    const s = await loadSettings();
    expect(s.threshold.lowBpm).toBe(8);
    expect(s.cooldownMinutes).toBe(DEFAULTS.cooldownMinutes);
  });
});
```

- [ ] **Step 2: Implement `src/lib/settings.ts`**

```ts
import { readSetting, writeSetting } from './db';

export type Settings = {
  threshold: { lowBpm: number; windowMinutes: number; sustainMinutes: number };
  cooldownMinutes: number;
  reminderModes: { systemNotification: boolean; fullscreenOverlay: boolean };
  ear: { closeThresh: number; openThresh: number; personalized: boolean };
};

export const DEFAULTS: Settings = {
  threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
  cooldownMinutes: 5,
  reminderModes: { systemNotification: true, fullscreenOverlay: false },
  ear: { closeThresh: 0.20, openThresh: 0.25, personalized: false }
};

const KEY = 'settings.v1';

export async function loadSettings(): Promise<Settings> {
  const raw = await readSetting<Partial<Settings>>(KEY);
  if (!raw) return structuredClone(DEFAULTS);
  return deepMerge(structuredClone(DEFAULTS), raw);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged = deepMerge(current, patch);
  await writeSetting(KEY, merged);
  return merged;
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const out: any = Array.isArray(target) ? [...(target as any)] : { ...(target as any) };
  for (const k of Object.keys(source) as Array<keyof T>) {
    const v = (source as any)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settings.ts tests/lib/settings.test.ts
git commit -m "feat(lib): settings load/save with deep-merge defaults"
```

---

## Task 9: Manifest + Icons + Model Asset

**Files:**
- Create: `manifest.json`
- Create: `src/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` (placeholders)
- Create: `src/models/face_landmarker.task`

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Eye Blink Detector",
  "version": "0.1.0",
  "description": "Detects your blink rate via webcam and reminds you to rest your eyes when you slow down.",
  "permissions": ["storage", "alarms", "offscreen", "notifications", "idle", "scripting"],
  "host_permissions": [],
  "background": { "service_worker": "src/background/service-worker.ts", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html", "default_icon": { "16": "src/icons/icon-16.png", "32": "src/icons/icon-32.png" } },
  "icons": { "16": "src/icons/icon-16.png", "32": "src/icons/icon-32.png", "48": "src/icons/icon-48.png", "128": "src/icons/icon-128.png" },
  "web_accessible_resources": [
    { "resources": ["src/models/face_landmarker.task", "src/dashboard/dashboard.html"], "matches": ["<all_urls>"] }
  ],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" }
}
```

- [ ] **Step 2: Download MediaPipe model**

Run:
```bash
mkdir -p src/models
curl -L -o src/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
ls -lh src/models/face_landmarker.task
```
Expected: ~3 MB file.

- [ ] **Step 3: Generate placeholder icons**

Run:
```bash
mkdir -p src/icons
for size in 16 32 48 128; do
  python3 -c "
import struct, zlib
size = $size
def png(size):
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    raw = b''
    for y in range(size):
        raw += b'\x00' + bytes([0x2d, 0x6a, 0xff] * size)
    idat = zlib.compress(raw)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
open(f'src/icons/icon-$size.png', 'wb').write(png(size))
"
done
ls -lh src/icons/
```

- [ ] **Step 4: Verify build picks them up**

Run: `npm run build`
Expected: Vite produces `dist/` with `manifest.json` rewritten and all assets bundled.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/icons/ src/models/
git commit -m "feat: MV3 manifest + bundled MediaPipe model + placeholder icons"
```

---

## Task 10: Offscreen Document — Camera + MediaPipe Inference

**Files:**
- Create: `src/offscreen/offscreen.html`
- Create: `src/offscreen/detector.ts`

- [ ] **Step 1: Write `src/offscreen/offscreen.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>EBD detector</title></head>
  <body>
    <video id="video" autoplay playsinline muted style="display:none"></video>
    <canvas id="canvas" style="display:none"></canvas>
    <script type="module" src="./detector.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/offscreen/detector.ts`**

```ts
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { computeEAR } from '@/lib/ear';
import { createBlinkFSM } from '@/lib/blink-fsm';
import type { DetectorMsg, ControlMsg } from '@/lib/messages';
import { loadSettings } from '@/lib/settings';

const video = document.getElementById('video') as HTMLVideoElement;
let landmarker: FaceLandmarker | null = null;
let fsm: ReturnType<typeof createBlinkFSM> | null = null;
let stream: MediaStream | null = null;
let running = false;

async function initLandmarker(): Promise<FaceLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL('node_modules/@mediapipe/tasks-vision/wasm')
  );
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL('src/models/face_landmarker.task'),
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false
  });
}

function send(msg: DetectorMsg): void {
  chrome.runtime.sendMessage({ from: 'offscreen', payload: msg }).catch(() => {});
}

async function start(): Promise<void> {
  if (running) return;
  try {
    const settings = await loadSettings();
    fsm = createBlinkFSM({
      closeThresh: settings.ear.closeThresh,
      openThresh: settings.ear.openThresh,
      faceLostMs: 1500,
      minBlinkMs: 50,
      maxBlinkMs: 500
    });
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 30 } });
    video.srcObject = stream;
    await video.play();
    landmarker = landmarker ?? await initLandmarker();
    running = true;
    loop();
  } catch (e) {
    send({ kind: 'error', code: 'camera', message: String(e) });
  }
}

function stop(): void {
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

function loop(): void {
  if (!running || !landmarker) return;
  const t = performance.timeOrigin + performance.now();
  let face = false;
  let ear = 0;
  try {
    const result = landmarker.detectForVideo(video, t);
    if (result.faceLandmarks && result.faceLandmarks.length > 0) {
      face = true;
      ear = computeEAR(result.faceLandmarks[0] as any);
    }
  } catch (e) {
    send({ kind: 'error', code: 'inference', message: String(e) });
  }
  const events = fsm!.feed(Date.now(), ear, face);
  for (const ev of events) {
    if (ev.type === 'blink') send({ kind: 'blink', t: ev.t });
    else if (ev.type === 'face_lost') send({ kind: 'face_lost', t: ev.t });
    else if (ev.type === 'face_present') send({ kind: 'face_present', t: ev.t });
  }
  video.requestVideoFrameCallback(() => loop());
}

chrome.runtime.onMessage.addListener((msg: { from: string; payload: ControlMsg }) => {
  if (msg.from !== 'sw') return;
  if (msg.payload.kind === 'start') start();
  else if (msg.payload.kind === 'stop') stop();
});

send({ kind: 'face_present', t: Date.now() }); // signal offscreen is alive; SW will overwrite state
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/offscreen.html src/offscreen/detector.ts
git commit -m "feat(offscreen): camera + MediaPipe inference loop wired to blink FSM"
```

---

## Task 11: Service Worker — State, Aggregation, Persistence

**Files:**
- Create: `src/background/service-worker.ts`

- [ ] **Step 1: Write `src/background/service-worker.ts`**

```ts
import { createAggregator, type MinuteBucket } from '@/lib/aggregator';
import { shouldRemind } from '@/lib/reminder-policy';
import { writeMinute, getRange, writeSession } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import type { DetectorMsg, ControlMsg, UIQuery, UIEvent } from '@/lib/messages';

type AppState = 'OFF' | 'RUNNING' | 'PAUSED' | 'ABSENT';

const SESSION_KEY = 'sessionState';
const agg = createAggregator();
const recentBuckets: MinuteBucket[] = [];
let currentMinuteStart: number | null = null;
let lastReminderAt = 0;
let sessionId = '';
let state: AppState = 'OFF';

function nowMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

async function setState(s: AppState): Promise<void> {
  state = s;
  await chrome.storage.session.set({ [SESSION_KEY]: { state, sessionId, lastReminderAt } });
  await broadcast({ kind: 'state_changed', state });
  await updateBadge();
}

async function updateBadge(): Promise<void> {
  if (state === 'OFF') { chrome.action.setBadgeText({ text: '' }); return; }
  if (state === 'RUNNING') { chrome.action.setBadgeText({ text: 'ON' }); chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }); return; }
  if (state === 'PAUSED') { chrome.action.setBadgeText({ text: 'II' }); chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); return; }
  if (state === 'ABSENT') { chrome.action.setBadgeText({ text: '?' }); chrome.action.setBadgeBackgroundColor({ color: '#64748b' }); }
}

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.() ?? false;
  if (has) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Webcam-based blink detection'
  });
}

async function closeOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.() ?? false;
  if (has) await chrome.offscreen.closeDocument();
}

function postToOffscreen(payload: ControlMsg): void {
  chrome.runtime.sendMessage({ from: 'sw', payload }).catch(() => {});
}

async function broadcast(ev: UIEvent): Promise<void> {
  chrome.runtime.sendMessage({ from: 'sw_ui', payload: ev }).catch(() => {});
}

async function startSession(): Promise<void> {
  sessionId = crypto.randomUUID();
  await writeSession({ sessionId, startedAt: Date.now(), endedAt: null, reason: 'manual' });
  await ensureOffscreen();
  postToOffscreen({ kind: 'start' });
  currentMinuteStart = nowMinute();
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  await setState('RUNNING');
}

async function stopSession(reason: 'manual' | 'idle' | 'error'): Promise<void> {
  postToOffscreen({ kind: 'stop' });
  await closeOffscreen();
  if (sessionId) {
    await writeSession({ sessionId, startedAt: 0, endedAt: Date.now(), reason });
  }
  chrome.alarms.clear('tick');
  await setState('OFF');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from === 'offscreen') {
    handleDetector(msg.payload as DetectorMsg);
    return;
  }
  if (msg?.from === 'ui') {
    handleUI(msg.payload as UIQuery).then(sendResponse);
    return true;
  }
});

function handleDetector(m: DetectorMsg): void {
  if (m.kind === 'blink') agg.onEvent({ type: 'blink', t: m.t });
  else if (m.kind === 'face_lost') { agg.onEvent({ type: 'face_lost', t: m.t }); setState('ABSENT'); }
  else if (m.kind === 'face_present') { agg.onEvent({ type: 'face_present', t: m.t }); if (state === 'ABSENT') setState('RUNNING'); }
  else if (m.kind === 'error') { console.error('detector error', m); stopSession('error'); }
}

async function handleUI(q: UIQuery): Promise<unknown> {
  if (q.kind === 'status') return { state, sessionId, lastReminderAt };
  if (q.kind === 'toggle') {
    if (q.on && state === 'OFF') await startSession();
    if (!q.on && state !== 'OFF') await stopSession('manual');
    return { state };
  }
  if (q.kind === 'recent_minutes') return getRange(q.sinceMs, Date.now() + 60_000);
  if (q.kind === 'range') return getRange(q.fromMs, q.toMs);
  if (q.kind === 'settings_get') return loadSettings();
  if (q.kind === 'settings_set') {
    const { saveSettings } = await import('@/lib/settings');
    return saveSettings(q.patch as any);
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  if (state === 'OFF' || currentMinuteStart === null) return;
  const start = currentMinuteStart;
  const end = start + 60_000;
  const bucket = agg.flush(start, end);
  await writeMinute({ tsMinute: start, ...bucket, sessionId });
  recentBuckets.push(bucket);
  if (recentBuckets.length > 60) recentBuckets.shift();
  currentMinuteStart = end;
  await broadcast({ kind: 'minute_committed', tsMinute: start });

  const settings = await loadSettings();
  if (settings.reminderModes.systemNotification || settings.reminderModes.fullscreenOverlay) {
    const cfg = {
      lowBpm: settings.threshold.lowBpm,
      windowMinutes: settings.threshold.windowMinutes,
      sustainMinutes: settings.threshold.sustainMinutes,
      cooldownMs: settings.cooldownMinutes * 60_000
    };
    if (shouldRemind(recentBuckets, lastReminderAt, cfg, Date.now())) {
      await fireReminder(settings);
      lastReminderAt = Date.now();
      await chrome.storage.session.set({ [SESSION_KEY]: { state, sessionId, lastReminderAt } });
    }
  }
});

async function fireReminder(settings: Awaited<ReturnType<typeof loadSettings>>): Promise<void> {
  if (settings.reminderModes.systemNotification) {
    chrome.notifications.create('low-blink', {
      type: 'basic',
      iconUrl: 'src/icons/icon-128.png',
      title: 'Eyes need a break',
      message: 'Your blink rate has been low. Look at something 20ft away for 20 seconds.',
      priority: 2
    });
  }
  if (settings.reminderModes.fullscreenOverlay) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/overlay.ts']
        });
      } catch { /* restricted page */ }
    }
  }
}

chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === 'active' && state === 'PAUSED') {
    postToOffscreen({ kind: 'start' });
    await setState('RUNNING');
  } else if ((newState === 'idle' || newState === 'locked') && state === 'RUNNING') {
    postToOffscreen({ kind: 'stop' });
    await setState('PAUSED');
  }
});
chrome.idle.setDetectionInterval(60);

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.session.get(SESSION_KEY);
  if (data[SESSION_KEY]?.state && data[SESSION_KEY].state !== 'OFF') {
    sessionId = data[SESSION_KEY].sessionId ?? '';
    lastReminderAt = data[SESSION_KEY].lastReminderAt ?? 0;
    await startSession();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await setState('OFF');
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat(background): service worker with state, alarms, aggregation, reminders"
```

---

## Task 12: Popup

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.ts`
- Create: `src/popup/popup.css`

- [ ] **Step 1: Write `src/popup/popup.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="./popup.css">
</head>
<body>
  <header>
    <h1>Eye Blink Detector</h1>
    <button id="toggle">Start</button>
  </header>
  <section class="metric">
    <div class="big" id="bpm">—</div>
    <div class="label">blinks / min (last 5 min)</div>
    <div class="state" id="state">OFF</div>
  </section>
  <section class="chart">
    <canvas id="recent" width="280" height="80"></canvas>
  </section>
  <footer>
    <a href="../dashboard/dashboard.html" target="_blank">Open Dashboard</a>
  </footer>
  <script type="module" src="./popup.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/popup/popup.css`**

```css
body { font: 13px system-ui; width: 300px; margin: 0; padding: 12px; }
header { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 14px; margin: 0; }
button { padding: 6px 12px; cursor: pointer; }
.metric { text-align: center; padding: 16px 0; }
.big { font-size: 36px; font-weight: 600; }
.label { color: #666; font-size: 11px; }
.state { margin-top: 4px; font-size: 11px; color: #888; }
.chart { margin: 8px 0; }
footer { text-align: right; font-size: 11px; }
footer a { color: #2563eb; text-decoration: none; }
```

- [ ] **Step 3: Write `src/popup/popup.ts`**

```ts
import Chart from 'chart.js/auto';
import type { UIQuery, UIEvent } from '@/lib/messages';
import type { MinuteRow } from '@/lib/db';

function sendUI<T>(q: UIQuery): Promise<T> {
  return chrome.runtime.sendMessage({ from: 'ui', payload: q }) as Promise<T>;
}

const toggle = document.getElementById('toggle') as HTMLButtonElement;
const bpmEl = document.getElementById('bpm')!;
const stateEl = document.getElementById('state')!;
const canvas = document.getElementById('recent') as HTMLCanvasElement;

let chart: Chart | null = null;
let currentState: string = 'OFF';

async function refresh(): Promise<void> {
  const status = await sendUI<{ state: string }>({ kind: 'status' });
  currentState = status.state;
  stateEl.textContent = status.state;
  toggle.textContent = status.state === 'OFF' ? 'Start' : 'Stop';

  const since = Date.now() - 60 * 60_000;
  const rows = await sendUI<MinuteRow[]>({ kind: 'recent_minutes', sinceMs: since });

  const recent = rows.slice(-5).filter(r => r.status === 'ok');
  if (recent.length > 0) {
    const blinks = recent.reduce((s, r) => s + r.blinks, 0);
    const minutes = recent.reduce((s, r) => s + r.faceVisibleMs, 0) / 60_000;
    bpmEl.textContent = minutes > 0 ? (blinks / minutes).toFixed(1) : '—';
  } else {
    bpmEl.textContent = '—';
  }

  const labels = rows.map(r => new Date(r.tsMinute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const data = rows.map(r => r.status === 'ok' ? r.blinks / (r.faceVisibleMs / 60_000) : null);

  if (!chart) {
    chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#2563eb', tension: 0.3, pointRadius: 0 }] },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true }, x: { display: false } }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0]!.data = data as any;
    chart.update('none');
  }
}

toggle.addEventListener('click', async () => {
  const on = currentState === 'OFF';
  await sendUI({ kind: 'toggle', on });
  refresh();
});

chrome.runtime.onMessage.addListener((msg: { from: string; payload: UIEvent }) => {
  if (msg.from === 'sw_ui') refresh();
});

refresh();
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/popup/
git commit -m "feat(popup): on/off, live BPM, last-hour chart"
```

---

## Task 13: Dashboard

**Files:**
- Create: `src/dashboard/dashboard.html`
- Create: `src/dashboard/dashboard.ts`
- Create: `src/dashboard/dashboard.css`

- [ ] **Step 1: Write `src/dashboard/dashboard.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Eye Blink Dashboard</title>
  <link rel="stylesheet" href="./dashboard.css">
</head>
<body>
  <header>
    <h1>Eye Blink Dashboard</h1>
    <nav>
      <button data-range="day">Today</button>
      <button data-range="week">7 days</button>
      <button data-range="month">30 days</button>
      <button data-range="all">All</button>
    </nav>
  </header>

  <main>
    <section class="card">
      <canvas id="main-chart" width="900" height="260"></canvas>
    </section>

    <section class="card grid-3">
      <div><div class="stat-label">Avg BPM</div><div class="stat-value" id="avg">—</div></div>
      <div><div class="stat-label">Tracked time</div><div class="stat-value" id="tracked">—</div></div>
      <div><div class="stat-label">Reminders</div><div class="stat-value" id="reminders">—</div></div>
    </section>

    <section class="card">
      <h2>Settings</h2>
      <form id="settings-form">
        <label>Low-BPM threshold <input type="number" name="lowBpm" min="1" max="40"></label>
        <label>Window (minutes) <input type="number" name="windowMinutes" min="1" max="30"></label>
        <label>Sustain (minutes) <input type="number" name="sustainMinutes" min="1" max="30"></label>
        <label>Cooldown (minutes) <input type="number" name="cooldownMinutes" min="1" max="60"></label>
        <label><input type="checkbox" name="systemNotification"> System notifications</label>
        <label><input type="checkbox" name="fullscreenOverlay"> Fullscreen overlay</label>
        <button type="submit">Save</button>
      </form>
    </section>

    <section class="card">
      <h2>Export</h2>
      <button id="export-csv">Download CSV</button>
      <button id="export-json">Download JSON</button>
    </section>
  </main>

  <script type="module" src="./dashboard.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/dashboard/dashboard.css`**

```css
body { font: 14px system-ui; margin: 0; background: #f8fafc; color: #0f172a; }
header { background: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 24px; border-bottom: 1px solid #e2e8f0; }
header h1 { font-size: 18px; margin: 0; }
nav button { margin-right: 6px; padding: 4px 10px; cursor: pointer; }
nav button.active { background: #2563eb; color: #fff; border-color: #2563eb; }
main { padding: 24px; display: grid; grid-template-columns: 1fr; gap: 16px; max-width: 1024px; margin: 0 auto; }
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.stat-label { color: #64748b; font-size: 12px; }
.stat-value { font-size: 28px; font-weight: 600; }
form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
form label { display: flex; flex-direction: column; font-size: 12px; color: #475569; gap: 4px; }
form input[type="number"] { padding: 4px 8px; }
form button { grid-column: 1 / -1; padding: 8px; cursor: pointer; }
button { padding: 6px 12px; cursor: pointer; }
```

- [ ] **Step 3: Write `src/dashboard/dashboard.ts`**

```ts
import Chart from 'chart.js/auto';
import type { UIQuery } from '@/lib/messages';
import type { MinuteRow } from '@/lib/db';
import type { Settings } from '@/lib/settings';

function sendUI<T>(q: UIQuery): Promise<T> {
  return chrome.runtime.sendMessage({ from: 'ui', payload: q }) as Promise<T>;
}

const RANGES = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  all: Number.MAX_SAFE_INTEGER
} as const;

let chart: Chart | null = null;

async function loadRange(rangeKey: keyof typeof RANGES): Promise<void> {
  const fromMs = rangeKey === 'all' ? 0 : Date.now() - RANGES[rangeKey];
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs, toMs: Date.now() + 60_000 });
  render(rows);
}

function render(rows: MinuteRow[]): void {
  const labels = rows.map(r => new Date(r.tsMinute).toLocaleString());
  const bpm = rows.map(r => r.status === 'ok' ? r.blinks / (r.faceVisibleMs / 60_000) : null);

  if (!chart) {
    chart = new Chart(document.getElementById('main-chart') as HTMLCanvasElement, {
      type: 'line',
      data: { labels, datasets: [{ label: 'BPM', data: bpm, borderColor: '#2563eb', pointRadius: 0, tension: 0.2 }] },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0]!.data = bpm as any;
    chart.update('none');
  }

  const ok = rows.filter(r => r.status === 'ok');
  const totalBlinks = ok.reduce((s, r) => s + r.blinks, 0);
  const totalMin = ok.reduce((s, r) => s + r.faceVisibleMs / 60_000, 0);
  document.getElementById('avg')!.textContent = totalMin > 0 ? (totalBlinks / totalMin).toFixed(1) : '—';
  document.getElementById('tracked')!.textContent = totalMin > 60
    ? `${(totalMin / 60).toFixed(1)} h`
    : `${totalMin.toFixed(0)} min`;
  document.getElementById('reminders')!.textContent = '—';
}

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadRange((btn as HTMLElement).dataset.range as keyof typeof RANGES);
  });
});

async function loadSettingsForm(): Promise<void> {
  const s = await sendUI<Settings>({ kind: 'settings_get' });
  const f = document.getElementById('settings-form') as HTMLFormElement;
  (f.lowBpm as HTMLInputElement).value = String(s.threshold.lowBpm);
  (f.windowMinutes as HTMLInputElement).value = String(s.threshold.windowMinutes);
  (f.sustainMinutes as HTMLInputElement).value = String(s.threshold.sustainMinutes);
  (f.cooldownMinutes as HTMLInputElement).value = String(s.cooldownMinutes);
  (f.systemNotification as HTMLInputElement).checked = s.reminderModes.systemNotification;
  (f.fullscreenOverlay as HTMLInputElement).checked = s.reminderModes.fullscreenOverlay;
}

document.getElementById('settings-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  await sendUI({
    kind: 'settings_set',
    patch: {
      threshold: {
        lowBpm: Number((f.lowBpm as HTMLInputElement).value),
        windowMinutes: Number((f.windowMinutes as HTMLInputElement).value),
        sustainMinutes: Number((f.sustainMinutes as HTMLInputElement).value)
      },
      cooldownMinutes: Number((f.cooldownMinutes as HTMLInputElement).value),
      reminderModes: {
        systemNotification: (f.systemNotification as HTMLInputElement).checked,
        fullscreenOverlay: (f.fullscreenOverlay as HTMLInputElement).checked
      }
    }
  });
});

document.getElementById('export-csv')!.addEventListener('click', async () => {
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs: 0, toMs: Date.now() + 60_000 });
  const header = 'tsMinute,iso,blinks,faceVisibleMs,status,sessionId\n';
  const body = rows.map(r =>
    `${r.tsMinute},${new Date(r.tsMinute).toISOString()},${r.blinks},${r.faceVisibleMs},${r.status},${r.sessionId}`
  ).join('\n');
  downloadBlob(header + body, 'eye-blink.csv', 'text/csv');
});

document.getElementById('export-json')!.addEventListener('click', async () => {
  const rows = await sendUI<MinuteRow[]>({ kind: 'range', fromMs: 0, toMs: Date.now() + 60_000 });
  downloadBlob(JSON.stringify(rows, null, 2), 'eye-blink.json', 'application/json');
});

function downloadBlob(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

(document.querySelector('nav button[data-range="day"]') as HTMLElement).click();
loadSettingsForm();
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/
git commit -m "feat(dashboard): trend chart, settings form, CSV/JSON export"
```

---

## Task 14: Content Script Overlay

**Files:**
- Create: `src/content/overlay.ts`

- [ ] **Step 1: Write `src/content/overlay.ts`**

```ts
(function injectOverlay() {
  const ID = '__ebd_overlay__';
  if (document.getElementById(ID)) return;
  const el = document.createElement('div');
  el.id = ID;
  el.style.cssText = `
    position:fixed; inset:0; z-index:2147483647; background:rgba(15,23,42,0.85);
    color:#f8fafc; display:flex; align-items:center; justify-content:center;
    font:18px/1.5 system-ui;
  `;
  el.innerHTML = `
    <div style="background:#1e293b;padding:32px;border-radius:12px;text-align:center;max-width:480px;">
      <h2 style="margin:0 0 12px 0;">Eyes need a break</h2>
      <p>Your blink rate has been low for a few minutes.</p>
      <p>Look at something <strong>20 feet away</strong> for <strong>20 seconds</strong>.</p>
      <button id="__ebd_close" style="padding:8px 16px;cursor:pointer;font-size:16px;margin-top:12px;">Dismiss</button>
    </div>
  `;
  document.documentElement.appendChild(el);
  const closeBtn = el.querySelector('#__ebd_close') as HTMLButtonElement;
  const autoClose = setTimeout(() => el.remove(), 20_000);
  closeBtn.addEventListener('click', () => { clearTimeout(autoClose); el.remove(); });
})();
```

- [ ] **Step 2: Commit**

```bash
git add src/content/overlay.ts
git commit -m "feat(content): fullscreen overlay reminder injection"
```

---

## Task 15: Build + Load Unpacked + Smoke Test

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `dist/` populated. If it errors on the `.task` model being too large for Vite, set `build.assetsInlineLimit: 0` in `vite.config.ts` — but @crxjs handles it as a normal asset so the default should be fine.

- [ ] **Step 2: Load in Chrome**

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `dist/` folder
4. Note the extension ID; pin it to the toolbar

- [ ] **Step 3: Smoke test**

Test in order:
1. Click extension icon → popup opens, state shows OFF
2. Click "Start" → camera permission prompt → grant
3. State changes to RUNNING, badge turns green
4. Sit in front of camera for 2 minutes, blink normally
5. Open popup again → BPM shows a number, mini chart has 2 points
6. Open Dashboard → main chart shows the 2 minutes
7. Cover camera with hand → state should change to ABSENT within ~2 seconds
8. Uncover → returns to RUNNING

If any smoke test fails:
- Open `chrome://extensions` → "Inspect views: service worker" for SW logs
- Click "offscreen.html" in the same place for detector logs
- Right-click popup → Inspect

- [ ] **Step 4: Commit any fixes found during smoke test**

(No code change yet expected; this is the verification step.)

```bash
git add -A
git diff --cached --stat
```
If there are changes, commit them with descriptive messages.

---

## Task 16: Calibration Flow + Persistence Polish

Smoke test in Task 15 may reveal that personal eyes are different. Add 10s calibration on first start.

**Files:**
- Modify: `src/offscreen/detector.ts`
- Modify: `src/popup/popup.html`, `popup.ts`

- [ ] **Step 1: Add calibration mode to detector**

Edit `src/offscreen/detector.ts`. After `let running = false;` add:
```ts
let calibrating = false;
const calibSamples: number[] = [];
```

Modify the `start` function to accept a calibration flag:
```ts
async function start(calibrate: boolean = false): Promise<void> {
  if (running) return;
  calibrating = calibrate;
  calibSamples.length = 0;
  // ...rest unchanged
}
```

Inside `loop()`, before passing to FSM, if `calibrating` collect samples and after ~10s compute thresholds:
```ts
if (calibrating) {
  calibSamples.push(ear);
  if (calibSamples.length >= 300) {  // ~10s at 30fps
    const sorted = [...calibSamples].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)]!;
    const p75 = sorted[Math.floor(sorted.length * 0.75)]!;
    const openThresh = p75 * 0.8;
    const closeThresh = openThresh * 0.8;
    calibrating = false;
    send({ kind: 'calibration_done', closeThresh, openThresh });
  }
}
```

Modify the message listener:
```ts
chrome.runtime.onMessage.addListener((msg: { from: string; payload: ControlMsg }) => {
  if (msg.from !== 'sw') return;
  if (msg.payload.kind === 'start') start();
  else if (msg.payload.kind === 'stop') stop();
  else if (msg.payload.kind === 'recalibrate') { stop(); start(true); }
});
```

- [ ] **Step 2: Handle `calibration_done` in service worker**

In `src/background/service-worker.ts`, inside `handleDetector`:
```ts
else if (m.kind === 'calibration_done') {
  const { saveSettings } = await import('@/lib/settings');
  await saveSettings({
    ear: { closeThresh: m.closeThresh, openThresh: m.openThresh, personalized: true }
  });
}
```
(Make `handleDetector` async or wrap with `void (async () => { ... })()`.)

- [ ] **Step 3: Add "Calibrate" button in popup**

Add to `src/popup/popup.html` inside `<footer>`:
```html
<button id="calibrate">Calibrate</button>
```

In `src/popup/popup.ts`:
```ts
document.getElementById('calibrate')!.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ from: 'ui', payload: { kind: 'recalibrate' } });
});
```

And in service worker's `handleUI`:
```ts
if (q.kind === 'recalibrate') {
  postToOffscreen({ kind: 'recalibrate' });
  return { ok: true };
}
```
(Add `'recalibrate'` to `UIQuery` in `src/lib/messages.ts`.)

- [ ] **Step 4: Rebuild and re-test**

Run: `npm run build` and reload extension in chrome://extensions

Verify: clicking "Calibrate" with eyes naturally open for 10 seconds updates the EAR thresholds. Inspect SW console for the saveSettings result.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 10s EAR calibration with personalized thresholds"
```

---

## Task 17: Acceptance Verification

Walk through every acceptance criterion in the spec § 14.

- [ ] **Step 1: FPS check**

In offscreen DevTools, paste in console while running:
```js
let frames = 0;
const start = performance.now();
const i = setInterval(() => {
  console.log('fps:', frames / ((performance.now() - start) / 1000));
}, 5000);
// instrument loop temporarily by incrementing `frames` in detector.ts
```
Expected ≥ 15 fps. If not, lower resolution from 320x240 to 240x180 in detector.ts.

- [ ] **Step 2: CPU check**

Open Chrome Task Manager (Shift+Esc) → find the extension's GPU/process. Expected < 30% single core.

- [ ] **Step 3: Blink-count accuracy**

Sit still and count your own blinks for 1 minute while extension runs. Compare popup BPM to your count. Acceptable ≤ 15% error after calibration.

- [ ] **Step 4: Absence handling**

Walk away 30 seconds. Return. Open dashboard → check that the minute spanning your absence has reduced `faceVisibleMs`.

- [ ] **Step 5: Cooldown**

Lower threshold to 30 BPM in settings. Wait one minute. A reminder should fire. Wait 2 more minutes — no second reminder. Wait past 5 minutes — another reminder allowed.

- [ ] **Step 6: Persistence across restart**

Close Chrome entirely. Reopen. Dashboard → confirm all historical data is intact.

- [ ] **Step 7: Export verifies**

Click "Download CSV" → open in Excel/Numbers/LibreOffice. Confirm columns align, timestamps parse correctly.

- [ ] **Step 8: Mark plan complete**

Run `git log --oneline` to confirm clean history.

```bash
git log --oneline
```

If any acceptance criterion fails, file the gap as a follow-up note in the spec's "待跟进" section and decide whether to fix now or defer.

---

## Done

The extension is feature-complete per spec when Task 17 passes.
