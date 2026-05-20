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
