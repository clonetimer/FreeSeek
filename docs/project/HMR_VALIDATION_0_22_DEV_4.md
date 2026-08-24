# FreeSeek General HMR 0.22.0-dev.4 Validation

Date: 2026-08-22
Branch: `dev/0.22-hmr`
Milestone: **H4 — Untrusted / Model-generated Extension Out-of-process Sandbox**

## Scope

H4 closes the planned General HMR v1 milestone by admitting `trust=untrusted` executable **Tool contributions** only through an enforced, generation-owned worker process. It does not weaken or replace H0-H3: Agent runs still hold immutable generation leases, candidates activate transactionally, failed candidates retain last-known-good, and H3 remains the host-neutral management/audit surface.

H4 dev.4 deliberately does **not** claim cross-platform sandbox parity, shell/process brokering, untrusted Connector/Skill/Hook/MCP/UI contributions, marketplace/install/signing, or VM/hypervisor-grade containment. Unsupported or unproven isolation paths fail closed.

## Executable isolation boundary

### Admission

- `ExtensionRuntime` accepts `trust=untrusted` only when the module carries an internal `execution.mode=sandbox` / `enforced=true` descriptor supplied by the filesystem H4 loader.
- A caller cannot submit an untrusted in-process `activate()` module and obtain a fallback; Runtime rejects it before Host-process activation.
- The Host never `require()`s the untrusted package entry.
- H4 v1 rejects untrusted Connector, Skill, Hook, MCP, persistence and UI capabilities, non-empty declarative H2 contributions, and `capabilities.shell=true`.

### Linux worker

H4 probes the local platform before activation. dev.4 requires Linux, Node >=22 Permission Model, and working unprivileged user/mount/network namespaces. A worker is launched with:

- user + mount + PID + IPC + UTS + network namespaces;
- private tmpfs root + `chroot`;
- only Node/runtime libraries, `/dev/null`, `/dev/urandom` and a read-only `/package` snapshot mounted inside;
- `env -i` and no Host credential/environment inheritance;
- Node Permission Model with direct filesystem access restricted to `/package` and no child-process/worker/addon grant;
- independent network namespace, so worker code cannot use Host egress directly.

The package is snapshotted before execution. Snapshot limits are 512 regular files / 8 MiB; `.git` and `node_modules` are skipped; symlinks/non-regular entries are rejected. H4 v1 therefore expects bundled/dependency-free package-local JavaScript.

This is evidence for practical process/OS containment of ordinary malicious JavaScript using supported Node/Linux mechanisms. It is **not** represented as protection against unknown Node runtime or Linux kernel sandbox escapes.

## Host-owned capability policy

`--extension-sandbox-policy <absolute-file>` (ACP/Headless), `freesek.extensionSandboxPolicyFile` (VS Code) and the Desktop policy-path setting select one startup-only JSON policy. H3 management can inspect lifecycle state but cannot modify/widen these grants.

- policy file: absolute, ordinary, non-symlink, <=256 KiB, strict schema;
- filesystem roots: explicit absolute real directories;
- network: exact HTTP(S) origins only;
- package capability declarations can only narrow/admit use; they cannot expand Host grants;
- filesystem/network capabilities without a matching Host grant fail closed;
- a Host grant that the manifest did not request also fails closed.

The worker itself does not receive Host filesystem/network authority. It can request bounded broker operations over the versioned IPC channel:

- `fs.readText` / `fs.writeText`: Host realpath/symlink containment plus per-Tool effect checks;
- `net.fetchText`: exact Host origin allowlist plus that Tool's `runtime.requiresNetwork=true`;
- no direct network fallback, no Authorization credential forwarding, no implicit redirect following;
- worker-to-Host broker request payloads are capped at 256 KiB; Host file/network source reads are capped at 1 MiB and every encoded broker response must also fit the 512 KiB protocol frame, otherwise only that broker operation fails.

## IPC / failure containment

