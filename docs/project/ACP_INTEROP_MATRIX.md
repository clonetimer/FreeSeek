# FreeSeek ACP v1 Interoperability Matrix

Updated: 2026-08-20
Release line: `0.19`
RC gate: **two independently implemented ACP Clients must execute against FreeSeek; FreeSeek-owned raw drivers never count toward this number.**

## 1. Protocol target

FreeSeek 0.19 targets **stable ACP wire protocol v1 over stdio**. HTTP/WebSocket transport is deliberately outside the 0.19 stable scope.

The M4 gate distinguishes three evidence classes:

1. **Unit/contract tests** — prove FreeSeek internals and exact error semantics.
2. **Raw conformance driver** — process-level NDJSON test owned by FreeSeek; proves wire framing/lifecycle but is **not independent interoperability evidence**.
3. **Independent ACP Client** — a separately implemented client/SDK/editor drives the FreeSeek subprocess. Only this class counts toward the RC interoperability gate.

## 2. Current matrix

| Client / driver | Implementation owner | Independence class | Field result | Counts toward RC 2-client gate |
| --- | --- | --- | --- | --- |
| FreeSeek `scripts/acp-conformance.mjs` | FreeSeek | Internal raw conformance | PASS: 15/15 process-level checks | **No** |
| Official TypeScript SDK 1.3.0 | agentclientprotocol | External SDK client | **PASS** on Windows beta.7: initialize/new/prompt/sessionUpdate + `additionalDirectories` + resume | **Yes** |
| OpenClaw acpx 0.13.0 | openclaw | External CLI client | **PASS** on Windows beta.7: initialize/new/prompt/sessionUpdate | **Yes** |

**Independent-client count: `2 / 2` — protocol interoperability was field-proven on the 0.19 beta.7 line.**

For **0.20 Desktop RC promotion**, these clients must be rerun against the exact candidate commit. The evidence wrapper now records `freesekVersion` + `gitCommit`, and the gate accepts `--expected-version` + `--expected-commit`; historical beta.7 reports therefore remain baseline evidence but cannot be reused as final 0.20 candidate evidence.

The beta.7 validation wrapper invoked the gate as `report-a report-b --min-clients 2`. The old parser filtered only `--*` tokens and therefore misclassified the following value `2` as a third report path. Importantly, the gate output had already accepted both external reports and recognized the official SDK's advanced evidence before failing on the nonexistent file named `2`. RC.1 fixes this option parser and regression-locks the documented invocation shape.

Sanitized field evidence is retained in `docs/project/evidence/ACP_INTEROP_WINDOWS_BETA7_FIELD_EVIDENCE.json`.

## 3. Evidence contract for external clients

`npm run acp:interop -- ...` is an evidence wrapper, not a client implementation. It provides an external driver with:

- `FREESEEK_ACP_AGENT_COMMAND`
- `FREESEEK_ACP_AGENT_ARGS_JSON`
- `FREESEEK_ACP_WORKSPACE`
- `FREESEEK_ACP_SESSION_DIR`

The driver must use an independent ACP client implementation, exercise at least `initialize → session/new → session/prompt`, observe at least one `session/update`, and emit an evidence object with implementation provenance:

```json
{
  "freesekAcpInterop": 1,
  "implementationOwner": "agentclientprotocol",
  "implementationId": "typescript-sdk",
  "clientVersion": "1.3.0",
  "initialize": true,
  "newSession": true,
  "prompt": true,
  "sessionUpdate": true,
  "advancedCapabilities": ["additionalDirectories", "resume"]
}
```

The wrapper rejects a plain exit-code-0 process, missing provenance, or missing `session/update`, so a no-op or FreeSeek-authored raw client cannot be recorded as interoperability evidence.

After collecting reports, run:

```bash
npm run acp:interop:gate -- report-client-a.json report-client-b.json
```

The gate requires two distinct `implementationOwner/implementationId` pairs and at least one non-baseline capability.

## 4. Minimum RC interoperability evidence

For each of two independent clients, retain:

- exact client name/version/source;
- FreeSeek Git commit and version;
- invocation command/config;
- protocol version negotiated;
- `initialize`, `session/new`, `session/prompt` success;
- at least one `session/update` observation;
- process exit/result;
- client stdout/stderr tail or native ACP logs;
- whether permissions/elicitation/additionalDirectories were exercised.

At least one client should also exercise a non-baseline capability (`session/resume`, permission, elicitation, mode, or additional directory) before RC.

## 5. Explicit non-evidence

The following do **not** satisfy the independent-client gate:

- a second FreeSeek-authored raw JSON-RPC script;
- unit tests that instantiate `NdJsonRpcPeer` in memory;
- a mock that only checks stdout is JSON;
- a client that never sends a real `session/prompt` turn;
- successful process startup without ACP handshake evidence.
