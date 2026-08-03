# Eye Blink Detector

A Chrome extension that tracks your blink rate via webcam and reminds you to rest your eyes when you blink too infrequently while staring at the screen.

All detection runs locally in the browser. No video is uploaded, and no network requests are made for inference.

## Features

- **Real-time blink detection** — MediaPipe Face Landmarker (WASM) with Eye Aspect Ratio (EAR) on your webcam feed
- **Smart reminders** — sliding-window average BPM threshold; only fires after low blink rate is sustained for several minutes, with cooldown between reminders
- **Face-aware counting** — pauses when you leave the desk so absence is not mistaken for low blink rate
- **Popup overview** — current blink rate (last 5 minutes), detection state, and a 1-hour sparkline chart
- **Dashboard** — long-term trends (6h–30d), raw blink events, stats, configurable settings, and CSV/JSON export
- **Calibration** — personalize EAR open/close thresholds to your face
- **Reminder modes** — system notifications and optional fullscreen overlay
- **Local storage** — minute-level aggregates kept in IndexedDB on your machine

## How it works

```
Camera (offscreen document)
  → MediaPipe Face Landmarker
  → EAR + blink finite-state machine
  → blink / face_lost / face_present events
  → Service worker (aggregation, reminders, state)
  → IndexedDB + popup / dashboard UI
```

Chrome MV3 service workers cannot access the camera directly. The extension uses an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) for `getUserMedia` and MediaPipe inference, while the service worker handles persistence, alarms, and notifications.

## Requirements

- Google Chrome 109+ (offscreen documents)
- Webcam access when detection is running
- Node.js 18+ for development

## Development

```bash
git clone <repo-url>
cd eyeblinkdetect
npm install
npm run dev      # watch build to dist/
npm run build    # production build
npm run check    # typecheck + tests
```

## Load the extension

1. Run `npm run dev` or `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/` folder.

Grant camera permission when prompted. Click the toolbar icon to start or stop detection.

## Usage

1. **Start** — click the extension icon, then **Start**. The popup shows your current blink rate and state (`RUNNING`, `ABSENT`, `OFF`, etc.).
2. **Calibrate** — while running, use **Calibrate** in the popup to tune EAR thresholds for your face.
3. **Dashboard** — open **Open Dashboard** from the popup for charts, settings, and data export.
4. **Settings** — adjust low-BPM threshold, window/sustain minutes, cooldown, and reminder delivery on the dashboard.

Default reminder rule: average below **10 blinks/min** over a **5-minute** window, sustained for **3 minutes**, with a **5-minute** cooldown.

## Project structure

```
src/
  background/     Service worker — state machine, aggregation, reminders
  offscreen/      Camera + MediaPipe inference
  popup/          Toolbar popup UI
  dashboard/      Full-page charts, settings, export
  permission/     Camera permission helper page
  lib/            Shared logic (EAR, FSM, DB, settings, messages)
tests/            Vitest unit tests
docs/             Design specs and plans
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev build with watch |
| `npm run build` | Production build to `dist/` |
| `npm run typecheck` | TypeScript check |
| `npm run test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run check` | Typecheck + test |

## Privacy

- Face landmarks are processed locally; frames are not stored or transmitted.
- The MediaPipe model ships with the extension bundle.
- All blink history stays in your browser's IndexedDB until you export or clear extension data.

## Disclaimer

This tool is for awareness and habit-building only. It is not medical advice and does not diagnose dry eye, fatigue, or other conditions.

## License

MIT