The worker protocol is JSON-lines version 1. stdout is reserved for protocol frames; console output is redirected to stderr. Important bounds:

- protocol line: 512 KiB;
- call/result input: 256 KiB;
- worker input buffer: 512 KiB;
- stderr projection: 64 KiB;
- activation timeout: 5 s;
- default call timeout: 15 s; hard maximum: 30 s;
- cancel grace: 250 ms; dispose grace: 500 ms.

Non-JSON/protocol corruption kills only the worker and emits `sandbox-protocol`. A CPU hang exceeding the tool budget kills only the worker and emits `sandbox-timeout`. Worker stdin disconnect/EPIPE is absorbed by the supervisor instead of surfacing as an uncaught Host exception. A >256 KiB tool result or oversized broker response is rejected without killing a healthy worker. Sandbox status is projected into H3 management and durable audit.

## Generation / HMR semantics

H4 keeps the H0/H1 generation invariant across process boundaries:

- candidate worker must become ready before activation;
- candidate activation failure preserves the active last-known-good worker;
- watcher-driven V1 -> V2 package change activates a new worker for later Agent runs;
- a V1 Agent lease keeps invoking the V1 worker after V2 activates;
- the retired V1 worker is disposed only after its final generation lease releases;
- timeout/crash/protocol fault on the active worker is surfaced as sandbox fault/managed `error`, not falsely labeled as a healthy LKG.

## Host wiring

### ACP

- `--extension-sandbox-policy <absolute-file>` is startup-only.
- The process-shared H3 FileExtensionHost receives the parsed policy.
- A real ACP Agent prompt has been exercised with an untrusted `ext__...` tool in the normal ToolRegistry/ToolRuntime path; the result is produced by a separate sandbox worker.
- Existing ACP v1 session protocol remains unchanged; H3 management continues under the FreeSeek vendor namespace.

### Headless

- same startup-only policy flag;
- H3 one-shot management remains Provider/model/prompt independent;
- a filesystem-capable untrusted package with an explicit grant has been started and reported as `sandbox:running` through one-shot management.

### Desktop

- persisted non-secret settings contain only the absolute policy **path**;
- Electron main validates the path and forwards it to the ACP sidecar;
- Renderer sees only H3 status including sandbox state/isolation/PID and receives no filesystem/process/Runtime authority.

### VS Code

- `freesek.extensionSandboxPolicyFile` is explicit startup configuration;
- relative policy paths fail closed;
- the same process-level FileExtensionHost receives the loaded policy;
- Extension QuickPick status distinguishes sandbox state from trusted in-process execution;
- workspace-local packages are still not auto-scanned.

## Validation results

### H0-H4 combined behavioral/host regression

Because the checkpoint has no project-local `node_modules`, focused TypeScript tests were executed using the available global `ts-node` runner. Existing ACP/Headless paths use a **test-only external `iconv-lite` module lookup** via `NODE_PATH` solely to load their already-existing UTF-8 code; this is not added to FreeSeek source or represented as dependency restoration.

Test set:

- `tests/extension-runtime.test.ts`
- `tests/extension-package-watcher.test.ts`
- `tests/extension-package-contributions.test.ts`
- `tests/extension-registry-boundary.test.ts`
- `tests/tool-runtime.test.ts`
- `tests/skills.test.ts`
- `tests/extension-management.test.ts`
- `tests/extension-sandbox.test.ts`
- `tests/acp-server.test.ts`
- `tests/headless.test.ts`
- `tests/desktop-host.test.ts`

Result before milestone commit: **111/111 PASS**.

H4's dedicated `tests/extension-sandbox.test.ts` is **16/16 PASS** and covers:

