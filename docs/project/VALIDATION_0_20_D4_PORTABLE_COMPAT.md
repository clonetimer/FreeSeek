# FreeSeek 0.20 D4 Portable Compatibility Validation

Date: **2026-08-20**
Branch: `dev/0.20`
Version metadata: `0.20.0-dev.3`
Scope: D4 packaging/security hardening. This is **not** an RC promotion record.

## 1. What changed in this validation round

- Desktop production build can use an explicitly supplied native esbuild binary when the JavaScript API package is unavailable in the recovery environment.
- Desktop production build now targets only the ACP sidecar plus Desktop TypeScript payload; it no longer couples standalone Desktop packaging to VS Code Webview/Mermaid bundles.
- ACP conformance can validate the actual production `dist/freeseek-acp.js` when a native esbuild binary is supplied.
- Electron smoke now checks the pinned Desktop Electron version and rejects mismatches by default.
- Portable staging records Electron runtime version, expected version and match status, and rejects mismatches by default.
- Linux portable staging productizes the Electron executable from `electron` to `FreeSeek`; equivalent productization paths are defined for Windows/macOS but remain unvalidated on those OSes.
- Packaged E2E mode launches the staged executable without repository or ACP-entry overrides and requires `app.isPackaged=true`.

## 2. Supplied recovery toolchain

The locally supplied validation inputs were inspected before use:

| Input | Verified identity | Use |
| --- | --- | --- |
| `linux-x64-0.21.5.tgz` | `@esbuild/linux-x64` **0.21.5** | Exact platform binary matching `package-lock.json` |
| Electron Linux x64 archive | Electron **43.2.0** | Compatibility preflight only |
| pnpm Linux binary | pnpm **11.22.0** | Available recovery tool; not required for the successful build path |

The project pin remains Electron **43.3.0**. No dependency version was changed to fit the supplied runtime.

## 3. Production build evidence

With `FREESEEK_ESBUILD_BIN` pointing to the verified esbuild 0.21.5 binary:

- `npm run desktop:build:prod` — **PASS**
- output `dist/freeseek-acp.js` — real minified production esbuild bundle
- Desktop `main.js`, `preload.js`, `index.html` — **generated**
- ACP CLI shebang invariant — **PASS**

The previous blocker caused by missing runtime code for VS Code Webview dependencies was removed by narrowing Desktop production build scope to `--build-target=acp`; standalone Desktop packaging does not need to rebuild the VS Code presentation bundle.

## 4. ACP production-bundle conformance

`FREESEEK_ESBUILD_BIN=... npm run acp:conformance`

Result: **16/16 PASS** with build kind `esbuild-production-bundle`.

This covers JSON-RPC framing, lifecycle, session new/prompt/list/close/resume/load, history replay and stdout purity on the same ACP bundle staged into Desktop.

It remains FreeSeek's raw conformance driver and does **not** satisfy the independent-client interoperability RC gate.

## 5. Electron 43.2.0 compatibility evidence

### Development-host BrowserWindow path

Executed real Electron BrowserWindow -> sandbox preload -> contextBridge -> IPC -> DesktopRuntime -> ACP sidecar -> shared Kernel.

Result: **PASS** with explicit mismatch waiver. Evidence reported:

- `electronVersion=43.2.0`
- `expectedElectronVersion=43.3.0`
- `versionMatched=false`
- bridge/session/history/load/resume/settings/artifact checks — **PASS**

Without the explicit compatibility waiver, the smoke runner rejects this runtime with exit code 2. Therefore 43.2.0 cannot accidentally count as the 43.3.0 RC gate.

### Productized portable path

A portable stage was assembled from the real Electron runtime plus production ACP sidecar. The first launch exposed a real packaging defect: retaining the executable name `electron` caused Electron to treat the application as a development/default app and `app.isPackaged` remained false.

After productization to `FreeSeek`, the staged executable was launched directly with:

- no `FREESEEK_REPO_ROOT`;
- no `FREESEEK_ACP_ENTRY`;
- no system-Node override;
- bundled sidecar resolved from `resources/freeseek/sidecar/freeseek-acp.js`;
- Electron-as-Node used for the child ACP host.

Result: **PASS**, including `appIsPackaged=true`, history replay/resume and artifact preview.

Because the runtime is Electron 43.2.0 and the isolated root-container smoke required an explicit `--no-sandbox` test flag, this is compatibility evidence only, not signed-release or production sandbox evidence.

## 6. Regression gates

- `npm run check` — **8/8 PASS**
- `npm test` — **389/389 PASS**, 0 failed
- production ACP conformance — **16/16 PASS**
- exact Electron mismatch rejection — **PASS**
- portable staging Electron-version rejection — **PASS**

## 6.1 Release evidence and cross-platform staging structure

The D4 release-evidence mechanism is now implemented and regression-tested:

- every final artifact is keyed by a unique `platform/arch`;
- artifacts must be regular files, not symlinks;
- every artifact requires a matching portable-stage manifest;
- stage version must equal the committed FreeSeek version;
- stage Electron runtime must exactly equal the Desktop **43.3.0** pin with `versionMatched=true`;
- output `SHA256SUMS.txt` is paired with `freesek-desktop-provenance.json`, which records Git commit, clean/dirty tree state, Electron pin, stage-manifest digest and artifact digest/size.

The mechanism defaults to a clean committed worktree. A dirty-worktree override exists only to support non-RC development/testing evidence and is explicitly labeled non-RC.

Windows x64 and macOS arm64 portable productization paths now have static filesystem-layout tests in addition to Linux. These tests verify executable/app-bundle renaming, resource placement, sidecar placement, macOS plist branding fields and exact Electron-version gating. They are **not** Windows/macOS launch, code-signing or notarization evidence.

## 7. RC blockers still open

1. Repeat development and packaged smoke using exact Electron **43.3.0**, without the compatibility mismatch waiver.
2. Obtain Windows/macOS/Linux packaging and launch evidence; only Linux compatibility evidence exists here.
3. Obtain Windows/macOS OS-protected `safeStorage` success evidence and document supported Linux secure backends.
4. Define and execute installer signing/notarization and signing-key custody.
5. Execute the now-implemented release checksum/provenance gate on final RC artifacts; installer upgrade/rollback evidence remains pending.
6. Complete the independent ACP-client interoperability RC gate in `RELEASE_CHECKLIST.md`.

General HMR remains deferred until Desktop Stable.
