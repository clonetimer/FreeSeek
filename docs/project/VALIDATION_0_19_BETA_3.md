# FreeSeek 0.19.0-beta.3 Validation Record

Date: 2026-08-20
Branch under test: `feat/m4-crosshost-stable`
Integration branch: `dev/0.19`
Baseline tag: `v0.19.0-beta.2`
Target tag: `v0.19.0-beta.3`

## Scope

M4 release hardening focused on independent-client evidence quality and Cross-host release discipline:

- strict two-implementation external ACP evidence gate;
- adapter-only drivers for the official TypeScript SDK and acpx;
- environment probe that never counts unavailable clients;
- stricter evidence wrapper requiring implementation provenance and `session/update`;
- Cross-host prompt/product consistency;
- post-0.19 priority frozen as Desktop UI before general HMR runtime.

## Automated gates

- `npm run check`: **8/8 PASS**.
- `npm test`: **345/345 PASS, 0 FAIL** across 4 suites.
- `npm run acp:conformance`: **15/15 PASS** against a real FreeSeek ACP stdio child process.

The independent-client evidence gate is itself covered by regression tests for two unique implementations, duplicate-implementation rejection, and missing-`session/update` rejection.

## Independent-client interoperability gate

Current result: **0 / 2 independently implemented ACP clients executed in this runtime**.

`npm run acp:interop:probe` reports the official TypeScript SDK, acpx, and Zed unavailable in the current execution environment. This is treated as a release-evidence blocker, not as a substitute failure of FreeSeek's internal ACP conformance.

The repository now contains two adapter-only paths:

1. `scripts/acp-interop-official-sdk-driver.mjs` — uses the external official SDK implementation.
2. `scripts/acp-interop-acpx-driver.mjs` — uses the external acpx executable as the ACP client.

Neither counts unless the external dependency actually runs successfully. After reports are collected, `npm run acp:interop:gate -- <report-a> <report-b>` requires two distinct implementation identities plus at least one advanced capability.

## Promotion decision

**TAGGABLE as `v0.19.0-beta.3`.**

It is **not taggable as `v0.19.0-rc.1`** until two independent ACP implementations execute successfully against the exact candidate commit and the full regression/conformance gates remain green.
