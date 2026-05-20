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
