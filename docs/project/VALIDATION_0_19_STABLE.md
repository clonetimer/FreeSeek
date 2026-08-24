# FreeSeek 0.19.0 Stable Validation Record

Date: 2026-08-20

RC baseline: `v0.19.0-rc.1`

## Stable scope

0.19.0 Stable is a promotion-only release. It introduces no new product scope after RC.1 and does not modify `src/` or `esbuild.js`.

Cross-host surfaces promoted as Stable:

- VS Code Extension Host;
- CLI / Headless Host;
- ACP v1 stdio Agent Server Host.

## Evidence carried from RC/M4

- Windows production build succeeded for Extension / CLI / ACP / Eval / Bench / Webview / Mermaid.
- stable-contract artifact smoke passed.
- VSIX and npm/CLI TGZ were produced successfully.
- official `agentclientprotocol/typescript-sdk 1.3.0` and OpenClaw `acpx 0.13.0` both executed real ACP sessions against FreeSeek.
- official SDK additionally covered `additionalDirectories` and `resume`.
- M4 independent-client count: **2/2**.

## Stable gate results

Executed on the final `0.19.0` tree before the Stable tag:

- `npm run check`: **8/8 PASS**;
- `npm test`: **352/352 PASS, 0 FAIL**;
- `npm run acp:conformance`: **15/15 PASS**;
- `src/` and `esbuild.js`: **byte-identical to `v0.19.0-rc.1`**.

The release is therefore eligible for `v0.19.0` tagging and `main` promotion.