1. in-process untrusted admission rejection;
2. strict startup policy JSON + symlink rejection;
3. real separate worker + cleared Host env;
4. direct host filesystem / child process / TCP containment;
5. filesystem broker roots + per-tool effect enforcement;
6. exact-origin network broker + per-tool `requiresNetwork` enforcement;
7. direct loader reload with old-generation lease pinning;
8. real filesystem watcher V1 -> V2 reload with old worker pinning/disposal;
9. failed candidate activation preserving the old worker/LKG;
10. CPU timeout worker kill with Host survival;
11. shell capability and package symlink fail-closed;
12. malicious raw stdout/protocol corruption containment;
13. oversized result rejection without killing a healthy worker;
14. pre-aborted call immediate cancellation without hanging/killing the worker;
15. oversized broker response returned as an operation error rather than a protocol crash;
16. H3 sandbox crash health + durable lifecycle audit projection.

### ACP H4 E2E

`tests/acp-server.test.ts`: **10/10 PASS** including a real untrusted sandbox tool projected through the normal Agent ToolRegistry and invoked by the provider.

### Headless H4 E2E

`tests/headless.test.ts`: **7/7 PASS** including startup-only policy loading and provider-free management projection of a running untrusted worker.

### Host wiring boundary

`tests/extension-management-host-wiring.test.ts`: **3/3 PASS**. It checks ACP vendor management separation, Desktop policy-path validation/privilege direction, and VS Code explicit-root/policy wiring without workspace auto-scan.

### Desktop security

`tests/desktop-security.test.ts`: **26/26 PASS**.

Desktop strict TypeScript with global TypeScript 5.8.3 and the available global Node type root: **PASS**.

### Supporting global TypeScript graph

A global strict `tsconfig.check.json` run is not a replacement for the project-pinned compiler and cannot be fully green in this checkpoint: VS Code and `iconv-lite` declarations are absent and existing baseline Node typing differences remain. The emitted diagnostics did not identify the new H4 sandbox policy/supervisor/worker files. `src/activate.ts` remains affected by unavailable `vscode` declarations and pre-existing callback typing diagnostics. This evidence is supporting only; the pinned project typecheck remains blocked below.

### Repository checks

`scripts/check.mjs` after version/project-state update:

- 3/8 hygiene: **PASS** (`src/hosts/acp/server.ts` remains below its 600-line gate; no exception was added);
- 4/8 Runtime boundary: **PASS**;
- 5/8 benchmark/private-holdout boundary: **PASS**;
- 6/8 Kernel -> Host dependency direction: **PASS**;
- 7/8 package/lock/project-state coherence: **PASS**;
- 1/8 source typecheck: **BLOCKED BY ENVIRONMENT** — `node_modules/typescript/bin/tsc` absent;
- 2/8 test typecheck: **BLOCKED BY ENVIRONMENT** — same missing pinned TypeScript executable;
- 8/8 export JSDoc remains advisory/non-blocking and reports existing missing export JSDoc.

`git diff --check`: **PASS**.

### Dependency-backed commands

- `npm test`: **BLOCKED BY ENVIRONMENT** before tests start. The runner reports esbuild unavailable and its fallback cannot find project-local `node_modules/typescript/bin/tsc`.
- `npm run desktop:build`: **BLOCKED BY ENVIRONMENT** at the same missing project-local TypeScript executable.

No source, release contract, security boundary or max-lines threshold was weakened to manufacture a green result.

## Release-line separation

- `v0.20.0^{}` remains `67bbe2fe0b97a347e1bb6fa26fb196b553326df7`.
- frozen `dev/0.21-ui` remains `84d14cd68a07bb0b20dc5cd046157f7feed0cab5` (`0.21.0-rc.1`).
- `v0.21.0` remains absent.
- H4 exists only on `dev/0.22-hmr` and is not backported into the pending 0.21 release candidate.

## Milestone conclusion

H4 implements the planned General HMR v1 untrusted execution boundary for the proven Linux environment without claiming unsupported platform/security guarantees. H0-H4 are feature-complete as the currently defined 0.22 HMR milestones. This checkpoint does **not** start a post-H4 feature line or a 0.22 release promotion; those require a separate decision and dependency/platform evidence.
