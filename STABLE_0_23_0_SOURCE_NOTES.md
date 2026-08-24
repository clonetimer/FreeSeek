# FreeSeek 0.23.0 Stable Source Notes

**Status:** Local/Internal Source Stable; public/native artifact certification pending  
**Date:** 2026-08-23  
**Upstream frozen baseline:** 0.22.0 Source Stable @ `58703e2cf2385073a612dd3c8a0872f13ddbdd44`

## Scope

FreeSeek 0.23.0 freezes the 0.22.0 source-stable baseline (Desktop UI U0-U5 + General HMR H0-H4 on one shared Agent/Kernel) plus a verification & cross-platform hardening pass. Functional surface is unchanged; this release is source verification and test-infrastructure hardening only.

## Fixes included (see CHANGELOG 0.23.0)

- hookify hot-reload cache race (mtime-only cache key missed same-size rapid rewrites) — cache key now includes size and `toggleHookifyRule` bumps mtime explicitly.
- Test-infrastructure layout defects: `acp-cli-stdio`, `desktop-runtime-e2e`, `extension-management-host-wiring` now resolve compiled entries / source roots robustly across esbuild bundle, tsc-fallback mirror, ts-node and production `dist/` layouts; `scripts/test.mjs` pre-stages CLI entry bundles so the esbuild path is self-contained; `ChildRpc` requests fail fast on child exit and time out.
- Missing platform gates: ACP/Headless H4 untrusted-sandbox E2E and the sandbox-policy symlink-rejection test skip on unsupported platforms instead of failing.
- Windows ESM import fix in `desktop-portable-install` tests (tsc CJS emit rewrites dynamic `import()` to `require(file://…)`, invalid on Windows).

## Verified on this baseline (Windows 10, Node v25.2.1)

- `npm run check` 8/8 PASS (typecheck src/tests, hygiene, runtime/host/benchmark boundary, version coherence; JSDoc advisory non-blocking).
- Full unit suite 520 cases: 495 pass / 24 skip / 1 file-level Node-25 runner IPC quirk (file passes standalone 7/7; official validation targets Node LTS 22).
- H4 untrusted sandbox suites remain Linux-only by design and fail closed elsewhere.

## Release boundary

This source baseline is frozen for local/internal source deployment and downstream packaging. The immutable public `v0.23.0` tag must be created only after the existing release contract (pinned typecheck/test/build, ACP conformance + two independent ACP client interop, VSIX/npm smoke, Desktop native evidence, Linux H4 release-environment evidence) is satisfied on the exact candidate.
