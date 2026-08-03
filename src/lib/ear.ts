export type Landmark = { x: number; y: number; z?: number };

export type EyeIndices = { p1: number; p2: number; p3: number; p4: number; p5: number; p6: number };

export const EAR_INDICES: { left: EyeIndices; right: EyeIndices } = {
  left: { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 },
  right: { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 }
};

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function singleEyeEAR(lms: Landmark[], idx: EyeIndices): number {
  const p1 = lms[idx.p1], p2 = lms[idx.p2], p3 = lms[idx.p3];
  const p4 = lms[idx.p4], p5 = lms[idx.p5], p6 = lms[idx.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) {
    throw new Error('EAR: missing eye landmark');
  }
  const horizontal = dist(p1, p4);
  if (horizontal === 0) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

/** Plausible range for a personalized open-eye EAR threshold. */
export const OPEN_THRESH_BOUNDS = { min: 0.15, max: 0.45 } as const;

export type CalibrationResult =
  | { ok: true; closeThresh: number; openThresh: number }
  | { ok: false; reason: string };

/**
 * Derives EAR thresholds from calibration samples. Rejects implausible results —
 * e.g. the user sat with eyes closed or at an extreme angle — so a bad
 * calibration cannot permanently disable blink detection.
 */
export function calibrateThresholds(samples: number[]): CalibrationResult {
  const usable = samples.filter(s => Number.isFinite(s) && s > 0);
  if (usable.length < 30) {
    return { ok: false, reason: 'not enough usable samples' };
  }
  const sorted = [...usable].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)]!;
  const openThresh = p75 * 0.8;
  if (openThresh < OPEN_THRESH_BOUNDS.min || openThresh > OPEN_THRESH_BOUNDS.max) {
    return { ok: false, reason: `derived openThresh ${openThresh.toFixed(3)} out of plausible range` };
  }
  return { ok: true, openThresh, closeThresh: openThresh * 0.8 };
}

export function computeEAR(landmarks: Landmark[]): number {
  if (landmarks.length < 478) throw new Error('EAR: expected 478 landmarks');
  const left = singleEyeEAR(landmarks, EAR_INDICES.left);
  const right = singleEyeEAR(landmarks, EAR_INDICES.right);
  return (left + right) / 2;
}
