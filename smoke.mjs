// 실제 인증키로 모든 도구를 MCP 프로토콜 그대로(인메모리 전송) 호출하는 스모크 테스트.
//   SMOKE_ENV_FILE=/경로/keys.env node smoke.mjs [도구명 ...]
//   (keys.env는 KEY=VALUE 줄 형식. 키 값을 명령줄에 쓰지 않으려고 파일에서 읽는다. 환경변수가 이미 있으면 그대로 쓴다)
// 검증값은 2026-10-08 실측 기준이다(과거 월·과거 날짜만 고정값으로 확인한다).

import fs from "node:fs";
if (process.env.SMOKE_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.SMOKE_ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildServer } = await import("./lib/server.js");

const server = buildServer();
const client = new Client({ name: "smoke", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const only = new Set(process.argv.slice(2));
const secrets = ["EXIM_API_KEY", "KOSIS_API_KEY", "KEPCO_API_KEY", "DATA_PORTAL_KEY"].map((k) => process.env[k]).filter((v) => v && v.length > 5);
let totalCalls = 0;
let fails = 0;
let count = 0;

async function call(name, args, check, label = "") {
  if (only.size && !only.has(name)) return null;
  count++;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 오류 문구 */
  }
  totalCalls += body?.요약?.원천호출수 ?? 0;
  let verdict;
  try {
    verdict = check ? check(body, text, r) : !r.isError;
  } catch (e) {
    verdict = false;
  }
  // 어떤 응답에도 키 값이 들어가면 안 된다
  if (secrets.some((s) => text.includes(s) || text.includes(encodeURIComponent(s)))) {
    verdict = false;
    console.log("   !!! 응답에 인증키 값이 들어 있습니다");
  }
  if (!verdict) fails++;
  console.log(`${verdict ? "✅" : "❌"} ${name} ${label} ${JSON.stringify(args).slice(0, 120)} (${Date.now() - t0}ms, 원천 ${body?.요약?.원천호출수 ?? "-"}회)`);
  console.log("   ", text.slice(0, 420).replace(/\s+/g, " "));
  return body;
}

const tools = await client.listTools();
console.log(`도구 ${tools.tools.length}개:`, tools.tools.map((t) => t.name).join(", "));

// ── 상태 ──
await call("macro_api_status", {}, (b) => Object.values(b.인증키설정).every(Boolean) && b.실거래가_미승인.length === 9);

// ── 수출입은행 ──
await call("exim_get_fx", { date: "2026-10-05", currencies: "USD,JPY(100)" }, (b) => b.사용기준일 === "2026-10-02" && b.환율.반환통화수 === 2 && b.환율.행.find((x) => x.통화코드 === "USD").매매기준율 === 1359.6 && b.건너뛴날짜.length === 3, "[대체공휴일 → 직전 영업일 10-02]");
await call("exim_get_fx", {}, (b) => b.환율.전체통화수 >= 20, "[기준일 생략]");
await call("exim_get_fx", { date: "20261005", exact: "true" }, (b, t, r) => r.isError && /NO_DATA/.test(t), "[exact 휴일 → 오류]");
await call("exim_get_fx", { date: "2026/13/01" }, (b, t, r) => r.isError && /존재하지 않는|형식/.test(t), "[잘못된 날짜]");
await call("exim_get_fx", { date: "20050103", currencies: ["USD"] }, (b) => b.환율.행[0].매매기준율 === 1036.6, "[2005-01-03 최초 자료]");
await call("exim_get_interest", { date: "20261002" }, (b) => b.대출금리.행.length === 41 && b.국제금리.자료완전성 === "완전");
await call("exim_get_interest", { date: "20261004", kinds: "intl", rate_types: "SOFR,EURIBOR" }, (b) => b.사용기준일 === "2026-10-02" && b.국제금리.행.every((x) => /SOFR|EURIBOR/.test(x.구분)), "[주말 → 금요일, 필터]");
await call("exim_get_fx_series", { currencies: ["USD", "JPY"], from: "2026-07-01", to: "2026-09-30", interval: "month" }, (b) => b.시계열.length === 2 && b.시계열[0].관측수 === 3 && b.요약.원천호출수 <= 6);
await call("exim_get_fx_series", { currencies: "USD", from: "2026-09-21", to: "2026-09-30", interval: "day" }, (b) => b.시계열[0].관측수 === 6 && b.표본수_계획 === 8 && b.안내?.some((x) => /비영업일/.test(x)), "[추석 연휴(9/24·25) 빠짐]");
await call("exim_get_fx_series", { currencies: "USD", from: "2025-01-01", to: "2025-12-31", interval: "day" }, (b) => b.실행안함 === true && b.요약.원천호출수 === 0, "[호출 상한 사전 차단]");

// ── KOSIS ──
await call("kosis_search_tables", { keyword: "소비자물가지수", limit: "3" }, (b) => b.반환건수 === 3 && b.통계표.some((x) => x.통계표ID === "DT_1J22003") && b.다음호출);
await call("kosis_search_tables", { keyword: "zzzz없는통계qq" }, (b) => b.반환건수 === 0 && b.안내, "[0건]");
await call("kosis_get_table_meta", { org_id: 101, tbl_id: "DT_1J22003", code_query: "서울" }, (b) => b.필요objL수 === 1 && b.분류[0].필터일치 === 1 && b.수록주기.some((p) => p.prdSe === "M"));
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "월", start: "2026-01", end: "202603", objL1: "T10", items: "T" }, (b) => b.전체건수 === 3 && b.행[0].값 > 100 && b.행[0].시점 === "202601");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", recent: "2", objL1: "T10", items: "T" }, (b) => b.전체건수 === 2, "[recent]");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", recent: 1 }, (b) => b.실행안함 === true && /objL 1개/.test(b.사유), "[objL 부족 → err 20 사전 차단]");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", recent: 1, objL1: "T10", objL2: "ALL" }, (b) => b.실행안함 === true && /err 21/.test(b.사유), "[objL 초과 → err 21 사전 차단]");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", recent: 1, objL1: "ZZZ" }, (b) => b.실행안함 === true && b.없는코드?.[0]?.코드 === "ZZZ", "[없는 코드]");
await call("kosis_get_data", { org_id: "116", tbl_id: "DT_MLTM_5498", prd_se: "M", start: "202501", end: "202503", objL1: "ALL", objL2: "ALL", objL3: "ALL" }, (b) => b.실행안함 === true && b.셀계산.예상셀수 === 270000, "[40,000셀 사전 차단]");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", start: "203001", objL1: "T10" }, (b) => b.실행안함 === true && /수록기간/.test(b.사유), "[수록기간 밖]");
await call("kosis_get_data", { org_id: "101", tbl_id: "DT_1J22003", prd_se: "M", start: "2026-13", objL1: "T10" }, (b, t, r) => r.isError && /범위/.test(t), "[잘못된 시점]");

