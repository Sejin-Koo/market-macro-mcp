# market-macro-mcp

그동안 셸에서 인증키를 들고 직접 부르던 시장·거시 데이터 API를 하나로 묶은 MCP 서버입니다.
저장소는 두지 않고 매번 원천을 호출합니다(과거 날짜 응답·코드표만 인스턴스 메모리에 잠시 캐시).
모든 응답 끝에 `요약`(기관·기준일/기준월·원천호출수)을 붙입니다. 인증키 값은 어떤 응답·오류에도 싣지 않습니다.

## 도구 (13개)

| 도구 | 원천 | 기능 · 주요 인자 |
|---|---|---|
| `exim_get_fx` | 한국수출입은행 AP01 | 특일 환율(23개 통화). `date`, `exact`, `currencies` |
| `exim_get_interest` | 수출입은행 AP02·AP03 | 대출 고정기준금리·국제금리(SOFR·EURIBOR·SWAP·CIRR 등). `date`, `kinds`(loan/intl/all), `rate_types`, `currencies` |
| `exim_get_fx_series` | 수출입은행 AP01 | 환율 기간 추이. `currencies`, `from`, `to`, `interval`(day/week/month), `max_calls` |
| `kosis_search_tables` | KOSIS | 통계표 검색 → orgId·tblId. `keyword`, `limit`, `page` |
| `kosis_get_table_meta` | KOSIS | 항목·분류 코드, 필요 objL 수, 수록기간. `org_id`, `tbl_id`, `code_query`, `max_codes` |
| `kosis_get_data` | KOSIS | 수치 조회(사전 검사 포함). `org_id`, `tbl_id`, `prd_se`, `start`/`end` 또는 `recent`, `items`, `objL1`~`objL8` |
| `kepco_get_data` | 한전 전력데이터 개방포털 | 11개 데이터셋(`dataset`), `year`, `month`, `metro`, `city`(코드 또는 이름) + 데이터셋별 코드 필터 |
| `kepco_get_codes` | 한전 공통코드 | 지역(두 체계)·계약종별·산업분류·발전원·복지할인 코드 |
| `kepco_search_contracts` | 한전 SRM 전자입찰 | 한전·발전자회사 입찰공고. `from`, `to`(≤90일), `company`, `name`, `progress_state` |
| `rtms_get_deals` | 국토교통부 실거래가 | 아파트 매매·전월세, 상업업무용, 토지. `dataset`, `lawd_cd` 또는 `region`, `from_ym`~`to_ym`, `count_only` |
| `rtms_find_region` | 행안부 법정동코드 | 시군구 이름 → LAWD_CD(구가 있는 시는 하위 구로 펼침) |
| `holiday_get_days` | 한국천문연구원 특일정보 | 공휴일·국경일·기념일·24절기·잡절, `check_date` 영업일 확인 |
| `macro_api_status` | — | 키 설정 여부, 원천·도구 대응, `live_check`로 원천별 실호출 점검 |

`kepco_get_data` 데이터셋: `contract_type`(계약종별)·`industry_type`(산업분류별)·`business_type`(업종별)·`house_avg`(가구평균)·
`cust_change`(고객 신설·증설·해지)·`billing_type`(요금청구방식)·`welfare`(복지할인)·`ev_charger`(충전소 설치현황)·
`ev_status`(충전기 운영정보)·`renewable`(신재생 계약현황)·`dispersed_gen`(분산전원 연계 여유용량). 데이터셋별 필수 인자는 도구 설명에 있습니다.

## 환경변수

| 이름 | 내용 |
|---|---|
| `EXIM_API_KEY` | 한국수출입은행 Open API 인증키(환율·대출금리·국제금리 공용) |
| `KOSIS_API_KEY` | KOSIS Open API 인증키 |
| `KEPCO_API_KEY` | 한전 전력데이터 개방포털 API 키(40자리) |
| `DATA_PORTAL_KEY` | 공공데이터포털 일반 인증키(Decoding) — 실거래가·특일정보·법정동코드 |
| `MCP_GATE_KEYS` | 허용 게이트키 목록(쉼표 구분). 비어 있으면 게이트 비활성 |
| `MCP_GATE_MODE` | `enforce`면 키 없는 호출 401 차단, 그 밖은 통과+로그(observe) |

