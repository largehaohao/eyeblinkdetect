import { describe, expect, it } from 'vitest';
import { nextRawBlinkSoundState } from '../../src/lib/blink-sound';
import type { BlinkRow } from '../../src/lib/db';

const rows = (...times: number[]): BlinkRow[] => times.map(t => ({ t, sessionId: 's1' }));

describe('nextRawBlinkSoundState', () => {
  it('arms itself on initial historical rows without playing', () => {
    const result = nextRawBlinkSoundState(rows(1000, 2000), { initialized: false, lastSeenBlinkAt: null }, false);

    expect(result.play).toBe(false);
    expect(result.state).toEqual({ initialized: true, lastSeenBlinkAt: 2000 });
  });

  it('plays when a newer blink appears and sound is not muted', () => {
    const result = nextRawBlinkSoundState(rows(1000, 2000, 3000), { initialized: true, lastSeenBlinkAt: 2000 }, false);

    expect(result.play).toBe(true);
    expect(result.state).toEqual({ initialized: true, lastSeenBlinkAt: 3000 });
  });

  it('does not play while muted but still advances the seen timestamp', () => {
    const result = nextRawBlinkSoundState(rows(1000, 2000, 3000), { initialized: true, lastSeenBlinkAt: 2000 }, true);

    expect(result.play).toBe(false);
    expect(result.state).toEqual({ initialized: true, lastSeenBlinkAt: 3000 });
  });
});
