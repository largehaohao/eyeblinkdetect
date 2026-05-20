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
let calibrating = false;
const calibSamples: number[] = [];

async function initLandmarker(): Promise<FaceLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL('mediapipe-wasm')
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

async function start(calibrate: boolean = false): Promise<void> {
  if (running) return;
  calibrating = calibrate;
  calibSamples.length = 0;
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
  if (calibrating && face) {
    calibSamples.push(ear);
    if (calibSamples.length >= 300) {
      const sorted = [...calibSamples].sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)]!;
      const openThresh = p75 * 0.8;
      const closeThresh = openThresh * 0.8;
      calibrating = false;
      send({ kind: 'calibration_done', closeThresh, openThresh });
    }
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
  else if (msg.payload.kind === 'recalibrate') { stop(); start(true); }
});

send({ kind: 'face_present', t: Date.now() }); // signal offscreen is alive; SW will overwrite state
