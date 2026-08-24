# FreeSeek Desktop Signing Operations

Updated: 2026-08-21
Status: release-operator policy; private signing material must stay outside the repository.

## 1. Trust identities

FreeSeek 0.20 release provenance binds a public `freesek-desktop-signing-policy` file. Each released target has
exactly one authorized identity:

- Linux: Ed25519 **public-key SPKI SHA-256** for the detached update-manifest signature;
- Windows: Authenticode signer certificate **SHA-256**;
- macOS: Apple Developer **Team ID**, with notarization required.

A cryptographically valid signature from another identity is a release failure.

## 2. Private material

- Never place a private key, PFX/P12, certificate password, Apple API key or notarization credential in Git.
- Use OS/native credential stores, CI protected secrets, hardware-backed keys or an equivalent access-controlled
  signer where available.
- Limit release-signing access to designated release operators.
- Keep public certificates/public keys and fingerprints reviewable; only private material is secret.
- On POSIX, Ed25519 private-key files used by `desktop:update:sign` must not be readable by group/other.

## 3. Policy freeze

Before RC artifacts are finalized:

1. determine the exact release target set;
2. derive/record signer identities with `desktop:signing:policy:create`;
3. review the generated policy file out-of-band;
4. freeze its `policyId`, bytes and SHA-256 for the RC line;
5. generate release provenance using that exact policy.

Changing any target signer identity or policy bytes after an audited RC requires a **new RC**. Stable promotion
intentionally rejects signing-policy drift.

## 4. Rotation

Routine rotation is performed between release lines, not by silently changing the signer during an audited RC:

1. provision the new signer and retain the old public identity/evidence for audit;
2. create a new policy ID and policy file containing the new identity;
3. generate a new RC using that policy;
4. rerun all signing/native/install evidence and candidate-bound ACP evidence;
5. publish only after the RC aggregate gate accepts the new policy.

Emergency rotation after compromise invalidates the affected candidate. Revoke/disable the compromised private
credential through the platform provider, create a new policy identity, and issue a new candidate/RC. Do not
rewrite an already-audited evidence file to point at a replacement signer.

## 5. Platform execution

### Windows

Sign the productized `FreeSeek.exe`/distribution using the authorized Authenticode certificate. The repository
collector calls `Get-AuthenticodeSignature` and requires status `Valid`, the authorized certificate SHA-256 and an
executable digest that later matches the installed payload.

### macOS

Sign the productized `FreeSeek.app` using the authorized Apple Team ID, submit for notarization, staple the ticket,
and ensure Gatekeeper accepts it. The repository collector verifies `codesign --deep --strict`, Team ID,
`stapler validate` and `spctl --assess`.

### Linux

The portable stage is not required to have an OS code-signing wrapper. Release authentication is the detached
Ed25519 signature over the exact update-manifest bytes. That manifest binds release provenance, which binds the
Linux artifact digest and signing-policy public-key fingerprint.

## 6. Evidence retention

Retain with each published RC/Stable release:

- public signing policy and SHA-256;
- release provenance and `SHA256SUMS.txt`;
- signed update manifest and detached signature;
- platform signing evidence;
- native target evidence bundles;
- exact commit-bound ACP interoperability reports;
- RC/Stable aggregate gate summaries.

Never archive private signing keys inside the release evidence bundle.
