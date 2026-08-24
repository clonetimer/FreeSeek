# FreeSeek 0.20.0-dev.1 Validation

Date: 2026-08-20

## Scope

First Standalone Desktop development baseline. This is not an alpha release and does not claim a packaged Electron application yet.

## Passed

- `npm run check`: 8/8 PASS.
- `npm test`: 357/357 PASS, 0 FAIL after desktop packaging/host assertions were added.
- `npm run acp:conformance`: 15/15 PASS.
- `npm run desktop:build`: PASS using the platform-neutral TypeScript development build.
- generated desktop `main.js`, `preload.js`, and `renderer.js`: `node --check` PASS.
- Desktop ACP client unit integration covers initialize/new/prompt/session update/permission/elicitation/list/mode/close.
- Host boundary gate rejects direct Desktop imports of Agent/ToolRuntime/ToolRegistry/Tools.
- Desktop package version equals root project version.

## Explicitly not yet claimed

- Real Electron `BrowserWindow` E2E in this container (Electron runtime package not installed here).
- Installer/signing/updater.
- OS protected provider-secret persistence.
- Desktop LSP, diff review, image input, scheduling, or Multi-Agent UI parity.

These are D1-D4 gates, not dev.1 blockers.
