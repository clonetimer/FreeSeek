# FreeSeek General HMR Runtime 0.22

Status: `0.22.0-dev.4` H0-H4 implemented on `dev/0.22-hmr`.

## 1. Boundary

General HMR is an **Extension Runtime**, not browser live-reload and not a second Agent/Kernel. The 0.21 Desktop UI RC remains frozen separately. A running Agent turn keeps one immutable `ToolRegistry` plus one immutable extension-generation lease; a generation switch is visible only to a later Agent run boundary.

Lifecycle:

`discover -> validate -> stage -> activate generation -> lease snapshot -> retire -> dispose`

H0-H3 support trusted in-process **Tool, Connector, Skill asset, Policy/Hook and MCP tool** contributions plus cross-host operator management and durable lifecycle audit/status projection. H4 adds Linux-only out-of-process execution for `trust=untrusted` **Tool** contributions with enforceable filesystem/network isolation and failure containment.

## 2. Generation and lease semantics

- `ExtensionRuntime.apply()` stages a candidate and atomically swaps the active generation only after activation succeeds.
- Failed activation disposes only candidate effects and preserves the last-known-good generation.
- Missing declared extension dependencies produce `PENDING`; activation reconciles automatically when providers appear.
- Every Agent run obtains an immutable generation lease. Synchronous/background subagents retain the parent lease, so a reload cannot make one logical turn execute mixed generations.
- Retired generations remain alive while any retained lease references them and dispose after the final release.
- Extension tool/MCP definitions and generation-bound executors enter `ToolRegistry` together; extension schemas cannot fall back to the raw tool-body dispatcher.
- Skill assets are snapshotted into the generation and mounted into a run-local `SkillManager`; lease release restores the host/base manager.
- Policy/hook execution is read from the same generation lease, not a mutable global callback registry.

## 3. Trusted package format

A v1 filesystem package contains `freeseek-extension.json` and a CommonJS `.js`/`.cjs` entry.

Minimal tool package:

```json
{
  "schemaVersion": 1,
  "id": "example.tools",
  "version": "1.0.0",
  "trust": "trusted",
  "capabilities": {
    "tools": true,
    "filesystem": "none"
  },
  "entry": "index.cjs"
}
```

```js
module.exports = function activate(ctx) {
  ctx.registerTool({
    name: "echo",
    description: "Return a diagnostic value",
    parameters: { type: "object" },
    runtime: {
      effect: "read",
      concurrency: "parallel",
      readOnlyAllowed: true,
      approval: "auto"
    },
    execute: async () => "ok"
  });
};
```

The public tool name is runtime-owned and namespaced, for example `ext__example_tools__echo`. Packages must not rely on a global mutable registry.

## 4. H2 skill roots/assets

Packages may declaratively snapshot Skill assets:

```json
{
  "schemaVersion": 1,
  "id": "example.skills",
  "version": "1.0.0",
  "trust": "trusted",
  "capabilities": { "skills": true },
  "contributions": {
    "skillRoots": ["skills"]
  },
  "entry": "index.cjs"
}
```

Each configured root is package-relative and contains immediate child `<skill>/SKILL.md` directories. H2 behavior is intentionally snapshot-based:

- configured roots must remain inside the package and may not be symlinks;
- `SKILL.md` symlinks/path escapes are rejected;
- one generation is bounded to 128 discovered skills / 2 MiB of Skill bytes;
- bytes are read during candidate activation and stored in the generation; an old lease never rereads the edited package path;
- mounted extension skills are read-only for that Agent run; status/delete mutations are rejected;
- package edits are observed by the existing HMR fingerprint watcher and become visible only to a later run generation.

This avoids a split-generation state where a ToolRegistry is pinned but Skill content silently changes under the same turn.

## 5. H2 policy and hook contributions

Executable trusted packages can register monotonic ToolRuntime policy/hooks:

```js
module.exports = function activate(ctx) {
  ctx.registerPolicy({
    name: "protect",
    evaluate: async (toolName) =>
      toolName === "delete_file" ? { blocked: "protected by extension policy" } : {}
  });

  ctx.registerHook({
    name: "auditnote",
    event: "post-tool",
    run: async ({ toolName }) => ({ note: `observed ${toolName}` })
  });
};
```

The package must declare `capabilities.hooks=true`.

Security/ordering invariant:

