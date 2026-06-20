# KOSPI AI Trading Desk — Frontend

코스피 종목의 가격·수급·뉴스·공시를 분석해 자동매매 의사결정을 보조하는 한국시장 전용 트레이딩 데스크의 프론트엔드입니다. React + TypeScript + Vite 기반입니다.

## 화면 구성

| 경로 | 설명 |
| --- | --- |
| `/` | 서비스 소개 랜딩 페이지 (Hero · 전략 · 자동화 플로우) |
| `/dashboard` | 실시간 국내 시장 보드 (지수·종목 테이블·투자자 동향·AI 리포트·관심 종목) |
| `*` | 404 안내 페이지 |

## 개발

```bash
npm install
npm run dev        # http://localhost:5173
```

## 빌드 / 검증

```bash
npm run typecheck  # tsc 타입 검사
npm run build      # 프로덕션 번들 (dist/)
npm run preview    # 빌드 결과 로컬 미리보기
```

## 데이터 소스

기본값은 번들된 mock 데이터(`src/data/`)로, 백엔드 없이도 전체 화면이 동작합니다.
실데이터를 연동하려면 환경변수로 백엔드 API 주소를 지정하세요.

```bash
# .env (또는 .env.local) — .env.example 참고
VITE_API_BASE_URL=https://api.your-domain.com
# 대시보드 자동 재동기화 주기(ms). 0 이하면 폴링 비활성화 (기본 60000)
VITE_DASHBOARD_POLL_MS=60000
VITE_ENABLE_MOCK_CHART_FALLBACK=false
```

대시보드는 탭이 활성 상태일 때 위 주기로 시세를 자동 재동기화하고, 탭이 다시
포커스되면 즉시 동기화합니다. 관심 종목은 `localStorage`에 저장되어 새로고침 후에도
유지됩니다.

`VITE_API_BASE_URL`이 설정되면 `src/services/tradingData.ts`가 다음 엔드포인트를 호출합니다.

- `GET /api/candidates` — 랜딩용 후보 종목/요약
- `GET /api/korean-market/dashboard` — 대시보드 전체 페이로드
- `GET /api/korean-market/stock-chart?symbol=000660&range=1D` — 선택 종목 상세 차트/요약

엔드포인트 스키마는 [`docs/api-contract.md`](docs/api-contract.md)를 따릅니다. 호출 실패 시
로딩/에러 UI가 표시되며 사용자는 "다시 시도"로 재요청할 수 있습니다.

> 한국투자증권 Open API 키·시크릿·토큰은 절대 브라우저에서 직접 호출하지 않습니다.
> 자격증명은 백엔드에만 두고, 백엔드가 정규화한 응답만 프론트가 사용합니다.

## KIS 연동 / 스냅샷 배치

`server/`의 KIS 브리지(개발 시 vite 미들웨어, 배포 시 `api/`의 서버리스 함수)가
현재가·지수·투자자 순매수를 받아오고, 파이썬 파이프라인 결과(`outputs/…json`)의
감성·신뢰도·예상수익률을 종목코드 기준으로 병합합니다. `.env`에 모의 키를 둡니다.

```bash
# FE/.env
KIS_MOCK_APP_KEY=...
KIS_MOCK_APP_SECRET=...
# 실전 시세/투자자 수급은 실전 키 + KIS_ENV=real 필요 (모의 환경은 수급 데이터가 비어 있을 수 있음)
```

KOSPI200 전 종목(약 200개) 조회는 KIS 레이트리밋 때문에 요청 시점에 처리하면
수 분이 걸립니다. 그래서 **배치로 스냅샷을 미리 만들어** 두고 대시보드는 그 스냅샷을
즉시 서빙합니다.

| 동작 | 엔드포인트 |
| --- | --- |
| 대시보드(스냅샷 우선, 없으면 인라인 소량 조회) | `GET /api/korean-market/dashboard` |
| 스냅샷 갱신 배치(전 종목 + 투자자 수급) | `POST /api/korean-market/refresh` |
| 종목 상세 차트/요약(선택 종목 단건) | `GET /api/korean-market/stock-chart?symbol=000660&range=1D` |
| 후보 종목(파이프라인 결과/없으면 mock) | `GET /api/candidates` |