// ── 한국전력 ──
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: "7", metro: "서울", city: "강남구" }, (b) => b.필터후건수 === 7 && b.조회조건.시군구 === "강남구(680)" && b.합계_필터후.고객호수 > 0);
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: 7, summary_only: true }, (b) => b.전국합계.length === 7 && b.원본행수 > 1000 && !b.행, "[시도 생략 → 이어붙은 JSON 2개]");
await call("kepco_get_data", { dataset: "industry_type", year: 2026, month: 7, metro: "전남", summary_only: true }, (b) => /\(12\)/.test(b.조회조건.시도) && b.필터후건수 === 21 && b.안내.some((x) => /XXX/.test(x)), "[2026-07 통합코드 12 — 시군구 XXX 마스킹]");
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: 6, metro: "광주", summary_only: true }, (b) => /\(29\)/.test(b.조회조건.시도) && b.필터후건수 === 35, "[2026-06은 옛 코드 29]");
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: 7, metro: "광주", summary_only: true }, (b) => /\(12\)/.test(b.조회조건.시도) && b.원본행수 > 150 && b.필터후건수 === 35, "[2026-07 광주 → 12에서 5개 구만]");
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: 9, metro: "서울" }, (b) => b.전체건수 === 0 && /404/.test(b.안내0건), "[미수록 월 → 0건 안내]");
await call("kepco_get_data", { dataset: "business_type", year: 2026, month: 7, metro: "서울특별시", city: "강남구", biz_type: "금속" }, (b) => b.필터후건수 >= 1 && b.원본행수 === 28, "[이름 전송·업종 공백 무시]");
await call("kepco_get_data", { dataset: "house_avg", year: 2026, month: 7 }, (b, t, r) => r.isError && /시도/.test(t), "[필수 시도 누락]");
await call("kepco_get_data", { dataset: "house_avg", year: 2026, month: 7, metro: 11, limit: 3 }, (b) => b.필터후건수 === 25 && b.반환건수 === 3 && b.행[0].가구평균전력사용량_kWh > 0);
await call("kepco_get_data", { dataset: "cust_change", year: 2026, month: 7, metro: "서울", biz_code: "C", summary_only: true }, (b) => b.필터후건수 > 0 && b.합계_필터후.신설건수 >= 0);
await call("kepco_get_data", { dataset: "billing_type", year: 2026, month: 8, metro: "서울", city: "강남구" }, (b) => b.필터후건수 === 4, "[요금청구방식 2026-08]");
await call("kepco_get_data", { dataset: "welfare", year: 2026, month: 7, metro: "서울", welfare_code: "03", summary_only: true }, (b) => b.필터후건수 > 0);
await call("kepco_get_data", { dataset: "ev_charger", metro: "서울", city: "강남구", limit: 2 }, (b) => b.조회조건.시도 === "서울특별시(11)" && b.조회조건.시군구 === "강남구(26)" && b.필터후건수 > 20, "[한전 코드 체계]");
await call("kepco_get_data", { dataset: "ev_status", addr: "빛가람동", limit: 2 }, (b) => b.필터후건수 > 0 && /\(\d\)$/.test(b.행[0].충전기상태));
await call("kepco_get_data", { dataset: "ev_status" }, (b, t, r) => r.isError && /addr/.test(t), "[addr 필수]");
await call("kepco_get_data", { dataset: "dispersed_gen", metro: "서울", city: "강남구", limit: 2 }, (b) => b.필터후건수 > 0 && typeof b.행[0].변전소여유용량 === "number");
await call("kepco_get_data", { dataset: "renewable", year: 2025, metro: "서울", gen_src_code: 1 }, (b) => b.필터후건수 === 5 && b.안내.some((x) => /서버에서/.test(x)), "[시도 필터 서버 처리 — 느림]");
await call("kepco_get_data", { dataset: "no_such" }, (b, t, r) => r.isError, "[없는 데이터셋]");
await call("kepco_get_data", { dataset: "contract_type", year: 2026, month: 7, metro: "없는도" }, (b, t, r) => r.isError && /찾지 못했/.test(t), "[없는 시도]");
await call("kepco_get_codes", { code_type: "lglDngCityCd", parent: 11, query: "강남" }, (b) => b.반환건수 === 1 && b.코드[0].코드 === "680");
await call("kepco_search_contracts", { from: "2026-10-01", to: "2026-10-07", company: "서부발전", limit: 3 }, (b) => b.원본건수 === 20 && b.공고.length === 3 && b.공고[0].회사 === "한국서부발전");
await call("kepco_search_contracts", { from: "20261001", to: "20261007", name: "변전소", include_detail: true, limit: 1 }, (b) => b.원본건수 === 11 && Array.isArray(b.공고[0].첨부파일), "[건명 필터·상세]");
await call("kepco_search_contracts", { from: "20260901", to: "20260930" }, (b) => b.실행안함 === true && b.요약.원천호출수 === 0, "[필터 없이 30일 → 사전 차단]");
await call("kepco_search_contracts", { from: "20260101", to: "20260930", name: "변압기" }, (b, t, r) => r.isError && /90일/.test(t), "[90일 초과]");

