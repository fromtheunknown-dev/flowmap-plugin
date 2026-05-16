---
description: flowmap.app에서 로그아웃하고 로컬 토큰을 삭제합니다. 사용자가 "/flowmap logout", "flowmap 로그아웃" 등을 말할 때 호출.
---

Bash 실행:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" logout
```

`~/.config/flowmap/token.json`을 삭제하고 서버에서 토큰을 revoke합니다. 출력: `✓ Logged out`.
