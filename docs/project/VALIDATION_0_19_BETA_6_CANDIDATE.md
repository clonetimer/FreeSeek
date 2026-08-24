# FreeSeek 0.19.0-beta.6 Candidate Validation Record

Date: 2026-08-20

Baseline: `0.19.0-beta.5` candidate commit `73e1be9ee32e78be52c4cffa71fe75cb57f62afd`

Candidate: `0.19.0-beta.6` (untagged until Windows production-build and external-client gates pass)

## Windows beta.5 field evidence

- Repository gates: **8/8 PASS**.
- Full regression: **349 total / 0 fail** (345 pass, 4 platform-gated skip).
- ACP raw conformance: **15/15 PASS** via the verification-build fallback.
- Production build: Extension bundle completed, then Headless bundle failed because esbuild could not resolve the Node builtin subpath `readline/promises`.

## Product fix

- `src/headless.ts` uses `node:readline/promises`.
- Every Node-host esbuild target uses the shared `NODE_HOST_EXTERNALS = ["vscode", "esbuild", "node:*"]`.
- `tests/release-pipeline.test.ts` locks both invariants.

## Candidate gates

- `npm run check`: **8/8 PASS**.
- `npm test`: **350/350 PASS, 0 FAIL** in the local verification environment.
- `npm run acp:conformance`: **15/15 PASS**.

## Remaining external gates

1. Windows `npm run vscode:prepublish` + built smoke + VSIX/TGZ packaging on this exact candidate.
2. Two independent ACP client reports on this exact candidate.

Do not tag beta.6 or promote RC until those external gates pass.
