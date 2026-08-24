# FreeSeek 0.19.0-beta.5 Candidate Validation Record

Date: 2026-08-20

Baseline tag: `v0.19.0-beta.4`

Candidate: `0.19.0-beta.5` (untagged until Windows revalidation)

## Windows beta.4 field evidence

The Windows validation environment successfully completed `npm ci` and `npm run check` (8/8), then exposed three cross-platform failures in the full regression suite:

1. `restoreCheckpoint` materialized `working-change\n` as `working-change\r\n`.
2. `materializeCheckpoint` materialized `historical\n` as `historical\r\n`.
3. Remote sandbox symlink containment could not create a directory symlink because Windows returned `EPERM`.

The first two failures were caused by the shadow Git repository inheriting the user's global `core.autocrlf`; this is a product behavior drift, not merely a brittle assertion.

## Fix

- `ensureCheckpointStore` configures the shadow repository with `core.autocrlf=false`.
- The checkpoint regression sets a temporary global Git config with `core.autocrlf=true` and verifies rewind remains byte-stable for the LF fixture.
- The Remote Sandbox symlink regression skips only when the platform rejects symlink creation with `EPERM`, `EACCES`, or `ENOTSUP`; otherwise realpath containment remains mandatory.

## Candidate gates

- `npm run check`: **8/8 PASS**.
- `npm test`: **349/349 PASS, 0 FAIL** in the local verification environment.
- `npm run acp:conformance`: **15/15 PASS**.

## Promotion decision

Do **not** create `v0.19.0-beta.5` yet. Re-run the Windows field validation from this candidate commit first. If Windows regression exits 0, the same commit can be tagged `v0.19.0-beta.5` without further source changes.
