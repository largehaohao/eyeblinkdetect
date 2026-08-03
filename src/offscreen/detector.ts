import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { computeEAR, calibrateThresholds } from '@/lib/ear';
import { createBlinkFSM } from '@/lib/blink-fsm';
import type { DetectorMsg, ControlMsg } from '@/lib/messages';
import { loadSettings } from '@/lib/settings';

const video = document.getElementById('video') as HTMLVideoElement;
let landmarker: FaceLandmarker | null = null;
let fsm: ReturnType<typeof createBlinkFSM> | null = null;
let stream: MediaStream | null = null;
let running = false;
let starting: Promise<void> | null = null;
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

function makeFSM(closeThresh: number, openThresh: number): ReturnType<typeof createBlinkFSM> {
  return createBlinkFSM({
    closeThresh,
    openThresh,
    faceLostMs: 1500,
    minBlinkMs: 50,
    maxBlinkMs: 500
  });
}

async function startImpl(calibrate: boolean): Promise<void> {
  if (running) return;
  calibrating = calibrate;
  calibSamples.length = 0;
  try {
    const settings = await loadSettings();
    fsm = makeFSM(settings.ear.closeThresh, settings.ear.openThresh);
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 30 } });
    video.srcObject = stream;
    await video.play();
    landmarker = landmarker ?? await initLandmarker();
    running = true;
    if (loopHandle !== null) clearInterval(loopHandle);
    loopHandle = setInterval(loop, 33);  // ~30fps; offscreen docs don't paint so rVFC never fires.
  } catch (e) {
    stop();
    send({ kind: 'error', code: 'camera', message: String(e) });
    throw e;
  }
}

async function start(calibrate: boolean = false): Promise<void> {
  if (running) return;
  if (!starting) starting = startImpl(calibrate).finally(() => { starting = null; });
  await starting;
}

function stop(): void {
  running = false;
  if (loopHandle !== null) { clearInterval(loopHandle); loopHandle = null; }
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

let loopHandle: ReturnType<typeof setInterval> | null = null;

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
    stop();
    return;
  }
  if (calibrating && face) {
    calibSamples.push(ear);
    if (calibSamples.length >= 300) {
      calibrating = false;
      const result = calibrateThresholds(calibSamples);
      if (result.ok) {
        // Apply the personalized thresholds immediately; waiting for the next
        // session would leave this run on the defaults that created the FSM.
        fsm = makeFSM(result.closeThresh, result.openThresh);
        send({ kind: 'calibration_done', closeThresh: result.closeThresh, openThresh: result.openThresh });
        return;
      } else {
        send({ kind: 'calibration_failed', reason: result.reason });
      }
    }
  }
  const events = fsm!.feed(Date.now(), ear, face);
  for (const ev of events) {
    if (ev.type === 'blink') send({ kind: 'blink', t: ev.t });
    else if (ev.type === 'face_lost') send({ kind: 'face_lost', t: ev.t });
    else if (ev.type === 'face_present') send({ kind: 'face_present', t: ev.t });
  }
}

let controlQueue: Promise<void> = Promise.resolve();

chrome.runtime.onMessage.addListener((msg: { from: string; payload: ControlMsg }, _sender, sendResponse) => {
  if (msg.from !== 'sw') return;
  const operation = async (): Promise<void> => {
    if (msg.payload.kind === 'start') await start();
    else if (msg.payload.kind === 'stop') stop();
    else if (msg.payload.kind === 'recalibrate') { stop(); await start(true); }
  };
  const result = controlQueue.then(operation, operation);
  controlQueue = result.then(() => undefined, () => undefined);
  result.then(
    () => sendResponse({ ok: true }),
    error => sendResponse({ ok: false, error: String(error) })
  );
  return true;
});

// Liveness ping only. Must not be a face_present event — that would feed a
// fabricated presence transition into the aggregator and skew faceVisibleMs.
send({ kind: 'ready' });
