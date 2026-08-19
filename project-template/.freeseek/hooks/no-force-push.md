---
name: block-force-push
enabled: true
event: bash
pattern: git\s+push.*--force|git\s+push\s+-f\b
action: block
---
禁止对共享分支执行强制推送。请改用 `git push` 普通推送，或用 `--force-with-lease` 并确认目标分支归属自己。