- built-in deny rules remain authoritative;
- extension policy may **block or warn**, never return an allow/grant decision;
- built-in generic approval, MCP approval and sandbox admission remain authoritative;
- pre-tool extension hooks may block/warn but cannot grant permission;
- post-tool hooks run only after the body has completed and may append notes/warnings; they cannot replace the result or retroactively claim a side effect did not occur;
- policy/pre-hook exceptions fail closed; a post-hook exception is surfaced as a diagnostic because the tool body may already have produced side effects.

## 6. H2 MCP contribution adapter

Packages can declaratively mount generation-owned MCP tool servers:

```json
{
  "schemaVersion": 1,
  "id": "example.mcp",
  "version": "1.0.0",
  "trust": "trusted",
  "capabilities": {
    "mcp": true,
    "shell": true
  },
  "contributions": {
    "mcpServers": [
      {
        "name": "localtools",
        "transport": "stdio",
        "command": "node",
        "args": ["./server.cjs"]
      }
    ]
  },
  "entry": "index.cjs"
}
```

H2 MCP rules:

- `capabilities.mcp=true` is always required by the Runtime registration surface;
- `stdio` additionally requires `capabilities.shell=true`;
- `http` additionally requires `capabilities.network=true` and an `http(s)` URL;
- each candidate generation creates its own `McpManager`; connection disposal belongs to the generation effect scope;
- tools are projected as generation-bound names such as `mcp__ext_example_mcp_localtools__echo` and keep the existing MCP approval Runtime semantics;
- an old leased generation can continue using its old connection after a reload/retire until that lease releases;
- activation/connection failure leaves the last-known-good generation active;
- H2 projects MCP **tools only**. Resource/prompt contribution semantics are not claimed yet.

## 7. Enabling filesystem HMR

Extension roots are **explicit operator roots**. FreeSeek does not auto-execute packages merely because a workspace contains them. A package declaring `trust=trusted` executes in-process; `trust=untrusted` is admitted only when the H4 sandbox can be enforced.

ACP:

```text
freeseek acp ... --extension-dir /absolute/trusted/extensions
```

Headless:

```text
freeseek ... --extension-dir /absolute/trusted/extensions
```

`--extension-dir` may be repeated. A root may itself be one package or contain immediate child package directories. ACP owns one runtime/watcher per ACP server process and shares its active generation set across durable sessions; each Agent run still acquires its own immutable lease.

The watcher uses dependency-free polling (default 500 ms), hashes package-owned regular-file content, bounds one scan to 512 files / 8 MiB, serializes scans, and can be stopped/drained cleanly.

## 8. H3 management, durable audit and operator UX

H3 adds a **host-neutral management plane above the existing `FileExtensionHost`**. It does not mutate a running Agent registry and it does not own trust roots. Supported operations are:

- `list` / `status`: project package observations together with Runtime state into `ok`, `degraded` (last-known-good active after a failed candidate), `pending`, `error`, `disabled`, `conflict` or `absent`;
- `reload`: force a new candidate/generation even when the package fingerprint did not change;
- `remove`: durable operator disable + Runtime retire; **package bytes are never deleted**;
- `config enabled=true|false`: persist enable/disable intent inside the host-owned state directory;
- `reconcile`: rescan trusted roots and reconcile dependency-PENDING state;
- `audit`: read bounded lifecycle history.

Trust roots remain **host-owned startup configuration**. The management API cannot add or replace roots at runtime. Disabled intent is security-relevant and is persisted in `extension-intent.json`; if this file is corrupt, H3 fails closed instead of silently re-enabling trusted code.

Lifecycle observability has two deliberate scopes:

1. process-level `extension-audit.jsonl` records Runtime, watcher and management operations across sessions/restarts; the in-memory projection is bounded to 2,000 records, management queries to 500 records, and the durable file rotates at 8 MiB;
2. per-Agent/session EventLog continues to record `extension/lease` and `extension/release`, so a session can prove exactly which generation snapshot it executed without assigning a process-global reload to an arbitrary session.

Host wiring:

- **ACP:** optional FreeSeek vendor JSON-RPC methods under `freesek/extensions/*`; ACP v1 session methods remain unchanged. One ACP process still owns one shared Extension Runtime/watcher.
- **Headless:** `--extension-manage list|status|reload|remove|reconcile|audit|enable|disable` works without Provider/model/prompt, but still requires at least one explicit `--extension-dir` trust root.
- **Desktop:** trusted roots are persisted as ordinary non-secret settings, validated by Electron main, forwarded to the ACP sidecar, and managed from a Renderer status panel only through preload/main/ACP IPC. Renderer never imports the Extension Runtime or filesystem.
- **VS Code:** `freesek.extensionDirs` accepts explicit absolute roots and creates one process-level host using `globalStorageUri` for H3 state; `FreeSeek: 管理 General HMR 扩展` exposes status/reconcile/reload/enable/disable/audit. Workspace-local packages are not auto-discovered. Trust-root setting changes require a VS Code window reload to rebuild the process-level host.

