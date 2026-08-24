# FreeSeek 0.20 Desktop Threat Model

Status: **Desktop Stable code-complete / native-evidence-pending — final RC blocker review**
Baseline: FreeSeek `v0.19.0` Kernel remains frozen; Desktop is an ACP client/host, not a second Agent.

## 1. Security objective

FreeSeek Desktop must add a standalone Electron presentation host without weakening the 0.19 Kernel,
ToolRuntime, permission, EventLog or ACP boundaries. Desktop owns UI, local host configuration and process
lifecycle only. Agent execution remains behind the ACP sidecar.

The required dependency direction is:

`Renderer -> preload IPC -> Electron main -> DesktopRuntime -> ACP child -> shared Kernel`

The renderer must never gain raw filesystem/process access and Desktop code must never import Agent,
ToolRuntime, ToolRegistry or raw Tools to reimplement execution locally.

## 2. Protected assets

| Asset | Security property |
| --- | --- |
| Provider API keys | Confidentiality; transient renderer input only, never persisted as plaintext or exposed in ACP argv |
| MCP environment secrets | Confidentiality; not persisted in ordinary Desktop settings |
| Workspace files/artifacts | Root confinement; no traversal/symlink escape from authorized roots |
| Durable session/EventLog | Integrity; loaded through ACP/Kernel contracts, not reinterpreted as a Desktop database |
| Permission/elicitation decisions | Integrity and user intent; rendered by Desktop but enforced by shared Runtime policy |
| ACP sidecar | Integrity and provenance; one bundled FreeSeek sidecar, not a Desktop-specific Agent copy |
| Update manifest/artifacts | Authenticity, freshness, anti-rollback and byte integrity |
| Recovery marker | Integrity/minimization; contains only session/workspace/timestamp/in-flight state |

## 3. Adversaries and relevant failures

1. **Malicious workspace content** attempting path traversal, symlink escape, renderer injection or unsafe artifact opening.
2. **Compromised renderer/XSS** attempting privileged IPC calls, navigation to attacker-controlled content, filesystem/process access or secret extraction.
3. **Untrusted/misconfigured MCP server** attempting to place secrets in normal settings or expand execution authority outside the shared Runtime policy.
4. **Local same-user process** inspecting child command lines, environment, Desktop files or crash artifacts.
5. **Tampered update/CDN/release artifact** attempting signature bypass, rollback, replay/equivocation or target substitution.
6. **Crash/interruption** leaving an in-flight session marker that could be stale, malformed or pointed at another workspace.
7. **Packaging drift** causing Desktop to launch a stale/wrong ACP implementation or depend on a system Node installation.

## 4. Trust boundaries and controls

### 4.1 Renderer -> preload -> Electron main

Implemented controls:

- `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`, `webviewTag=false`;
- production DevTools disabled;
- CSP denies remote connections, object/frame embedding, form targets and inline/eval script execution;
- navigation is restricted to the exact local Desktop entry URL, not arbitrary `file://` content;
- every IPC handler verifies both the owning `webContents` and exact Desktop entry URL;
- preload exposes only the narrow `freesekDesktop` bridge; no raw `fs`, `child_process` or Runtime objects.

Residual risk before RC:

- Linux real BrowserWindow and productized portable compatibility paths have been exercised on Electron 43.2.0; exact pinned 43.3.0 RC evidence is still required;
- crash dump/log review must confirm no secret-bearing diagnostics are emitted.

### 4.2 Electron main -> ACP sidecar

Implemented controls:

- Desktop launches exactly one ACP host and never imports Agent/ToolRuntime/Tools;
- production packaging resolves the ACP entry under `resources/freeseek/sidecar/freeseek-acp.js`;
- packaged sidecar is executed by the Electron executable with `ELECTRON_RUN_AS_NODE=1`, avoiding a system Node dependency;
- provider API key is removed from process argv and supplied through the child environment using the existing ACP `FREESEEK_API_KEY` contract;
- ACP launch strips inherited/sidecar-env `FREESEEK_API_KEY` values and injects a credential only when the current Desktop request explicitly supplies one;
- main-process active scope no longer retains the secret-bearing start request after launch.

Accepted residual risk:

- environment variables may still be observable by sufficiently privileged local processes on some OSes.
  This is narrower than argv exposure and reuses the stable ACP contract. Replacing it with a new private
  Desktop transport is **not** justified for 0.20 because that would create host-specific Agent plumbing.