스케줄러로 장중 스냅샷을 미리 갱신하면 캐시가 따뜻하게 유지됩니다. `vercel.json`에
**Vercel Cron**(평일 장중 20분 간격)이 이미 설정되어 있으며, Vercel은 해당 경로를
`GET` + `Authorization: Bearer $CRON_SECRET` 헤더로 호출합니다. 외부 스케줄러(GitHub
Action·OS cron)는 `POST`에 `?key=` 또는 `x-refresh-key` 헤더로 호출하세요. 주요 환경변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `KIS_UNIVERSE_SIZE` | `20` | 인라인(요청 시점) 조회 종목 수 — 첫 화면 빠른 표시용 |
| `KIS_SNAPSHOT_UNIVERSE_SIZE` | `200`(전 종목) | 배치/백그라운드 워밍 조회 종목 수 |
| `KIS_AUTO_WARM` | `true` | 인라인 로드 후 전 종목 스냅샷을 백그라운드로 자동 생성(`false`로 비활성화) |
| `KIS_WITH_INVESTOR_FLOW` | `true` | 배치 시 투자자 순매수 동반 조회 |
| `DASHBOARD_SNAPSHOT_TTL_MS` | `900000`(15분) | 스냅샷 신선도 창 |
| `KIS_REQUEST_DELAY_MS` | 모의 1000 / 실전 200 | 호출 간 지연(레이트리밋 대응) |
| `KIS_STOCK_CHART_CACHE_TTL_MS` | `60000` | 선택 종목 상세 차트 응답 캐시 TTL |
| `KIS_INTRADAY_PAGE_COUNT` | `14` | 1D 분봉 차트 수집 페이지 수(페이지당 약 30개) |
| `PIPELINE_RESULT_PATH` | `../outputs/…json` | 파이프라인 결과 경로 오버라이드 |
| `SNAPSHOT_REFRESH_KEY` | (미설정) | 설정 시 `POST` refresh 호출에 `?key=` 또는 `x-refresh-key` 헤더 요구 |
| `CRON_SECRET` | (미설정) | 설정 시 Vercel Cron의 `GET` refresh 호출을 `Authorization: Bearer`로 인증 |

> 인라인 로드는 상위 `KIS_UNIVERSE_SIZE`(기본 20)종목을 투자자 수급과 함께 즉시 보여주고,
> 곧바로 백그라운드에서 전 종목 스냅샷을 만들어 다음 로드/새로고침에 전체 KOSPI200이 뜹니다.
> 모의(VTS) 환경은 레이트리밋이 강해 전 종목 워밍에 수 분이 걸릴 수 있고, 투자자 수급도
> 비어 있을 때가 많아 표에 "—"로 표시됩니다. 빠른 로컬 테스트는
> `KIS_SNAPSHOT_UNIVERSE_SIZE`를 낮추거나 `KIS_WITH_INVESTOR_FLOW=false`로 두세요.
> 실전 키(`KIS_ENV=real`)에서는 더 빠르고 수급도 채워집니다.

## 배포 (정적 호스팅)

`npm run build` 결과물(`dist/`)을 정적 호스팅에 올립니다. SPA 라우팅을 위해
모든 경로를 `index.html`로 보내는 fallback이 필요하며, 다음 설정이 포함되어 있습니다.

- Vercel: `vercel.json` (rewrites)
- Netlify: `public/_redirects`

## 폴더 구조

```
src/
  pages/        # 라우트 단위 페이지 (Landing / Dashboard / NotFound)
  components/
    landing/    # 랜딩 섹션
    market/     # 대시보드 워크스페이스
    common/     # ErrorBoundary, 로딩/에러 상태 뷰
    ui/         # 공용 UI (PillButton 등)
  hooks/        # useAsyncData 등
  services/     # 데이터 패칭 + 정규화
  data/         # mock 데이터
  types/        # 공용 타입
  styles/       # 전역 스타일
```
