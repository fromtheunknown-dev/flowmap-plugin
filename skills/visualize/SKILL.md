---
description: 현재 작업 디렉토리의 웹·모바일 앱(Next.js · Expo Router · React Native) 화면 흐름을 자동으로 분석하고 각 화면의 설명을 작성한 뒤 flowmap.app에 동기화해 결과 URL을 보여줍니다. 사용자가 "/flowmap", "/flowmap visualize", "스크린플로우 보여줘", "화면 흐름 시각화", "flowmap 동기화" 등을 말할 때 호출.
---

# Flowmap visualize

다음 순서로 진행하세요.

## 1. 로그인 확인
Bash로 실행:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" status --json
```
- `{"loggedIn": false}` 면 사용자에게 "/flowmap login 을 먼저 실행해주세요" 안내 후 종료.

## 2. 라우트 분석
Bash로 실행:
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" analyze --cwd "$(pwd)"
```
마지막 JSON 라인에 `needsDescriptions` 배열이 있습니다. 각 항목은
`{ "routePath": "...", "filePath": "...", "componentName": "..." }` 형태입니다.

## 3. AI 화면 설명 초안 작성
`needsDescriptions`가 **비어있지 않으면**, 각 항목에 대해:

1. 해당 항목의 `filePath` 파일을 **Read 도구로 직접 읽으세요.** (필요하면 그
   파일이 import하는 화면 컴포넌트도 함께 읽어 맥락을 파악하세요.)
2. 그 화면이 **사용자에게 어떤 역할을 하는지** 1~2문장의 한국어 설명을 쓰세요.
   - 코드 구현 세부사항이 아니라 "이 화면이 무엇을 위한 화면인지"를 설명합니다.
   - 예: "사용자가 이메일·비밀번호로 로그인하는 화면. 가입 페이지와 비밀번호
     찾기로 이동할 수 있다."
   - 추측이 어려우면 짧고 사실적으로만 적으세요. 과장하지 마세요.
3. 작성한 설명을 모아 `.flowmap/descriptions.json` 파일에
   `{ "<routePath>": "<설명>", ... }` 형태의 JSON 객체로 저장하세요.
   - 파일이 이미 있으면 **기존 항목을 유지하고 병합**하세요 (덮어쓰지 마세요).

`needsDescriptions`가 비어있으면 이 단계를 건너뜁니다.

> 중요: 소스 코드는 로컬에서만 읽힙니다. flowmap.app으로는 여기서 작성한
> **설명 텍스트만** 전송되고, 코드 자체는 절대 업로드되지 않습니다.
> `.flowmap/descriptions.json`도 로컬 캐시이며 git에 커밋되지 않습니다.

## 4. 스크린샷 + 동기화
Bash로 실행 (사용자의 dev 서버 URL은 옵션):
```
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" visualize --cwd "$(pwd)"
```

자동 동작:
1. 라우트를 다시 분석하고 `.flowmap/descriptions.json`의 설명을 manifest에 병합
2. (웹 프레임워크) 사용자 dev 서버가 살아있으면 라우트별로 데스크톱+모바일 스크린샷 캡처
   — **Expo Router / React Native 프로젝트는 웹 대상이 없어 스크린샷을 건너뜁니다(메타데이터만 동기화).**
3. flowmap.app에 sync, viewUrl 받음

스크립트는 진행상황을 한 줄씩 출력합니다 (`▸ analyzing...`,
`✓ 12 routes, 14 edges`, `✓ 8 screen descriptions merged`).

## 5. 결과 보고
JSON으로 마지막 라인이 출력됩니다:
```json
{"projectId":"...","viewUrl":"https://flowmap.app/projects/...","routes":12,"edges":14,"descriptions":12,"unresolvedEdges":2}
```

사용자에게 다음을 보여주세요:
- 라우트/엣지 개수, 설명이 작성된 화면 개수(`descriptions`)
- **`unresolvedEdges`가 0보다 크면** → "동적 URL %d개는 confidence가 낮게
  기록되었습니다. 캔버스에서 점선으로 표시됩니다." 안내
- 결과 URL을 마크다운 링크로 (사용자가 클릭하면 브라우저에서 열림)
- macOS면 `open <url>` 로 자동으로 브라우저 오픈해도 됩니다 (사용자에게 묻지
  말고 그냥 열어주세요)
- 화면 설명은 웹의 상세 패널에서 사용자가 직접 수정할 수 있다고 안내하세요.

## 옵션
- `--no-screenshots`: dev 서버가 없거나 Puppeteer 설치 안 된 환경
- `--dev-server <url>`: 기본 `http://localhost:3000` 외 다른 포트 (예: `http://localhost:3030`)
- `--api-base <url>`: 자체 호스팅 시 (기본은 환경변수 또는 https://flowmap.app)
