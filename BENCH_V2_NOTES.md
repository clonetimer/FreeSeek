# Bench v2 / Holdout / Real Repo implementation notes

This increment changes FreeSeek benchmark development from one public fixture suite to three layers:

1. `benchmarks/v1`: fast public deterministic regression.
2. external `visibility=private` v2 packs: holdout tasks whose raw traces and case metadata are not persisted by default.
3. `benchmarks/real-v1`: historical public repositories pinned to immutable base/gold Git SHAs.

Key implementation modules:

- `src/bench-source.ts`: local/git source validation, immutable materialization, bare cache, offline replay.
- `src/bench-validate.ts`: pristine-fail / gold-pass static validation for local overlays and Git gold commits.
- `src/bench-private.ts`: repository-external private holdout scaffold.
- `src/bench.ts`: v1/v2 manifest loading, source-aware fingerprinting, private report redaction.
- `src/eval.ts`: trusted host-side Node verifier type.
- `src/bench-cli.ts`: `--real`, `--offline-sources`, `--source-cache`, `--trust-suite`, `init-holdout`.

Security invariants:

- v2 uses `source`; local source paths are manifest-relative and containment checked.
- Git refs must be full 40/64-hex immutable SHAs; only HTTPS/file transports are accepted by the generic loader.
- built-in real-v1 is additionally gated to HTTPS by `npm run check`.
- host verifiers must remain outside Agent workspaces.
- external host/command verifiers require explicit trust.
- private reports are share-safe by default and private traces are deleted unless explicitly retained.
- private packs must not live under `benchmarks/private` or `.freesek-holdout` in the public/release tree.