엔드포인트: `https://<도메인>/api/mcp?k=<게이트키>` (POST만, Streamable HTTP·무상태)

## 원천별 특성 (2026-10-08 실측)

**한국수출입은행** — 엔드포인트가 data 코드마다 다름(AP01 exchangeJSON, AP02 interestJSON, AP03 internationalJSON). 옛 도메인 www.koreaexim.go.kr 사용 금지.
주말·공휴일·미래는 HTTP 200 + `[]` → 서버가 최대 10일 거슬러 조회하고 `사용기준일`을 표시(2026-10-05 대체공휴일 → 10-02). 대출금리는 휴일에도 직전 값을 주므로 영업일 판정은 환율로 함.
국제금리는 비영업일에 SOFR·ESTR·TONA만 차는 부분 자료. 일일 1,000회, result 4 = 한도 마감(재시도 안 함). 2005-01-03 자료부터.

**KOSIS** — 메타(statisticsData.do)와 자료(Param/statisticsParameterData.do) 엔드포인트가 다름. objL 레벨 수는 표마다 달라 부족하면 err 20, 많으면 err 21 → 메타의 분류 수로 사전 검사.
40,000셀 상한(err 31)은 반환 행이 아니라 항목×레벨별 코드 수×시점 수의 **선언된 교차곱** → 사전 계산해 차단하고 고칠 방법을 안내. 여러 코드는 공백으로 연결.

**한국전력** — 지역코드 두 체계(법정동: 서울 11·부산 26·경기 41·강남구 680 / 한전: 서울 11·부산 21·경기 31·강남구 26). 업종별은 이름을 받음.
2026-07 자료부터 광주(29)·전남(46)이 전남광주통합특별시(12)로 수록되고, 산업분류별 2026-07은 시군구가 `XXX`로 마스킹돼 광주·전남을 나눌 수 없음. 전북은 52, 강원은 51.
시도 생략 시 응답이 JSON 객체 2개를 이어 붙인 형태(`{"totData":…}{"data":…}`). 0건·미수록 월·없는 코드는 모두 HTTP 404. month는 두 자리. 가끔 HTTP 401 `{}`(재시도하면 정상).
신재생에너지는 metroCd 필터가 항상 404라 서버가 전국을 받아 거름(10~34초). 전자입찰은 최대 90일, 30일 무필터 9MB·53초라 서버가 무필터 14일로 제한.
월별 자료는 2026-07(요금청구방식 2026-08)까지.

**국토교통부 실거래가** — 승인 4종: 아파트 매매(상세)·아파트 전월세·상업업무용 매매·토지 매매. 오피스텔·연립다세대·단독다가구(매매·전월세)·아파트 매매(기본)·분양권전매·공장창고는 미승인(403 SERVICE_KEY_IS_NOT_REGISTERED_ERROR).
numOfRows 9999까지 요청한 만큼 줌(관측 최대 2,332행 한 번에) — 서버는 1000행 페이지로 받고 수신/전체를 대조. `numOfRows=0`이면 건수만.
틀린 LAWD_CD·월 형식·수록 전 월 모두 오류 없이 0건. 구가 생긴 시(화성시 41590 등)는 과거 월까지 구 코드로 재편돼 시 코드로는 0건 → 이름을 주면 하위 구로 펼침.
totalCount에 해제(취소) 거래 포함 → 통계는 기본 제외. 금액 단위 만원. 최근 1~2개월은 신고기한 때문에 계속 늘어남.

**특일정보** — solMonth를 빼면 1년치가 옴(numOfRows 기본 10이라 200으로 받음). solMonth는 두 자리("5"는 조용히 0건). 수록 2004~2028년.
1건이면 item이 객체. 노동절·제헌절은 2026년부터 관공서 공휴일(2026-04-28 규정 개정, 대체공휴일 적용) — API의 isHoliday=Y가 맞음. 임시공휴일은 반영이 하루쯤 늦을 수 있음.

## 테스트

```
SMOKE_ENV_FILE=/경로/keys.env npm test                 # 전 도구 실호출(키는 파일에서 읽음)
SMOKE_ENV_FILE=/경로/keys.env node smoke.mjs rtms_get_deals   # 일부 도구만
```

배포: Vercel(`vercel.json` — 리전 icn1, 함수 최대 60초).
