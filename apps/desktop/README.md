# FreeSeek Desktop (0.20 development)

The standalone application is a first-party ACP client. It never calls the Agent Kernel or ToolRuntime directly.
The shared 0.19 Stable Kernel remains the execution baseline; 0.20 adds Desktop host/presentation and ACP-host
capabilities rather than a second Agent implementation.

## Development run

```bash
# repo root
npm install
npm run vscode:prepublish     # builds dist/freeseek-acp.js
npm run desktop:build         # platform-neutral TypeScript Desktop build

# one-time Electron install for the desktop package
npm --prefix apps/desktop install
npm --prefix apps/desktop start
```

Development launch uses the repository `dist/freeseek-acp.js` by default. Test overrides can use
`FREESEEK_NODE_BIN` / `FREESEEK_ACP_ENTRY` without changing packaged behavior.

## D4 production/portable path

```bash
npm run desktop:build:prod
npm run desktop:stage:portable -- --electron-dist /path/to/unpacked/electron --platform linux --arch x64
```

The portable stage embeds the compiled Desktop app under Electron `resources/app` and the single ACP sidecar
under `resources/freeseek/sidecar`. Packaged ACP execution uses the Electron executable with
`ELECTRON_RUN_AS_NODE=1`; system Node is not part of the packaged contract. The stage writes a
`freesek-release-manifest.json` with critical-file SHA-256 evidence. This stage is a D4 smoke/release-candidate
building block, not a signed installer.

For installer mechanics preflight, two exact-Electron portable stages can be exercised with:

```bash
npm run desktop:installer:portable:preflight -- --previous-stage /path/to/older-stage --candidate-stage /path/to/newer-stage
```

This performs real directory-swap fresh-install/upgrade/rollback validation, but deliberately emits a
`freesek-desktop-portable-installer-preflight` report. It is not accepted as final per-platform RC installer evidence.

Persistent provider secrets are main-process `safeStorage` only; a one-time key exists transiently in the renderer input
while the user enters it, is cleared when a credential-consuming IPC request is constructed, and is never persisted there.
Insecure Linux `basic_text` storage fails closed. Provider API keys and MCP environment values are removed from ordinary
settings persistence. Provider keys are also excluded from ACP child argv.

See `docs/project/DESKTOP_THREAT_MODEL_0_20.md` for current controls and remaining RC blockers.
