---
description: flowmap.app에 로그인합니다 (OAuth 디바이스 플로우). 사용자가 "/flowmap login", "flowmap 로그인", "flowmap 인증해줘" 등을 말할 때 호출.
---

# Flowmap login

다음 단계로 진행하세요.

## 1. 명령 실행
Bash로 실행:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" login
```

스크립트가 표준 출력으로 `user_code`, `verification_uri`, `verification_uri_complete`를 알려줍니다 (~5초 내).

## 2. 사용자에게 안내
출력된 `user_code`를 굵게 강조해서 보여주고, `verification_uri_complete`를 클릭 가능한 링크로 제시하세요.

예시:
> 브라우저에서 [https://flowmap.app/device?code=ABCD-1234](...) 를 열고 코드 **ABCD-1234** 를 확인해주세요.

## 3. 폴링 결과 처리
스크립트는 사용자 승인까지 자동으로 폴링하고 (최대 10분), 성공하면 토큰을 `~/.config/flowmap/token.json`에 저장하고 `✓ Logged in as <email>` 을 출력합니다.

스크립트 종료 코드:
- `0` 성공 — 사용자에게 `✓ 로그인 완료`
- `1` 실패 — stderr 메시지를 그대로 보여주고 다시 시도하라고 안내
- `2` 만료 — "코드가 만료되었습니다. 다시 실행해주세요" 안내