// ── 실거래가 ──
await call("rtms_get_deals", { dataset: "apt_trade", region: "강남구", from_ym: "2025-09", limit: 3 }, (b) => b.전체건수_원천 === 233 && b.수신건수 === 233 && b.통계.해제건수 >= 1 && b.거래.length === 3);
await call("rtms_get_deals", { dataset: "apt_rent", lawd_cd: "11710", from_ym: "202502", summary_only: true }, (b) => b.수신건수 === 2332 && b.미수신건수 === 0 && b.요약.원천호출수 === 3 && b.통계.전세.건수 + b.통계.월세.건수 === 2332, "[1000행 3페이지]");
await call("rtms_get_deals", { dataset: "apt_trade", region: "화성시", from_ym: "202509", count_only: true }, (b) => b.월별.length === 4 && b.월별.every((x) => x.건수 > 0) && b.안내.some((x) => /하위 구/.test(x)), "[구가 있는 시 → 하위 구]");
await call("rtms_get_deals", { dataset: "apt_trade", lawd_cd: "41590", from_ym: "202509" }, (b) => b.전체건수_원천 === 0 && b.안내.some((x) => /0건/.test(x)), "[시 코드 0건 안내]");
await call("rtms_get_deals", { dataset: "apt_trade", region: "중구", from_ym: "202509" }, (b) => b.실행안함 === true && b.후보.length >= 5, "[모호한 지역]");
await call("rtms_get_deals", { dataset: "apt_trade", lawd_cd: "1168", from_ym: "202509" }, (b, t, r) => r.isError && /5자리/.test(t), "[잘못된 LAWD_CD]");
await call("rtms_get_deals", { dataset: "apt_trade", region: "수원시", from_ym: "202501", to_ym: "202512", max_calls: 10 }, (b) => b.실행안함 === true && /48회/.test(b.사유), "[호출 상한 사전 차단]");
await call("rtms_get_deals", { dataset: "apt_trade", lawd_cd: "11680", from_ym: "2025-13" }, (b, t, r) => r.isError && /월/.test(t), "[잘못된 월]");
await call("rtms_get_deals", { dataset: "nrg_trade", region: "서울 강남구", from_ym: "202509", limit: 2 }, (b) => b.전체건수_원천 === 131 && b.거래[0].건물주용도);
await call("rtms_get_deals", { dataset: "land_trade", lawd_cd: ["11680"], from_ym: "202509", sort: "price_desc", limit: 2 }, (b) => b.전체건수_원천 === 74 && b.거래[0].거래금액_만원 >= b.거래[1].거래금액_만원);
await call("rtms_get_deals", { dataset: "apt_trade", lawd_cd: "11680", from_ym: "202507", to_ym: "202509", name: "래미안", summary_only: true }, (b) => b.요약.원천호출수 === 3 && b.필터후건수 > 0, "[3개월·단지명 필터]");
await call("rtms_find_region", { region: "성남시 분당구" }, (b) => b.지역[0].코드 === "41135");

