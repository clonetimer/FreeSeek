# FreeSeek 0.20 Desktop Native Validation Runbook

Updated: 2026-08-21
Scope: **native evidence execution only**. The Desktop code/release workflow must already be frozen and committed.

## 1. What this runbook is for

The repository owns the validation logic. A Windows/macOS operator supplies only native inputs that cannot be
manufactured in a Linux CI/container environment:

- official Electron release archive for the pinned version and the matching official `SHASUMS256.txt`;
- an OS-protected secret backend available to Electron `safeStorage`;
- Windows Authenticode certificate/private-key access, or Apple Developer signing/notarization access;
- the public production Desktop signing-policy identities;
- for Linux release authentication, the repository-external Ed25519 signing key/public key;
- the previous Desktop artifact used for upgrade/rollback evidence.

Do **not** edit evidence JSON by hand. A failed command is a failed gate; fix the platform/input and rerun it.

## 2. Fixed release targets for the first 0.20 release

The current release process supports these target forms:

- Linux: productized portable stage -> `.tar.gz`;
- Windows: productized portable stage -> `.zip`;
- macOS: productized `FreeSeek.app` portable stage -> `.zip`.

The exact target set used for RC must be identical at Stable promotion. If a target, Electron pin or signing policy
changes after an audited RC, create a new RC.

## 3. One-time first-RC baseline (`0.20.0-dev.3`)

The first standalone Desktop RC has no previous Desktop Stable artifact. Before applying RC metadata, create one
**non-release-eligible** previous artifact on each target. It exists only to prove upgrade/rollback behavior.

On the clean committed `0.20.0-dev.3` tree:

```text
npm run desktop:native:preflight -- \
  --electron-archive <official-electron-zip> \
  --electron-shasums <official-SHASUMS256.txt> \
  --arch <x64|arm64> \
  --out <work>/dev3-preflight
```

The preflight performs production build, official Electron checksum verification/extraction, exact development
smoke, productized packaged smoke and real `safeStorage` verification. It must not use Electron mismatch or
`--no-sandbox` waivers.

Then create the previous artifact from the exact preflight stage:

```text
npm run desktop:native:installer:baseline -- \
  --stage <work>/dev3-preflight/stage/FreeSeek-0.20.0-dev.3-<platform>-<arch> \
  --native-preflight <work>/dev3-preflight/native-target-preflight.json \
  --arch <x64|arm64> \
  --out <work>/FreeSeek-0.20.0-dev.3-<platform>-<arch>.<tar.gz|zip> \
  --evidence-out <work>/dev3-installer-baseline.json
```

The baseline report must contain `releaseEvidenceEligible=false`. Never publish it as an RC/Stable artifact.

## 4. Freeze signing identities before RC artifact creation

Create the public signing policy from identities, not from private credentials:

```text
npm run desktop:signing:policy:create -- \
  --policy-id <immutable-policy-id> \
  --linux x64=<ed25519-public.pem> \
  --windows x64=<authenticode-certificate-sha256> \
  --macos arm64=<APPLE_TEAM_ID> \
  --out <release>/desktop-signing-policy.json
```

Include only targets actually released. The generator derives the Linux Ed25519 SPKI SHA-256, normalizes the
Windows certificate fingerprint, validates the Apple Team ID and never accepts a private key.

## 5. Prepare and commit the RC metadata

First dry-run:

```text
npm run desktop:rc:prepare -- --version 0.20.0-rc.1
```

Only after the native inputs above are available and the plan is reviewed:

```text
npm run desktop:rc:prepare -- --version 0.20.0-rc.1 --apply
```

Review and commit the synchronized metadata. Do **not** tag yet. The resulting full Git commit is the evidence
identity. Any blocker fix after that commit invalidates candidate-bound evidence.

## 6. Per-target RC preflight and final artifact

Run on the target OS from the clean RC commit:

```text
npm run desktop:native:preflight -- \
  --electron-archive <official-electron-zip> \
  --electron-shasums <official-SHASUMS256.txt> \
  --arch <x64|arm64> \
  --out <work>/rc-preflight
```

Before packaging on Windows/macOS, sign/notarize the productized stage using the identity authorized by the
signing policy. Linux release authentication is intentionally deferred to the provenance-bound Ed25519 update
manifest.

Then package:

```text
npm run desktop:native:package -- \
  --stage <work>/rc-preflight/stage/FreeSeek-0.20.0-rc.1-<platform>-<arch> \
  --native-preflight <work>/rc-preflight/native-target-preflight.json \
  --signing-policy <release>/desktop-signing-policy.json \
  --arch <x64|arm64> \
  --out <release>/FreeSeek-0.20.0-rc.1-<platform>-<arch>.<tar.gz|zip> \
  --evidence-out <work>/native-target-artifact.json
```

This command re-verifies native signing where applicable, reruns packaged+secureStorage smoke after signing,
runs forced-termination packaged recovery, then creates the final portable artifact.

