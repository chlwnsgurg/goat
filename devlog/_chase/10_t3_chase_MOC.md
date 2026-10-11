# 10 — T3 chase MOC

> 축: upstream `pingdotgg/t3code` `main`
> reviewed-through: `de49d637d` (fork point) · 스캔 head: `262532709` · 갱신 2026-10-12

| NNN | 카드                                                                   | GOAT 영역           | P      | 상태              |
| --- | ---------------------------------------------------------------------- | ------------------- | ------ | ----------------- |
| 001 | [사이클 261012 triage](./10.001_t3_chase_cycle_261012.md)              | 전체                | **P1** | 🟡 머지 대기      |
| 002 | [마이그레이션 id 61 충돌](./10.002_t3_chase_migration_61_collision.md) | `server-activity`   | **P0** | ⛔ needs decision |
| 003 | [새 upstream `t3_*` 이름](./10.003_t3_chase_goat_tool_names.md)        | `mcp-names`         | **P1** | ⬜ open           |
| 004 | [SSH tunnel 테스트 이식](./10.004_t3_chase_ssh_tunnel_port.md)         | `ssh-runtime`, `ci` | P2     | ⬜ open           |

머지 순서: 002 결정 → `chase/t3-261012`에서 `262532709` 머지 → 001 충돌 표와 003, 004를 같은
브랜치에서 해결 → goat-ci green → dev 랜딩.

## \_fin

아직 없음. 닫힌 카드는 [`_fin/10/`](./_fin/README.md)에 둔다.
