# FreeSeek Real Repo v1

This public benchmark pack uses **historical merged pull requests** from small MIT-licensed repositories. FreeSeek stores only immutable source coordinates, task metadata, and its own verifier scripts. Repository source code is fetched into the local benchmark cache at runtime and is not redistributed in this package.

Cases:

- `escape-string-regexp-unicode-hyphen` — `sindresorhus/escape-string-regexp` PR #21, base `5085b257…`, gold `b58ff74f…`.
- `p-defer-unbound-method-typing` — `sindresorhus/p-defer` PR #9, base `0abf7f56…`, gold `ba017633…`.
- `is-stream-http-instances` — `sindresorhus/is-stream` PR #21, base `6913e344…`, gold `57f01fe7…`.

Run `freeseek-bench validate --real --gold` before using a newly populated cache. Use `--offline-sources` in CI after prewarming the cache.