## 7. Central release provenance and signed update manifest

After collecting final artifacts and their stage manifests from all targets, generate release evidence on the exact
clean RC commit:

```text
npm run desktop:release:evidence -- \
  --artifact <platform>/<arch>=<artifact> ... \
  --stage-manifest <platform>/<arch>=<stage>/freesek-release-manifest.json ... \
  --signing-policy <release>/desktop-signing-policy.json \
  --out <release>/evidence
```

Then create and sign the update manifest:

```text
npm run desktop:update:manifest -- \
  --provenance <release>/evidence/freesek-desktop-provenance.json \
  --base-url https://<release-host>/<version>/ \
  --channel rc \
  --issued-at <ISO-8601> \
  --expires-at <ISO-8601> \
  --out <release>/update-rc.json

npm run desktop:update:sign -- \
  --manifest <release>/update-rc.json \
  --private-key <repository-external-ed25519-private-key> \
  --out <release>/update-rc.json.sig
```

The private key must remain outside the repository. On POSIX systems the signing command rejects a private key
that is readable by group/other.

## 8. Per-target post-provenance native evidence bundle

Run on each target OS using the exact final artifact, exact stage and the previous baseline/artifact:

```text
npm run desktop:native:evidence -- \
  --provenance <release>/evidence/freesek-desktop-provenance.json \
  --artifact <release>/<current-artifact> \
  --previous-artifact <previous-artifact> \
  --stage <work>/rc-preflight/stage/<stage-dir> \
  --signing-policy <release>/desktop-signing-policy.json \
  --native-preflight <work>/rc-preflight/native-target-preflight.json \
  --dev-smoke <work>/rc-preflight/dev-smoke.json \
  --packaged-smoke <current-artifact>.packaged-smoke.json \
  --recovery-smoke <current-artifact>.recovery-smoke.json \
  --arch <x64|arm64> \
  --out <work>/native-evidence
```

Linux additionally requires:

```text
  --manifest <release>/update-rc.json \
  --signature <release>/update-rc.json.sig \
  --public-key <ed25519-public.pem>
```

The output directory is canonical and contains:

- `native-target-evidence.json`;
- `native-preflight.json`;
- `dev-smoke.json`;
- `packaged-smoke.json`;
- `recovery-smoke.json`;
- `signing-evidence.json`;
- `installer-evidence.json`.

The installer evidence is produced by the fixed repository adapter and proves fresh install, uninstall, upgrade and
rollback from the final artifact. Windows/macOS signing evidence also binds the signed executable SHA-256 to the
executable measured after installation.

## 9. Candidate-bound ACP interoperability

Rerun the two independent ACP clients against the exact RC commit. Historical beta evidence is not sufficient.
Each report must contain the exact FreeSeek version and full Git commit. Then run:

```text
npm run acp:interop:gate -- \
  <client-a-report.json> <client-b-report.json> \
  --expected-version 0.20.0-rc.1 \
  --expected-commit <40-hex-rc-commit>
```

## 10. RC aggregate gate

Pass each per-target bundle rather than manually assembling report paths:

```text
npm run desktop:rc:evidence:gate -- \
  --provenance <release>/evidence/freesek-desktop-provenance.json \
  --signing-policy <release>/desktop-signing-policy.json \
  --native-target-bundle <windows-bundle-dir> \
  --native-target-bundle <macos-bundle-dir> \
  --native-target-bundle <linux-bundle-dir> \
  --interop-report <client-a-report.json> \
  --interop-report <client-b-report.json>
```

Do not tag unless the result is exactly `passed=true`, `rcEligible=true`, `preflightOnly=false`.

## 11. Stable promotion after an audited RC

The audited RC tag must already exist and point to the current RC HEAD. Dry-run Stable metadata preparation:

```text
npm run desktop:stable:prepare -- \
  --version 0.20.0 \
  --rc-summary <audited-rc-aggregate.json>
```

After review, run again with `--apply`, commit the Stable metadata candidate, regenerate candidate-bound evidence,
and execute the native lifecycle again with `previous-artifact=<audited RC artifact>`.

Finally run:

```text
npm run desktop:stable:evidence:gate -- \
  --rc-summary <audited-rc-aggregate.json> \
  --stable-preflight <stable-aggregate-preflight.json> \
  --installer-report <stable-target-installer.json> ...
```

Tag `v0.20.0` only when `stableEligible=true`.

## 12. Fail-closed rules for local operators

- Do not use Electron version mismatch or `--no-sandbox` waivers for release evidence.
- Do not hand-edit evidence JSON or copy reports from a different commit/version.
- Do not bypass official Electron `SHASUMS256.txt` verification.
- Do not substitute Linux `basic_text` for OS-protected `safeStorage` evidence.
- Do not use an unauthorized certificate/Team ID/Ed25519 key even if its signature is otherwise valid.
- Do not repackage or modify a final artifact after provenance generation.
- Any blocker fix after the RC evidence commit invalidates affected commit-bound evidence.
