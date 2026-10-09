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
- Node.js 22.12+ for development (Vite 8)

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

1. **Start** — click the extension icon, then **Start tracking**. The popup shows the last five completed minutes and explains whether tracking is running, calibrating, paused, or waiting for your face.
2. **Calibrate** — while running, use **Calibrate** in the popup or dashboard to tune EAR thresholds for your face. Keep your face visible and blink naturally for about 10 seconds; the UI reports completion or a retry suggestion.
3. **Dashboard** — open **Open dashboard** from the popup for charts, settings, and data export.
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
| `npm run check` | Typecheck + unit/integration tests |
| `npm run test:browser` | Build + browser regression and extension smoke tests |

## Browser verification

```bash
npx playwright install chromium  # one-time test browser setup
npm run test:browser
```

The suite checks the built pages with deterministic Chrome API fixtures: current
BPM, chart timestamps, out-of-order range responses, empty/error states, form
validation, denied overlay permission, exports, keyboard focus, and layouts from
320px to 1440px. A separate smoke test loads the real extension into a temporary
Chromium profile with a **synthetic camera**, exercises camera/inference startup,
confirms face absence, and verifies that stopping closes the offscreen document.
It does not use your camera or your personal browser profile. Human blink-detection
accuracy and operating-system notification delivery still need a manual check.

UI screenshots are written to `test-results/` (ignored by Git). Fixture data is
used only in tests; production pages never generate sample history.

## Interface and behavior

- The popup, dashboard, and camera setup share local CSS tokens and system fonts;
  the UI does not fetch external fonts or visual assets.
- The dashboard offers session controls, timestamp-based trends, raw blink events,
  persistent save/error feedback, and permission-aware reminder settings.
- The popup rate uses a clock-based five-minute window; older stored rows are not
  presented as current activity. Invalid/absent readings show a dash.
- Raw event plots render at most 1,500 sampled dots for large ranges while keeping
  the exact event count. Minute charts retain their 600-point limit.
- Calibration progress and detector errors survive reopening the popup. Settings
  writes are serialized to avoid overwriting concurrent preference updates.

## Privacy

- Face landmarks are processed locally; frames are not stored or transmitted.
- The MediaPipe model ships with the extension bundle.
- All blink history stays in your browser's IndexedDB until you export or clear extension data.

## Disclaimer

This tool is for awareness and habit-building only. It is not medical advice and does not diagnose dry eye, fatigue, or other conditions.

## License

MIT
