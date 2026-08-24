# FreeSeek 0.20.0-dev.2 Validation

Date: 2026-08-20

## Scope

D1-A checkpoint for the Standalone Desktop Host. This checkpoint validates the Desktop runtime against a real FreeSeek ACP child process, while keeping real Electron BrowserWindow execution as the remaining D1-B gate.

## Passed

- `npm run check`: 8/8 PASS.
- `npm test`: 359/359 PASS, 0 FAIL.
- `npm run acp:conformance`: 15/15 PASS.
- `npm run desktop:build`: PASS.
- generated desktop `main.js`, `preload.js`, and `renderer.js`: `node --check` PASS.
- `DesktopRuntimeController` real child E2E: PASS.
  - launches a real ACP child process;
  - negotiates ACP v1;
  - creates a durable session;
  - completes a real Provider-backed Agent turn;
  - observes `session/update` streaming;
  - switches mode and lists the session;
  - verifies durable EventLog creation;
  - closes the session and tears down the sidecar.
- Desktop repo-root lookup is package-identity based rather than compiled-directory-depth based.
- `apps/desktop` launch command uses `electron .`, honoring `package.main`.
- Electron smoke automation is present and drives `BrowserWindow -> preload contextBridge -> IPC -> DesktopRuntime -> ACP child` when a runtime is available.

## Remaining D1 gate

- Real Electron 43.3.0 `BrowserWindow` execution has not been run in this container because the runtime binary is unavailable here.
- `npm run desktop:smoke` is the single D1-B command once `apps/desktop/node_modules/electron` or `FREESEEK_ELECTRON_BIN` is available.

## Uploaded tool packages

- `pnpm-linux-x64` 11.22.0 is executable on the current x64 host and can be used as an external package-manager tool.
- uploaded `@esbuild/linux-x64` is 0.28.2; FreeSeek is locked to esbuild 0.21.5, so it was deliberately **not** substituted into the project dependency tree.
- arm64 variants are retained for later ARM validation only.
