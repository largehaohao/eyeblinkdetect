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
