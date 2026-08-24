# FreeSeek 0.20 dev.3 Windows Native Baseline Validation

Date: 2026-08-21
Evidence source: operator-returned `FreeSeek-Windows-Dev3-Validation-Results.zip`
Validated source commit: `a9ffa1221211dc70524b14fba7087159659fc79e`
Version: `0.20.0-dev.3`
Target: `win32/x64`
Electron: `43.3.0`

## Result

The first standalone Desktop Windows baseline is field-proven sufficiently to serve as the non-release previous artifact for RC.1 upgrade/rollback evidence.

- official Electron asset: `electron-v43.3.0-win32-x64.zip`
- official Electron archive SHA-256: `18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9`
- native target preflight: PASS
- development Electron E2E: PASS
- productized packaged E2E: PASS (`appIsPackaged=true`)
- OS secret backend: Windows DPAPI (`secretBackend=dpapi`)
- forced-kill recovery: PASS
- recovery marker observed before kill: yes
- recovery marker survived process-tree termination: yes
- recovered same ACP session: yes
- recovery marker cleared after recovery: yes
- first-RC previous artifact: `portable-zip-v1`, deliberately `releaseEvidenceEligible=false`
- previous artifact SHA-256: `a33bb8f20e7777e0a45d8ab88701ba5b7ef561bde9dd9e4f09e59c3bd5e54410`
- stage manifest SHA-256: `136f8c4be4e6872181030b46c5e403391b994b63e4fc04f76d0c0d6680ca3c84`
- runtime regression: 443 tests, 435 passed, 0 failed, 8 platform skips

## Gate note

The returned `check.log` exposed two TypeScript-only errors in the newly-added crash-recovery integration test. They were not runtime/product failures and were fixed immediately afterward in commit `4dc4496903757abc7735662c872618efbb89633b`. RC evidence must be regenerated on the final RC candidate commit and may not reuse the dev.3 candidate-bound smoke reports.

## Remaining Windows release input

No CurrentUser code-signing certificate was present on the validation machine. The production Windows RC/Stable path therefore still requires an authorized Authenticode signing identity before `rcEligible=true` can be reached under the current signing policy.
