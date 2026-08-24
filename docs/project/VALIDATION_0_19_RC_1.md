# FreeSeek 0.19.0-rc.1 Validation Record

Date: 2026-08-20

Baseline candidate: `0.19.0-beta.7` at `17c29e0d8ef1bb7acd43ccea33013195e59d2fa9`

## Scope

RC.1 is a release/tooling-only promotion. It does **not** modify `src/` or `esbuild.js`; the Agent Kernel, VS Code host, CLI/Headless host and ACP v1 host are runtime-identical to beta.7.

Changes in RC.1:

- fix `scripts/acp-interop-gate.mjs` option parsing so `--min-clients 2` consumes `2` as an option value instead of treating it as a third JSON report path;
- add a regression for the documented gate CLI shape;
- absorb the Windows beta.7 release/interop evidence into the auditable project ledger;
- advance M4 to done and M5 to in-progress.

## Windows beta.7 field evidence accepted for RC

The Windows field run on the exact beta.7 candidate demonstrated:

- repository gates: **8/8 PASS**;
- built-artifact smoke: **PASS** using stable public contracts;
- production bundles: VS Code / CLI / ACP / Eval / Bench / Webview / Mermaid built successfully;
- VSIX: **produced successfully**;
- npm/CLI TGZ: **produced successfully**;
- official `agentclientprotocol/typescript-sdk` **1.3.0**: initialize/new/prompt/sessionUpdate PASS, plus `additionalDirectories` and `resume`;
- OpenClaw `acpx` **0.13.0**: initialize/new/prompt/sessionUpdate PASS.

The old gate output already listed both reports in `acceptedClients` and recognized the official SDK's advanced capabilities. The only reported error was an attempted read of a file literally named `2`, caused by the old parser's handling of `--min-clients 2`. Thus the external interoperability evidence itself is accepted; RC.1 fixes the gate wrapper rather than repeating the external test.

Sanitized field evidence summary: `docs/project/evidence/ACP_INTEROP_WINDOWS_BETA7_FIELD_EVIDENCE.json`.

## RC.1 internal gates

Executed after the gate parser fix and after changing the committed version sources to `0.19.0-rc.1`:

- documented gate shape `report-a report-b --min-clients 2`: **PASS**, 2 accepted clients and advanced evidence recognized;
- `npm run check`: **8/8 PASS**;
- `npm test`: **352/352 PASS, 0 FAIL**;
- `npm run acp:conformance`: **15/15 PASS**.

`src/` and `esbuild.js` remain byte-identical to beta.7. No new product scope is allowed in RC. Stable promotion is the next phase after blocker review.
