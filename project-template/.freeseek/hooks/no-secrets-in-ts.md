---
name: warn-secrets-in-ts
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.tsx?$
  - field: new_text
    operator: regex_match
    pattern: (API[_-]?KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*["'][^"'\n]{6,}["']
---
检测到疑似硬编码凭据。请改用环境变量或密钥管理，勿把密钥写入代码。
