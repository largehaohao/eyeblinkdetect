import type { BlinkRow } from './db';

export type RawBlinkSoundState = {
  initialized: boolean;
  lastSeenBlinkAt: number | null;
};

export function nextRawBlinkSoundState(
  blinks: BlinkRow[],
  state: RawBlinkSoundState,
  muted: boolean
): { play: boolean; state: RawBlinkSoundState } {
  const latest = blinks.length > 0 ? blinks[blinks.length - 1]!.t : state.lastSeenBlinkAt;
  const nextState = { initialized: true, lastSeenBlinkAt: latest };
  if (!state.initialized || latest === null) return { play: false, state: nextState };
  return { play: !muted && latest > (state.lastSeenBlinkAt ?? 0), state: nextState };
}
