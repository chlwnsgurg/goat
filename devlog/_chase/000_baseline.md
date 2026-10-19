# 000 — 기준선

> 갱신: 2026-10-12 (사이클 261012 스캔, 아직 upstream 머지 없음)

## 현재 기준선

| 항목                          | 값                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------- |
| upstream                      | `pingdotgg/t3code` `main` (remote `upstream`, `tagopt --no-tags`)            |
| GOAT 통합 브랜치              | `goat-si/goat` `dev`                                                         |
| reviewed-through (merge-base) | `de49d637d` 2026-10-10 feat(server): use macOS .icns app icons (#17149)      |
| 스캔한 upstream HEAD          | `262532709` fix(usage): say resets momentarily in the final minute (#17869)  |
| 스캔한 GOAT dev               | `f4b6c14e5` feat(web): align the resting composer and shrink primary actions |
| GOAT 고유 커밋                | 44                                                                           |
| upstream 앞섬                 | 106 (약 2일치)                                                               |
| trial merge 충돌              | 11 파일 ([10.001](./10.001_t3_chase_cycle_261012.md))                        |

`de49d637d`는 GOAT가 갈라진 fork point다. 첫 upstream 머지가 dev에 들어가면 merge-base가 그
머지의 upstream parent로 전진하고, 그 값이 다음 reviewed-through가 된다. 이 표는
`devlog/_chase/scan.sh` 출력의 요약이며, 손으로 고친 값과 스크립트가 다르면 스크립트가 맞다.

upstream은 하루에 약 50커밋씩 움직인다. 사이클이 길어질수록 충돌이 늘어나므로 주 1회 이상 도는
것을 기본으로 한다.

## 사이클 로그

| 사이클 | 날짜       | upstream 범위          | 커밋 | 충돌 | 결과                   | 카드       |
| ------ | ---------- | ---------------------- | ---- | ---- | ---------------------- | ---------- |
| 261012 | 2026-10-12 | `de49d637d..262532709` | 106  | 11   | triage 완료, 머지 대기 | 10.001-004 |
| 261014 | 2026-10-14 | `7b6d90757..bf8ffe81a` | 153  | 120  | 머지, PR 리뷰 대기     | 10.006     |
| 261019 | 2026-10-19 | `bf8ffe81a..952921f39` | 836  | 933  | 머지, PR 리뷰 대기     | 10.007     |
