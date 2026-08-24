# FreeSeek 0.19.0-beta.4 Validation Record

Date: 2026-08-20

Branch under test: `feat/m5-release-hardening`

Baseline tag: `v0.19.0-beta.3`

Target tag: `v0.19.0-beta.4`

## Scope

M4/M5 pre-release hardening without changing Agent semantics:

- machine-tested Cross-host capability matrix;
- ACP bundle added to production smoke;
- release pipeline aligned with repository version discipline;
- RC/Stable packaging cannot bypass full tests, ACP conformance, or two-client interoperability evidence;
- VSIX + npm/CLI artifact SHA256 release workflow.

## Automated gates

- `npm run check`: **8/8 PASS**.
- `npm test`: **349/349 PASS, 0 FAIL** across 4 suites.
- `npm run acp:conformance`: **15/15 PASS** on the 0.19.0-beta.4 candidate.

## Production artifact build

`npm run compile` was attempted in the current Linux runtime and correctly failed before bundling because the restored dependency tree contains `@esbuild/win32-x64` while this host requires `@esbuild/linux-x64`. This is an environment/platform dependency mismatch. Source/test typechecking and ACP verification use the restored TypeScript toolchain and remain green.

A production RC/Stable artifact must therefore be built on a matching dependency install (`npm ci` on the target host/platform) and pass `node scripts/release.mjs ...`.

## Independent ACP interoperability

Current count remains **0 / 2** executable independent ACP client implementations in this runtime. The beta.3 evidence adapters/gate remain the authoritative RC criterion.

## Promotion decision

**Taggable as `v0.19.0-beta.4`: internal beta gates passed.**

Not taggable as RC or Stable until the two independent-client evidence gate and production artifact build/smoke are both closed.
