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
