# FreeSeek 0.20.0-dev.3 Validation

Date: 2026-08-20

## Scope

D2 session UX foundation built on the already validated DesktopRuntime → ACP child boundary. This checkpoint deliberately does not promote to alpha.1 because real Electron BrowserWindow execution is still outstanding.

## Passed

- `npm run check`: 8/8 PASS.
- `npm test`: 360/360 PASS, 0 FAIL.
- ACP raw conformance: 15/15 remains PASS after Desktop changes.
- `npm run desktop:build`: PASS; generated main/preload/renderer parse successfully.
- Real DesktopRuntime ACP child E2E now covers:
  - create durable session;
  - Provider-backed Agent prompt streaming;
  - mode switch and session/list;
  - close session;
  - reconnect sidecar;
  - list durable history by workspace;
  - `session/resume` same session id;
  - continued Agent prompt after resume;
  - clean close/sidecar teardown.
- Desktop renderer exposes History/Resume controls without directly reading EventLog files.
- Permission and elicitation are rendered as first-class dialogs using ACP `options` / `requestedSchema`; `window.confirm` / `window.prompt` are absent.

## Remaining alpha.1 gate

`npm run desktop:smoke` still requires a real Electron 43.3.0 runtime. The current Linux container has Xvfb and Chromium but not the Electron runtime binary; a Chromium substitute is intentionally not counted as BrowserWindow evidence.
