# FreeSeek 0.20 D4 → Desktop Stable Development Plan

Updated: 2026-08-21
Current branch: `dev/0.20`
Current phase: **Standalone Desktop Host / Desktop Stable code-complete, native-evidence-pending**

## 1. Non-negotiable architecture boundary

FreeSeek 0.20 develops an independent Desktop application surface, not a second Agent implementation:

```text
Electron Renderer
  -> sandboxed preload/contextBridge IPC
  -> Electron main / DesktopRuntime
  -> ACP sidecar
  -> shared FreeSeek 0.19 Kernel / ToolRegistry / ToolRuntime / EventLog
```

The stable Kernel reference remains `v0.19.0 / c52af8f9470c8c0d6039dc612e6e5013ca57c0be`.
General HMR remains deferred until Desktop Stable.

## 2. Convergence workstreams

| Workstream | Goal | Current status | Promotion condition |
| --- | --- | --- | --- |
| P1 Update trust/publication | Signed update metadata is bound to final release provenance and exact artifacts | **Code complete** | Final RC provenance + manifest v2 + Ed25519 signature generated on candidate |
| P2 Installer/rollback policy | Crash-safe upgrade state and explicit rollback responsibility | **Portable distribution driver code complete** | Native per-target final artifact evidence proves fresh install + uninstall + upgrade + rollback |
| P3 RC evidence aggregation | One gate rejects mixed commits, compatibility-only runtime evidence and missing platform evidence | **Code complete** | `desktop:rc:evidence:gate` returns `rcEligible=true` on RC candidate |
| P4 Platform evidence acquisition | Exact Electron/runtime, secureStorage, signing and installer execution | **Code/workflow complete; native evidence pending** | Every release target has real packaged evidence; no mismatch/no-sandbox waiver |
| P5 RC candidate promotion | Freeze code and produce `0.20.0-rc.1` candidate artifacts/evidence | **Code complete; not executed** | All P4 inputs available; metadata dry-run reviewed; candidate-bound evidence regenerated on the committed RC |
| P6 Desktop Stable | Promote tested RC to `0.20.0` | **Code complete; execution blocked on audited RC/native evidence** | `desktop:stable:evidence:gate` returns `stableEligible=true` after exact RC→Stable native lifecycle evidence |

## 3. P1 — Update trust/publication

Implemented:

- signed update manifest schema v2 requires a release-provenance HTTPS URL, SHA-256 and byte size;
- provenance verification requires clean Git state, exact version, valid commit, exact target set and artifact digest/size equality;
- `verifyDesktopUpdateCandidate` verifies signature -> provenance -> selected artifact before callers persist high-water state or invoke an installer;
- `desktop:update:manifest` constructs the unsigned manifest from clean release provenance;
- `desktop:update:sign` signs exact manifest bytes with an Ed25519 private key outside the repository and rejects group/other-readable POSIX key files;
- existing channel, freshness, anti-rollback, equivocation, HTTPS, unique-target and streaming artifact hash controls remain in force;
- release provenance now binds an explicit target signing policy by `policyId + SHA-256 + byte size`; aggregate RC evidence rejects valid-but-unauthorized signers by comparing Linux Ed25519 key fingerprint, Windows Authenticode certificate fingerprint or macOS Apple Team ID to that bound policy.

Still execution inputs, not source-code gaps:

- production signing-policy identity values and access to the real platform/private signing credentials; custody and rotation procedure is documented in `DESKTOP_SIGNING_OPERATIONS.md`;
- actual final RC provenance/update-manifest publication and CDN/channel promotion.

## 4. P2 — Installer/rollback

Implemented platform-neutral state machine:

```text
staged -> installing -> awaiting-health -> confirmed
                    \-> rollback-required -> rolled-back
```

Crash during `installing`, or expiry of the post-update health deadline, becomes `rollback-required` rather than being silently forgotten. The atomic journal contains only version/target and cryptographic evidence identifiers; it does not execute installers or contain credentials.

Implemented distribution/adapter contract:

- 0.20 uses native portable archives rather than introducing an additional packaging framework: Linux `.tar.gz`, Windows/macOS `.zip`;
- packaging must execute on the target OS from the productized exact-Electron stage;
- the formal native installer evidence runner starts from the final provenance-bound artifact, executes fresh install + uninstall + upgrade + rollback through the fixed adapter, and re-measures installed stage/executable digests; arbitrary installer commands are not accepted;
- the RC gate requires the fixed installer kind and `nativePlatformVerified=true`, so directory-swap preflight reports cannot satisfy RC.

Still required:

- execute the formal runner against final Windows/macOS/Linux candidate artifacts on each corresponding native OS;
- retain `freesek-desktop-installer-rollback-evidence` per final release target;
- transactional portable uninstall is implemented and now exercised by formal installer evidence; final Stable promotion still needs native per-target execution plus RC-to-Stable upgrade regression.

## 5. P3 — Candidate-bound RC evidence gate

Implemented aggregate gate checks:

