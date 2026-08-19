---
name: block-destructive-git
enabled: true
event: bash
pattern: git\s+reset\s+--hard|git\s+clean\s+-\w*f\w*d
action: block
---
禁止 `git reset --hard` 与 `git clean -fdx` 等一次性丢弃大量改动/未跟踪文件的操作。
如需撤销，先确认改动无价值再用；更稳妥的方式是 `git stash` 暂存或先 `git diff > backup.patch` 留底。
