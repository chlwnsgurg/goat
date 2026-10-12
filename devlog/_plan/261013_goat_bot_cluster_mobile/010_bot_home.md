# 010 — L1 bot-home: 클러스터당 GOAT Bot 하나

[000](000_plan.md) B1-B3. 레인 스레드가 P 단계에서 이 문서를 diff 수준 계획으로 확장한다.

## 현재

- 서버마다 owner별 봇이 하나다(`ChannelBotRegistry.ensure`, ledger `getBot`). 클러스터 개념이 없어 서버 셋이면 봇 셋.
- 웹은 클라이언트마다 `pickGoatBotEnvironment`(알려진 봇 → primary → 첫 지원 서버)로 고른다(`apps/web/src/components/goatBot/goatBotAvailability.ts`). 모바일·다른 데스크톱은 다른 서버를 고를 수 있다.
- Slack 런타임은 서버마다 `ChannelLayers`에서 뜬다. 같은 Slack 앱을 두 서버에 연결하면 소켓이 둘.
- 공유 설정: `packages/client-runtime/src/state/sharedSettings.ts` `SHARED_SERVER_SETTING_KEYS`, 계약은 `packages/contracts/src/settings.ts`.

## 할 일

1. 계약: `ServerSettings.goatBotHome: { environmentId, claimedAt, claimId } | null`(기본 null)와 patch 키. 서버 설정 저장은 이 키에 단조 병합을 적용한다(더 작은 `(claimedAt, claimId)` 쓰기는 무시). 공유 키 목록에 추가. `ChannelGatewayError.reason`에 `not_home`(+ `homeEnvironmentId`) 추가.
2. 서버: 홈 판정 서비스 메서드 하나(설정 홈 vs 자기 environmentId). `ensureBot`과 `kind: "goat"` 인입은 홈이 아니면 `not_home`. Slack 런타임은 홈이 아니면 연결하지 않고, 설정 변경 시 열고 닫는다(설정 스트림 구독). 미지정이면 지금과 같다.
3. client-runtime: 순수 함수 `resolveGoatBotHome({environments, sharedHome, knownBot})` → 환경 또는 "claim 필요". 웹(나중에 모바일)이 쓴다.
4. 웹: 가용성이 홈을 따른다. 미지정이면 고른 환경을 모든 동기화 대상에 기록(한 번). `not_home` 응답이면 홈으로 다시 해석. 설정(Integrations 또는 GOAT Bot 섹션)에 "GOAT Bot이 사는 곳" 선택과 현재 값. 바꾸기만 있고 해제는 없다. 홈 서버가 오프라인이면 "홈 오프라인" 상태(다른 서버로 몰래 옮기지 않음).
5. 문서: `docs/internals/channels.md`에 홈 규칙 한 절, `docs/user`에 설정 경로.

## 검증

- 서버: ChannelScenarios/ChannelAssembly에 홈 아님 거절, 미지정 하위 호환, 홈 변경 후 ensure 성공 테스트. Slack 런타임 홈 게이트 테스트.
- client-runtime: `resolveGoatBotHome`, 공유 키 분리 테스트.
- 웹: goatBotAvailability 테스트 갱신. web·server·contracts·client-runtime typecheck, 변경 파일 lint.

## 표면 점검(AGENTS.md)

진입점(사이드바, 로고, 설정, 커맨드 팔레트), 클라이언트(웹·데스크톱·모바일은 L3가 같은 함수 사용), 연결 모드(로컬·SSH·relay), 되돌리기(홈 변경·이전 홈으로 다시 변경), 에이전트(MCP channel_* 경로는 홈 판정을 우회하지 않음).

## 감사 반영 (000 B1-B3)

- 설정 값은 `{ environmentId, claimedAt, claimId }`이고 정본은 연결된 지원 서버들 중 `(claimedAt, claimId)` 최대. 같은 시각 주장, 순서가 뒤바뀐 쓰기(오래된 재동기화가 나중에 도착) 테스트 필수. 클라이언트는 연결·재연결마다 다른 값의 서버에 정본을 다시 쓴다. primary가 없는 호스티드·모바일 클라이언트도 같은 규칙.
- 서버 capability `goatBotHome: true`를 알리고, 미지원 서버에는 키를 쓰지 않는다. 미지원 서버는 홈 후보가 될 수 없다.
- 로드 전 상태는 unknown이다. claim 쓰기가 홈 서버에 반영되고 다시 읽은 정본이 같을 때만 ensure.
- 서버 게이트는 GOAT 인입과 MCP `channel_*` 프런트 데스크 인입 모두. 워커 보고·`channel_input_get`은 그대로. 오류 매핑(MCP 도구 결과, WS 오류) 테스트 포함.
- Slack 런타임은 설정 스트림을 구독해 홈이 되면 열고 홈이 아니게 되면 닫는다. 테스트로 확인.
- 보장 범위를 문서에 적는다: 연결된 서버들 사이에서 수렴, 오프라인 서버는 돌아오면 수렴.