### 4.3 Local secrets

Implemented controls:

- persistent provider secrets are stored only through Electron `safeStorage` in the main process;
- a one-time provider key necessarily exists transiently in the renderer input while the user enters it, but the renderer does not persist it and clears the field immediately when a credential-consuming IPC request is constructed;
- Linux `basic_text` backend is treated as insecure and fails closed;
- persisted settings remove Provider API keys and MCP environment values;
- secret envelopes are provider-bound and malformed/mismatched data is ignored.

RC blockers:

- collect successful OS-protected secret-store evidence on Windows and macOS;
- document expected Linux backend behavior for supported desktop environments.

### 4.4 Workspace/artifact access

Implemented controls:

- artifact access is main-process only;
- paths are resolved with `realpath` and must remain inside explicit authorized roots;
- symlink escapes are rejected;
- previews are bounded and NUL-containing binary files are not decoded as ordinary text;
- this is artifact preview/open support, **not** a second editor or `diffReview` implementation.

### 4.5 Recovery

Implemented controls:

- recovery journal is atomic and minimal: `sessionId`, absolute `workspace`, `updatedAt`, `inFlight`;
- corrupt, stale, relative-path or non-in-flight state is rejected;
- recovery is manual and re-enters through ACP `session/load`; Desktop does not replay EventLog itself;
- clear is idempotent.

RC evidence requirement:

- `desktop:recovery:smoke` now performs a real packaged in-flight turn -> forced process-tree termination -> marker survival -> relaunch -> same-session recovery -> marker-clear sequence. The code/gate is complete; each release target must still execute it natively on the final candidate.

### 4.6 Update trust

Implemented verifier foundation:

- update manifest URL and every artifact URL must use HTTPS and contain no embedded credentials;
- exact manifest bytes require a detached Ed25519 signature; schema v2 also binds the HTTPS release-provenance URL, provenance SHA-256 and byte size;
- release channel can be bound to the caller's expected channel;
- version must be newer than the running version;
- `issuedAt` / `expiresAt` freshness is enforced;
- accepted high-water state rejects rollback and same-version equivocation;
- byte-identical replay is explicitly idempotent;
- each `platform/arch` target may appear only once and the current host must select exactly one artifact;
- downloaded provenance must describe a clean committed release, exact candidate version/targets and artifact digest/size equality;
- downloaded artifact is checked by exact size and streaming SHA-256 before any install step;
- the complete candidate verifier composes signature -> provenance -> target selection -> artifact verification before high-water persistence or installer orchestration;
- update publication is split into provenance-derived manifest generation and exact-byte Ed25519 signing with repository-external key material;
- release provenance cryptographically binds a public Desktop signing policy, and RC evidence must prove the platform signer identity matches the policy-authorized Ed25519 key fingerprint / Authenticode certificate fingerprint / Apple Team ID, preventing substitution with a different but otherwise valid signer.
- portable payloads embed the exact stage manifest; installer evidence must re-measure it from the installed payload, and Windows/macOS signing evidence must bind the signed executable SHA-256 to the executable actually installed, preventing valid-but-unrelated stage/artifact/signature evidence from being mixed.
- Stable promotion is fail-closed against RC evidence drift: the audited RC and Stable candidate must keep the same Electron pin, signing-policy identity/SHA-256 and release target set, and Stable requires new candidate-bound ACP interop plus per-target native evidence proving the exact audited RC -> Stable install/uninstall/upgrade/rollback lifecycle.
- RC metadata promotion is also fail-closed: preparation requires a clean active branch, synchronized version sources and an unused immutable target tag, only permits the next direct RC serial, defaults to dry-run, and never creates a commit/tag; release/ACP interop gates bind reports to the final candidate version + full commit.

Explicitly **not implemented/claimed yet**:

- automatic download/install;
- final platform execution of the fixed native portable distribution adapters; the adapter code now packages/extracts Linux `.tar.gz` or Windows/macOS `.zip` only on the corresponding OS and the formal runner measures installed payload identity plus fresh-install/uninstall/upgrade/rollback outcomes, but candidate RC evidence is still pending;
- transactional portable uninstall validates install state and payload digests before removing slots; tampered payloads fail closed instead of erasing forensic/update state;
- production signing-policy **identity values and credential/account execution**; custody/rotation procedure is now documented in `DESKTOP_SIGNING_OPERATIONS.md`;
- real Windows Authenticode and macOS codesign/notarization evidence; native-only collectors are implemented, but execution on the corresponding OS remains required;
- final Linux release evidence produced with the implemented Ed25519 manifest → provenance → artifact verifier.