- release provenance version + Git commit equal the current candidate;
- exact Electron development smoke has no version mismatch or `--no-sandbox` waiver;
- every release target has productized `app.isPackaged=true` smoke bound to the exact stage-manifest SHA;
- secureStorage is actually exercised and rejects `basic_text` as RC secret evidence;
- every target has matching signing/notarization evidence whose signer identity matches the release-bound signing policy, plus installer upgrade/rollback evidence;
- two independent ACP clients are rerun with reports bound to the exact FreeSeek version + Git commit;
- development versions can only run `--allow-non-rc` preflight and always report `rcEligible=false`;
- per-target `desktop:native:preflight -> desktop:native:package -> desktop:native:evidence` workflow verifies the official Electron archive checksum, exact candidate commit, post-signing packaged/secureStorage smoke, forced-termination recovery, signer identity and install/uninstall/upgrade/rollback, then emits a canonical native evidence bundle accepted directly by the aggregate gate.

## 6. P4 — Remaining native/external evidence inputs

All repository-side workflow is implemented. Follow `DESKTOP_NATIVE_VALIDATION_RUNBOOK.md`; remaining work is execution on the real target OSes and release accounts.

Priority order:

1. Obtain **Electron 43.3.0** distributions and rerun development + packaged smoke with no mismatch waiver.
2. Run productized packaged smoke on Windows and macOS, including `FREESEEK_DESKTOP_E2E_VERIFY_SECRET=1`; retain evidence files with `FREESEEK_DESKTOP_E2E_EVIDENCE_OUT`.
3. Execute the now-fixed native portable distribution adapters against final artifacts: Linux `.tar.gz`, Windows/macOS `.zip`. The formal runner must execute on the target OS, start from the provenance-bound artifact, and emit candidate-bound installer evidence including installed stage-manifest and main-executable digests. The older directory-swap preflight remains non-RC.
4. Freeze the production Desktop signing policy, then execute the implemented native-only collectors: Windows `Get-AuthenticodeSignature` and macOS `codesign` + `stapler` + `spctl`, each against the policy-authorized signer identity and exact staged executable. Linux signature verification already enforces a provenance-bound Ed25519 update-manifest chain plus authorized public-key fingerprint and must be executed against the final RC artifact with production key material. Windows/macOS collector implementation is complete, but native evidence is still pending.
5. Rerun Official ACP TypeScript SDK and OpenClaw acpx against the exact candidate commit; historical beta.7 evidence remains baseline interoperability evidence, not final 0.20 candidate evidence.

## 7. P5 — RC promotion sequence

Do not tag RC before evidence exists. `desktop:rc:prepare` now provides a guarded metadata transition: it is dry-run by default, requires a clean committed worktree on the active development branch, rejects an already-existing target tag, allows only `dev.N -> rc.1` / `rc.N -> rc.N+1`, and never commits or tags automatically.

1. Freeze blocker-only code changes and ensure P4 platform inputs are actually available.
2. Run `npm run desktop:rc:prepare -- --version 0.20.0-rc.1` and review the dry-run plan.
3. Only after review, run the same command with `--apply`, review the synchronized version diff, and commit that metadata as the untagged RC candidate.
4. Treat the resulting full Git commit as the evidence identity; any blocker fix creates a new commit and invalidates commit-bound evidence.
5. Run repository gates and production ACP conformance.
6. Build final Desktop artifacts with exact Electron 43.3.0.
7. Freeze/review Desktop signing policy, then generate clean release provenance + SHA256SUMS bound to that exact policy.
8. Build provenance-bound update manifest v2 and sign exact bytes.
9. Run real dev/package/secureStorage/signing/installer evidence on every target.
10. Rerun two independent ACP clients against the same candidate commit. Both the Desktop aggregate gate and the legacy release artifact gate require exact version + commit binding.
11. Run `desktop:rc:evidence:gate`; require `passed=true` and `rcEligible=true`.
12. Only then create/publish the RC tag and channel artifacts.

Any blocker fix after the audited candidate must invalidate and regenerate commit-bound evidence.

## 8. P6 — Stable promotion

The Stable metadata gate (`desktop:stable:prepare`) and promotion gate (`desktop:stable:evidence:gate`) are implemented. `desktop:stable:prepare` is dry-run by default and requires the audited immutable direct-RC tag to point at current HEAD plus a matching `rcEligible=true` aggregate report. Neither gate can complete release promotion until a real audited RC exists. Stable promotion requires all of the following:

1. an already audited direct predecessor `0.20.0-rc.N` whose RC aggregate report has `passed=true`, `rcEligible=true`, and `preflightOnly=false`;
2. a fresh Stable candidate aggregate preflight on the exact `0.20.0` commit with `passed=true`, while remaining non-RC/preflight-only;
3. unchanged Electron pin, Desktop signing policy identity/SHA-256, and exact release target set between RC and Stable; any drift requires a new RC;
4. candidate-bound independent ACP interoperability on the Stable commit;
5. exactly one formal native installer report per target proving **fromVersion = audited RC version** and fresh install + uninstall + upgrade + rollback on the Stable artifact.

Only after `desktop:stable:evidence:gate` returns `passed=true` and `stableEligible=true` may release engineering:

- merge the audited candidate to `main`;
- regenerate final provenance/update metadata/signatures as required by the final commit;
- archive `changes/unreleased`;
- update `stableBaseline`;
- create immutable `v0.20.0` tag.

The gate prevents an RC from being treated as a one-time checkbox: a Stable build that changes Electron, signer policy, release targets, or skips the actual RC→Stable native lifecycle must return to RC. General HMR work starts only after this Desktop Stable boundary.
