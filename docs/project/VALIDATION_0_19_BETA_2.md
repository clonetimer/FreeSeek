# FreeSeek 0.19.0-beta.2 Validation Record

Date: 2026-08-19  
Branch under test: `feat/m4-acp-interop`  
Integration branch: `dev/0.19`  
Baseline tag: `v0.19.0-beta.1`  
Target tag: `v0.19.0-beta.2`

## Scope

M4 beta hardening for ACP v1 stdio interoperability:

- stricter JSON-RPC request/response id validation;
- process-level raw ACP conformance;
- external-client evidence wrapper;
- explicit interoperability matrix and RC evidence contract;
- portable verification build when native esbuild does not match the host platform.

## Automated gates

- `npm run check`: **8/8 PASS**; export JSDoc remains advisory only (62 existing entries).
- `npm test`: **342/342 PASS, 0 FAIL** across 4 suites.
- `npm run acp:conformance`: **15/15 PASS** against a real FreeSeek stdio child process.

The conformance suite covers JSON-RPC parse/invalid-request/id semantics, initialize gating, ACP v1 capability negotiation, unknown methods, session/new validation, prompt + session/update, list, set-mode, close, resume scope/mode restoration, and stdout protocol purity.

## Independent-client interoperability gate

Current result: **0 / 2 independent ACP clients executed**.

The repository contains an evidence wrapper (`npm run acp:interop -- ...`) that only accepts a driver when it emits structured proof for initialize/new/prompt. A successful process exit alone is rejected. FreeSeek's own raw conformance driver never counts as an independent client.

The user-provided DeepSeek Harness source contains an ACP snapshot launcher built on `@agentclientprotocol/sdk`, but its installed dependency tree is not present in the archive/current runtime. Zed/acpx/official SDK runtimes are also unavailable locally. Therefore the RC gate cannot be truthfully closed here.

## Promotion decision

**TAGGABLE as `v0.19.0-beta.2`.**

It is **not taggable as `v0.19.0-rc.1`** until two independent ACP clients execute successfully against the exact release candidate and the full FreeSeek regression remains green.
