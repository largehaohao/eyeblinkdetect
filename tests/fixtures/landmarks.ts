// MediaPipe Face Landmarker eye indices (478-landmark model)
export const LEFT_EYE = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 };
export const RIGHT_EYE = { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 };

type Pt = { x: number; y: number; z?: number };

function landmarksAt(coords: Record<number, Pt>): Pt[] {
  const arr: Pt[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  for (const [i, p] of Object.entries(coords)) arr[Number(i)] = p;
  return arr;
}

// Open eyes: vertical distance ~0.02, horizontal ~0.05 → EAR ~0.40
export const openEye = landmarksAt({
  [LEFT_EYE.p1]: { x: 0.40, y: 0.50 },
  [LEFT_EYE.p4]: { x: 0.45, y: 0.50 },
  [LEFT_EYE.p2]: { x: 0.415, y: 0.49 },
  [LEFT_EYE.p6]: { x: 0.415, y: 0.51 },
  [LEFT_EYE.p3]: { x: 0.435, y: 0.49 },
  [LEFT_EYE.p5]: { x: 0.435, y: 0.51 },
  [RIGHT_EYE.p1]: { x: 0.55, y: 0.50 },
  [RIGHT_EYE.p4]: { x: 0.60, y: 0.50 },
  [RIGHT_EYE.p2]: { x: 0.565, y: 0.49 },
  [RIGHT_EYE.p6]: { x: 0.565, y: 0.51 },
  [RIGHT_EYE.p3]: { x: 0.585, y: 0.49 },
  [RIGHT_EYE.p5]: { x: 0.585, y: 0.51 }
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
