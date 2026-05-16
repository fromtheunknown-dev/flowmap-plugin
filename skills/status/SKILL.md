---
description: flowmap.app 로그인 상태와 마지막 sync 정보를 보여줍니다. 사용자가 "/flowmap status", "flowmap 상태" 등을 말할 때 호출.
---

Bash 실행:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" status
```

출력 예시:
```
▸ Logged in as you@example.com
▸ Project: my-app  (linked .flowmap/config.json)
▸ Last sync: 5m ago — 12 routes, 14 edges
▸ View: https://flowmap.app/projects/abc...
```

로그인 안 됐으면:
```
✕ Not logged in. Run /flowmap login.
```