H3 remains the management/audit layer for both trusted generations and H4 sandbox status. It does not create a marketplace, install packages, delete package files or dynamically widen roots/grants; H4 grants remain Host-owned startup policy.

## 9. H4 untrusted out-of-process sandbox

H4 admits `trust=untrusted` only through an **enforced out-of-process execution descriptor**. `ExtensionRuntime.apply()` rejects an untrusted in-memory module that does not carry the sandbox execution attestation, so there is no in-process fallback.

H4 dev.4 support is intentionally **Linux-only**. Before an untrusted candidate can activate, FreeSeek proves that the local runtime can create unprivileged user/mount/network namespaces and use Node >=22 Permission Model. Unsupported or insufficient platforms fail closed.

One untrusted generation owns one supervised worker. The worker is launched with:

- Linux user + mount + PID + IPC + UTS + network namespaces;
- a private tmpfs root and `chroot`;
- only the Node executable/runtime libraries, `/dev/null`, `/dev/urandom` and `/package` mounted into that root;
- `env -i` with no Host credentials/secrets, no Host cwd and no inherited application configuration;
- Node Permission Model with direct filesystem access limited to `/package` and no child-process/worker/addon grants;
- a separate network namespace, so direct `net`/`http`/`fetch` egress cannot use the Host network.

The package is copied **before execution** into a bounded snapshot (512 ordinary files / 8 MiB). `.git` and `node_modules` are not included, symlinks and non-regular entries are rejected, and snapshot files are read-only. H4 v1 therefore expects bundled/dependency-free package-local JavaScript rather than a live `node_modules` tree.

This is a practical process/OS isolation boundary for ordinary malicious JavaScript using supported Node/Linux mechanisms. FreeSeek does **not** claim it is a VM/hypervisor or a defense against unknown Node/runtime/kernel sandbox escapes.

### Untrusted package scope

H4 v1 supports executable **Tool contributions only**. An untrusted package requesting Connector, Skill, Hook, MCP, persistence or UI capabilities fails closed, as do declarative H2 contributions. `capabilities.shell=true` also fails closed; process/shell brokering is not implemented in dev.4.

A minimal untrusted package still uses the normal manifest identity:

```json
{
  "schemaVersion": 1,
  "id": "example.untrusted",
  "version": "1.0.0",
  "trust": "untrusted",
  "capabilities": {
    "tools": true,
    "filesystem": "none"
  },
  "entry": "index.cjs"
}
```

The Host never `require()`s that entry. The worker activates it and returns bounded Tool descriptors; the Host stages those definitions together with generation-bound executors in the existing `ToolRegistry`.

### Startup-only capability grants

An untrusted package may **request** filesystem/network capability in its manifest, but only the Host/operator can grant concrete resources. Grants live in a startup-only JSON file and cannot be widened through H3 management:

```json
{
  "schemaVersion": 1,
  "grants": {
    "example.untrusted": {
      "filesystem": {
        "read": ["/absolute/read-root"],
        "write": ["/absolute/write-root"]
      },
      "network": {
        "allowedOrigins": ["https://api.example.com"]
      }
    }
  }
}
```

Policy files must be absolute ordinary non-symlink files and are bounded to 256 KiB. Filesystem grants resolve to real existing directories. Network grants are exact HTTP(S) origins; embedded credentials, path/query/hash origins and implicit redirects are rejected.

Host entry points:

```text
freeseek acp ... --extension-dir /absolute/extensions --extension-sandbox-policy /absolute/policy.json
freeseek ... --extension-dir /absolute/extensions --extension-sandbox-policy /absolute/policy.json
```

VS Code uses `freesek.extensionSandboxPolicyFile`. Desktop persists only the policy **path** as a non-secret setting; Electron main validates the path and the ACP sidecar parses/enforces the policy. Renderer never receives filesystem or sandbox-runtime authority.

Filesystem/network access from worker code is brokered over the bounded IPC channel:

- `runtime.fs.readText(path)` / `writeText(path,text)` require a matching Host root grant and the calling Tool's effect (`read|write|destructive`) must permit that operation;
- worker-to-Host broker requests are bounded to 256 KiB; Host file reads are capped at 1 MiB, every encoded broker response must fit the 512 KiB protocol frame, and symlink/path escapes are checked on the Host side;
- `runtime.net.fetchText(url)` requires both a Host `allowedOrigins` grant **and that exact Tool descriptor's `runtime.requiresNetwork=true`**;
- network broker supports bounded HTTP(S) GET/POST only, strips credentials/authorization, rejects redirects, caps source responses to 1 MiB and returns an operation error if the encoded response cannot fit the IPC frame;
- direct worker filesystem/process/network access is not used as a fallback.

### IPC and crash containment

The worker protocol is versioned JSON-lines and stdout is reserved for protocol frames. Console output is redirected to stderr. Host limits include:

- protocol line: 512 KiB;
- call/result input: 256 KiB;
- worker input buffer: 512 KiB;
- worker stderr projection: 64 KiB;
- activation timeout: 5 s;
- default call timeout: 15 s, hard maximum 30 s;
- cancel grace: 250 ms; dispose grace: 500 ms.

Malformed/non-JSON stdout, unknown protocol frames and protocol overflows terminate only that worker and emit `sandbox-protocol`. A tool timeout kills the worker and emits `sandbox-timeout`; worker stdin disconnect/EPIPE is contained by the supervisor rather than becoming an uncaught Host exception. Worker crash/status is projected through H3 management/audit while the FreeSeek Host process remains alive. Oversized tool or broker responses are rejected without killing an otherwise healthy worker.

### Generation/HMR semantics across the process boundary

Sandbox workers are generation-owned effects, so H0/H1 semantics are unchanged:

- a candidate worker must become ready before the generation can activate;
- activation failure disposes the candidate and preserves the active last-known-good worker;
- filesystem watcher reload activates V2 for later Agent runs while existing V1 leases continue calling the V1 worker;
- a retired worker disposes only after the final lease on its generation releases;
- H3 durable audit records sandbox spawn/ready/timeout/crash/protocol/dispose metadata and management health surfaces a dead active worker as `error` rather than falsely claiming LKG.

## 10. Fail-closed behavior

- `trust=trusted` remains operator-trusted in-process Node code; `trust=untrusted` requires enforced H4 sandbox execution.
- Unsupported H4 platforms or missing Linux/Node isolation primitives reject untrusted activation; there is no trusted fallback.
- Host-specific UI contributions remain rejected by the Runtime.
- Package entry must remain inside the package; H4 snapshotting additionally rejects every package symlink/non-regular entry and omits `node_modules`.
- Duplicate extension IDs across configured roots do not select a winner; the current last-known-good generation remains active.
- Syntax/load/contribution/worker activation failure does not replace the current generation.
- Package removal retires future availability while already leased turns can finish against their pinned generation/worker.
- Extension tool schemas without a generation-bound executor fail ToolRegistry admission.
- H4 filesystem/network grants are Host-owned startup configuration and cannot be expanded by package metadata or H3 management.
- `shell=true`, untrusted non-Tool contributions and untrusted declarative H2 contributions fail closed in dev.4.

## 11. Trust model and support matrix

| Package mode | Execution | Capability enforcement | dev.4 support |
| --- | --- | --- | --- |
| `trust=trusted` | FreeSeek Host process | H0-H3 admission/ToolRuntime policy metadata | Tool / Connector / Skill / Policy-Hook / MCP tools |
| `trust=untrusted` on supported Linux | generation-owned sandbox worker | namespaces + chroot + Node Permission Model + bounded Host broker | Tools only |
| `trust=untrusted` on other/unproven platforms | none | fail-closed | not enabled |

FreeSeek never auto-scans workspace-local packages. Package roots, and any H4 filesystem/network grants, are explicit Host/operator startup configuration.

## 12. HMR v1 milestone boundary

H0-H4 are implemented on `dev/0.22-hmr` through `0.22.0-dev.4`. No post-H4 feature line is started by this checkpoint. Cross-platform equivalents to the Linux sandbox, broader untrusted contribution types, stronger VM/container isolation, distribution/signing and release promotion require separate evidence/decisions rather than being implied by H4.

0.21.0 RC1 Windows native validation remains a separate release gate. HMR development does not modify the frozen candidate or create `v0.21.0`.