// ── 특일정보 ──
await call("holiday_get_days", { year: 2026 }, (b) => b.공휴일.건수 === 22 && b.공휴일.목록.some((d) => d.이름 === "노동절" && d.공휴일여부) && b.요약.원천호출수 === 1);
await call("holiday_get_days", { year: "2026", month: "5", kinds: "rest,anniversary" }, (b) => b.공휴일.건수 === 4 && b.기념일.건수 === 15);
await call("holiday_get_days", { from: "2026-10-01", to: "2026-10-31", kinds: ["rest", "solar_terms"] }, (b) => b.공휴일.건수 === 3 && b["24절기"].건수 === 2);
await call("holiday_get_days", { check_date: "20261008" }, (b) => b.영업일확인.영업일 === true && b.영업일확인.다음영업일 === "2026-10-12", "[한글날+주말 건너뜀]");
await call("holiday_get_days", { check_date: "2026-10-05" }, (b) => b.영업일확인.영업일 === false && /대체공휴일/.test(b.영업일확인.사유));
await call("holiday_get_days", { year: 2025, kinds: "national" }, (b) => b.국경일.목록.some((d) => d.이름 === "제헌절" && !d.공휴일여부 && d.비고), "[2025 제헌절 공휴일 아님]");
await call("holiday_get_days", { year: 2030 }, (b) => b.공휴일.건수 === 0 && b.안내.some((x) => /수록 범위/.test(x)), "[범위 밖]");
await call("holiday_get_days", { year: 2026, kinds: "foo" }, (b, t, r) => r.isError, "[잘못된 kinds]");

await call("macro_api_status", { live_check: true }, (b) => b.점검요약.정상 === 5, "[live_check]");

console.log(`\n테스트 ${count}건, 실패 ${fails}건, 원천 호출 합계 ${totalCalls}회`);
process.exit(fails ? 1 : 0);