These remaining items are native/release execution, not unfinished Desktop source workflow. Automatic update download/install remains an explicit 0.20 non-goal; the verifier foundation must not be described as a completed updater.

## 5. Packaging invariants

The D4 portable staging path must contain:

- one compiled Desktop application under Electron `resources/app`;
- one bundled ACP sidecar under `resources/freeseek/sidecar`;
- a productized executable (`FreeSeek` / `FreeSeek.exe` / `FreeSeek.app`) rather than an unrenamed Electron development executable;
- a release manifest containing Electron runtime version/pin status plus SHA-256 and size for critical Desktop/sidecar files;
- default rejection of an Electron distribution that does not match the pinned Desktop runtime; any explicit mismatch waiver is compatibility evidence only;
- no requirement for system Node in packaged execution.

Linux validation demonstrated why productization is a security/release invariant rather than branding only: an unrenamed `electron` executable left `app.isPackaged=false` and selected the development path. After productization, the same staged payload ran with `app.isPackaged=true` and resolved the bundled sidecar without repository overrides.

`desktop:build` remains a platform-neutral development build. `desktop:build:prod` is a separate release gate
that requires the production esbuild bundle plus the Desktop TypeScript build. A portable stage may be used
for smoke evidence, but it is not equivalent to a signed installer.

## 6. RC blockers / evidence still required

1. Re-run real Electron 43.3.0 BrowserWindow/preload/IPC/ACP E2E with the exact runtime pin and no mismatch waiver.
2. Re-run productized portable `app.isPackaged=true` smoke on Electron 43.3.0. Linux 43.2.0 compatibility evidence already passes but is not an RC gate.
3. Obtain Windows/macOS/Linux packaging and launch evidence; no cross-platform claim from Linux-only compatibility tests.
4. Obtain Windows/macOS OS-protected secret-store success evidence.
5. Define installer formats and freeze production signing identities/key custody. Signature mechanism is now fixed by target: Windows Authenticode, macOS codesign + notarization, Linux provenance-bound Ed25519 update-manifest verification; Windows/macOS real platform evidence and final Linux release execution remain open.
6. Execute the implemented provenance-bound update publication policy and guarded rollback journal against real platform installers; platform-specific installer execution remains open.
7. Execute the implemented Desktop release-evidence gate on final RC artifacts to generate `SHA256SUMS.txt` + provenance bound to clean Git commit and exact Electron 43.3.0 stage manifests.
8. Complete ACP independent-client interoperability RC gate already defined in `RELEASE_CHECKLIST.md`.
9. After a real RC passes, run the implemented Stable promotion gate against the exact `0.20.0` candidate; any Electron/signing-policy/target drift or missing native RC→Stable lifecycle evidence requires a new RC.

## 7. Explicit non-goals for 0.20 D4

- No General HMR/plugin runtime before Desktop Stable.
- No editor fork/IDE implementation.
- No Desktop-local Agent, ToolRuntime, permission engine or EventLog reader.
- No `diffReview=true` claim until a shared, authorized editing/review design exists.
- No automatic update install merely to satisfy a checklist; trust, rollback and platform evidence come first.
## Electron pin review (2026-08-20)

Electron 43.4.1 was reviewed after the project had pinned 43.3.0. The later release includes fixes around child-window sandbox inheritance and other browser/runtime edge cases. FreeSeek currently blocks all renderer-created child windows with `setWindowOpenHandler(() => ({ action: "deny" }))`, disables `<webview>`, loads only the local Desktop entry, and rejects navigation away from that exact entry. The packaged app also does not register remote/custom protocol content.

On the currently enabled Desktop surface, no reviewed 43.4.1 fix establishes a reachable vulnerability that requires invalidating the 43.3.0 convergence pin immediately. Therefore 43.3.0 remains the current exact-evidence target to avoid version churn. This is **not** a permanent exemption: the pin must be reviewed again immediately before RC evidence freeze, and any advisory affecting an enabled FreeSeek path requires a pin bump followed by regeneration of all Electron-bound smoke/stage/provenance evidence.
