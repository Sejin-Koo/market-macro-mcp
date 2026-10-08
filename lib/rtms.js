// market-macro-mcp / lib/rtms.js
//
// 국토교통부 부동산 실거래가(RTMS, 공공데이터포털) + 행정안전부 법정동코드(시군구 이름 → LAWD_CD).
//
// ── 실측으로 확인한 특성 (2026-10-08, DATA_PORTAL_KEY 기준) ──────────────────
// ★ 이 키로 승인된 실거래가 데이터셋은 4종뿐이다:
//     아파트 매매(상세, AptTradeDev) · 아파트 전월세(AptRent) · 상업업무용 매매(NrgTrade) · 토지 매매(LandTrade)
//   오피스텔 매매·전월세, 연립다세대 매매·전월세, 단독다가구 매매·전월세, 아파트 매매(기본, AptTrade),
//   분양권전매(SilvTrade), 공장창고(InduTrade)는 HTTP 403 SERVICE_KEY_IS_NOT_REGISTERED_ERROR(미승인).
// ★ numOfRows: 10·100·1000·2000·5000·9999 모두 요청한 만큼(또는 전량) 준다. 관측 최대 2,332행을
//   9999 한 번에 받았다(1.6MB·6.9초). 서버는 검증된 1000행 페이지로 나눠 받는다(page 3=332행, page 4=0행).
// ★ numOfRows=0을 주면 행 없이 totalCount만 온다(237바이트) → 건수만 필요할 때 월 1회 호출로 끝난다.
// ★★ 잘못된 파라미터는 전부 오류 없이 0건(resultCode 000)이다: DEAL_YMD "2025-09"·"202513",
//   LAWD_CD "1168"·"99999", 수록 전 월. 그래서 0건이면 형식 의심을 함께 안내한다.
// ★★ 구(區)가 생긴 시는 상위 시 코드로 조회하면 0건이다 — 화성시(41590)는 2026년 4개 구
//   (41591 만세·41593 효행·41595 병점·41597 동탄) 신설 후 **과거 월까지** 구 코드로 재편돼 41590은
//   2024-01·2025-09 모두 0건이었다. 시 이름을 주면 하위 구 코드 전부로 펼친다.
// ★ 수록 시작: 아파트 매매·상업업무용·토지 2006-01, 아파트 전월세 2011-01(직전 달은 0건).
// ★ 신고기한(계약 후 30일) 때문에 최근 1~2개월은 계속 늘어난다(2026-10-08 기준 2026-09 강남구 90건, 10월 5건).
// ★ totalCount에는 해제(취소)된 거래도 들어 있다(cdealType "O", cdealDay 해제일). 통계는 기본으로 해제 건을 뺀다.
// ★ 금액은 "750,000" 같은 쉼표 문자열, 단위 만원. 토지·상업업무용의 지번은 "1**"처럼 마스킹돼 온다.
//
// 법정동코드(StanReginCd): locatadd_nm 부분일치 검색. 응답 구조가 비표준이다
//   {"StanReginCd":[{"head":[{totalCount},…,{RESULT:{resultCode:"INFO-0"}}]},{"row":[…]}]},
//   없는 이름은 {"RESULT":{"resultCode":"INFO-3"}} — 오류가 아니라 0건.

import { UpstreamError, toNum, trimStr, round, stats, mapLimit, ymRange, addMonths, Lru, dashed, nowKst, envKey, httpGet, qs } from "./common.js";
import { dataGoGet, asArray, DATA_PORTAL_ENV } from "./datago.js";

const SOURCE = "국토교통부 실거래가";
const BASE = "https://apis.data.go.kr/1613000/";
export const RTMS_PAGE = 1000;

export const RTMS_DATASETS = {
  apt_trade: { path: "RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev", label: "아파트 매매(상세)", since: "200601", areaField: "전용면적_㎡", kind: "trade" },
  apt_rent: { path: "RTMSDataSvcAptRent/getRTMSDataSvcAptRent", label: "아파트 전월세", since: "201101", areaField: "전용면적_㎡", kind: "rent" },
  nrg_trade: { path: "RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade", label: "상업업무용 부동산 매매", since: "200601", areaField: "건물면적_㎡", kind: "trade" },
  land_trade: { path: "RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade", label: "토지 매매", since: "200601", areaField: "거래면적_㎡", kind: "trade" },
};
export const RTMS_UNAPPROVED = [
  "오피스텔 매매(RTMSDataSvcOffiTrade)",
  "오피스텔 전월세(RTMSDataSvcOffiRent)",
  "연립다세대 매매(RTMSDataSvcRHTrade)",
  "연립다세대 전월세(RTMSDataSvcRHRent)",
  "단독/다가구 매매(RTMSDataSvcSHTrade)",
  "단독/다가구 전월세(RTMSDataSvcSHRent)",
  "아파트 매매 기본(RTMSDataSvcAptTrade — 상세판 AptTradeDev는 승인됨)",
  "분양권전매(RTMSDataSvcSilvTrade)",
  "공장·창고 등 매매(RTMSDataSvcInduTrade)",
];

const s = (v) => {
  const t = trimStr(v === undefined || v === null ? null : String(v));
  return t;
};
const ymdOf = (it) => {
  const y = String(it.dealYear ?? "");
  const m = String(it.dealMonth ?? "").padStart(2, "0");
  const d = String(it.dealDay ?? "").padStart(2, "0");
  return y && it.dealMonth ? `${y}-${m}-${d}` : null;
};
const cancelInfo = (it) => (s(it.cdealType) === "O" ? { 해제: true, 해제사유발생일: s(it.cdealDay) } : { 해제: false });
const lotNo = (it) => {
  if (it.jibun !== undefined && it.jibun !== null && String(it.jibun).trim()) return String(it.jibun).trim();
  return null;
};

const NORMALIZE = {
  apt_trade: (it) => ({
    계약일: ymdOf(it),
    법정동: s(it.umdNm),
    단지명: s(it.aptNm),
    동: s(it.aptDong),
    층: toNum(it.floor),
    "전용면적_㎡": toNum(it.excluUseAr),
    거래금액_만원: toNum(it.dealAmount),
    건축년도: toNum(it.buildYear),
    지번: lotNo(it),
    도로명: [s(it.roadNm), s(it.roadNmBonbun) ? String(Number(it.roadNmBonbun)) + (Number(it.roadNmBubun) ? `-${Number(it.roadNmBubun)}` : "") : null].filter(Boolean).join(" ") || null,
    거래유형: s(it.dealingGbn),
    매도자: s(it.slerGbn),
    매수자: s(it.buyerGbn),
    중개사소재지: s(it.estateAgentSggNm),
    등기일자: s(it.rgstDate),
    토지임대부: s(it.landLeaseholdGbn) === "Y",
    ...cancelInfo(it),
    _단지일련번호: s(it.aptSeq),
    _시군구코드: s(it.sggCd),
  }),
  apt_rent: (it) => {
    const dep = toNum(it.deposit);
    const rent = toNum(it.monthlyRent);
    return {
      계약일: ymdOf(it),
      법정동: s(it.umdNm),
      단지명: s(it.aptNm),
      층: toNum(it.floor),
      "전용면적_㎡": toNum(it.excluUseAr),
      전월세구분: rent ? "월세" : "전세",
      보증금_만원: dep,
      월세_만원: rent,
      계약구분: s(it.contractType),
      계약기간: s(it.contractTerm),
      갱신요구권사용: s(it.useRRRight) === "사용",
      종전보증금_만원: toNum(it.preDeposit),
      종전월세_만원: toNum(it.preMonthlyRent),
      건축년도: toNum(it.buildYear),
      지번: lotNo(it),
      도로명: s(it.roadnm),
      _단지일련번호: s(it.aptSeq),
      _시군구코드: s(it.sggCd),
    };
  },
  nrg_trade: (it) => ({
    계약일: ymdOf(it),
    시군구: s(it.sggNm),
    법정동: s(it.umdNm),
    건물유형: s(it.buildingType),
    건물주용도: s(it.buildingUse),
    용도지역: s(it.landUse),
    "건물면적_㎡": toNum(it.buildingAr),
    "대지면적_㎡": toNum(it.plottageAr),
    거래금액_만원: toNum(it.dealAmount),
    층: toNum(it.floor),
    건축년도: toNum(it.buildYear),
    지번_마스킹: lotNo(it),
    지분거래: s(it.shareDealingType) === "지분",
    거래유형: s(it.dealingGbn),
    매도자: s(it.slerGbn),
    매수자: s(it.buyerGbn),
    중개사소재지: s(it.estateAgentSggNm),
    ...cancelInfo(it),
    _시군구코드: s(it.sggCd),
  }),
  land_trade: (it) => ({
    계약일: ymdOf(it),
    시군구: s(it.sggNm),
    법정동: s(it.umdNm),
    지목: s(it.jimok),
    용도지역: s(it.landUse),
    "거래면적_㎡": toNum(it.dealArea),
    거래금액_만원: toNum(it.dealAmount),
    지번_마스킹: lotNo(it),
    지분거래: s(it.shareDealingType) === "지분",
    거래유형: s(it.dealingGbn),
    중개사소재지: s(it.estateAgentSggNm),
    ...cancelInfo(it),
    _시군구코드: s(it.sggCd),
  }),
};

/** 한 페이지 호출 */
async function fetchPage(ds, lawd, ym, pageNo, numOfRows, meter) {
  const { header, body } = await dataGoGet(BASE + RTMS_DATASETS[ds].path, { _type: "json", LAWD_CD: lawd, DEAL_YMD: ym, numOfRows, pageNo }, { meter, source: SOURCE });
  if (header.resultCode && !["000", "00"].includes(String(header.resultCode)))
    throw new UpstreamError(`${SOURCE}: ${header.resultMsg} (resultCode ${header.resultCode})`, "UPSTREAM");
  const items = asArray(body.items);
  return { items, total: Number(body.totalCount ?? 0) };
}

/**
 * (시군구 × 월) 단위 작업 목록을 호출 예산·시간 안에서 처리한다.
 * - countOnly면 numOfRows=0으로 건수만(작업당 1회).
 * - 아니면 1000행 페이지로 totalCount까지 받는다. 받은 행 수가 totalCount보다 적으면 미수신으로 보고한다.
 */
export async function fetchDeals({ dataset, lawdCodes, months, countOnly = false, maxCalls = 40, deadlineMs = 45000 }, meter) {
  const norm = NORMALIZE[dataset];
  const t0 = Date.now();
  const tasks = [];
  for (const lawd of lawdCodes) for (const ym of months) tasks.push({ lawd, ym });
  const results = [];
  let budgetStop = false;
  let timeStop = false;
  const canCall = () => {
    if (meter.calls >= maxCalls) return !(budgetStop = true);
    if (Date.now() - t0 > deadlineMs) return !(timeStop = true);
    return true;
  };
  await mapLimit(tasks, 3, async (t) => {
    const r = { 시군구코드: t.lawd, 월: dashed(t.ym), 전체건수: null, 수신건수: 0, rows: [], 상태: "미조회" };
    results.push(r);
    if (!canCall()) return;
    try {
      const first = await fetchPage(dataset, t.lawd, t.ym, 1, countOnly ? 0 : RTMS_PAGE, meter);
      r.전체건수 = first.total;
      if (countOnly) {
        r.상태 = "건수만";
        return;
      }
      r.rows.push(...first.items);
      const pages = Math.ceil(first.total / RTMS_PAGE);
      for (let p = 2; p <= pages; p++) {
        if (!canCall()) {
          r.상태 = "일부";
          break;
        }
        const pg = await fetchPage(dataset, t.lawd, t.ym, p, RTMS_PAGE, meter);
        r.rows.push(...pg.items);
        if (!pg.items.length) break; // 진행은 실제 받은 행으로 판단한다
      }
      r.수신건수 = r.rows.length;
      if (r.상태 === "미조회") r.상태 = r.수신건수 >= r.전체건수 ? "완료" : "일부";
    } catch (e) {
      r.상태 = "오류";
      r.오류 = e.message;
      if (e.code === "RATE_LIMIT" || e.code === "UNAPPROVED" || e.code === "NO_KEY" || e.code === "BAD_KEY") throw e;
    }
  });
  const order = new Map(tasks.map((t, i) => [`${t.lawd}:${dashed(t.ym)}`, i]));
  results.sort((a, b) => order.get(`${a.시군구코드}:${a.월}`) - order.get(`${b.시군구코드}:${b.월}`));
  const rows = results.flatMap((r) => r.rows.map(norm));
  for (const r of results) delete r.rows;
  return { results, rows, budgetStop, timeStop, elapsedMs: Date.now() - t0 };
}

/** 통계 — 해제 건 제외 여부를 고를 수 있다. 면적당 금액은 만원/㎡, 3.3㎡(평)당도 함께 */
export function dealStats(dataset, rows, { includeCancelled = false } = {}) {
  const ds = RTMS_DATASETS[dataset];
  const use = includeCancelled ? rows : rows.filter((r) => !r.해제);
  const out = { 대상건수: use.length, 해제건수: rows.filter((r) => r.해제).length, 해제포함: includeCancelled };
  const byMonth = {};
  for (const r of use) {
    const m = (r.계약일 || "").slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  out.월별건수 = byMonth;
  if (ds.kind === "trade") {
    out.거래금액_만원 = stats(use.map((r) => r.거래금액_만원));
    const per = use.map((r) => (r.거래금액_만원 && r[ds.areaField] ? r.거래금액_만원 / r[ds.areaField] : null));
    const st = stats(per);
    out["㎡당금액_만원"] = st;
    if (st.건수) out["3.3㎡당금액_만원(중위)"] = round(st.중위 * 3.305785, 0);
  } else {
    const jeonse = use.filter((r) => r.전월세구분 === "전세");
    const wolse = use.filter((r) => r.전월세구분 === "월세");
    out.전세 = { 건수: jeonse.length, 보증금_만원: stats(jeonse.map((r) => r.보증금_만원)) };
    out.월세 = { 건수: wolse.length, 보증금_만원: stats(wolse.map((r) => r.보증금_만원)), 월세_만원: stats(wolse.map((r) => r.월세_만원)) };
    out.갱신계약건수 = use.filter((r) => r.계약구분 === "갱신").length;
    out.갱신요구권사용건수 = use.filter((r) => r.갱신요구권사용).length;
  }
  return out;
}

// ── 법정동코드로 시군구 이름 해석 ───────────────────────────────────────────
const REGION_URL = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList";
const regionCache = new Lru(100);

async function regionSearch(name, meter) {
  const ck = name;
  const hit = regionCache.get(ck);
  if (hit) {
    meter.cacheHits++;
    return hit;
  }
  const key = envKey(DATA_PORTAL_ENV);
  if (!key) throw new UpstreamError(`서버에 ${DATA_PORTAL_ENV} 환경변수가 설정되어 있지 않습니다.`, "NO_KEY");
  const url = `${REGION_URL}?${qs({ serviceKey: key, type: "json", pageNo: 1, numOfRows: 1000, locatadd_nm: name })}`;
  let text;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await httpGet(url, { meter, source: "행정안전부 법정동코드" });
    if (r.status === 429) throw new UpstreamError("법정동코드 API가 HTTP 429(호출 과다)를 돌려줬습니다.", "RATE_LIMIT");
    text = r.text;
    if (text.trim()) break;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new UpstreamError(`법정동코드 응답을 읽지 못했습니다: ${String(text).slice(0, 120)}`, "UPSTREAM");
  }
  const arr = j?.StanReginCd;
  let rows = [];
  if (Array.isArray(arr)) rows = arr.find((x) => x.row)?.row ?? [];
  else {
    const code = String(j?.RESULT?.resultCode ?? j?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode ?? "");
    if (code !== "INFO-3") throw new UpstreamError(`법정동코드 조회 실패: ${JSON.stringify(j).slice(0, 160)}`, "UPSTREAM");
  }
  regionCache.set(ck, rows);
  return rows;
}

/** 질의 토큰이 이름 토큰의 부분수열로 맞는지 — 마지막 토큰은 완전일치, 앞 토큰은 접두 일치("서울" ⊂ "서울특별시") */
function tokensMatch(qTokens, nameTokens, loose = false) {
  const ql = qTokens[qTokens.length - 1];
  const nl = nameTokens[nameTokens.length - 1];
  if (loose ? !nl.startsWith(ql) : ql !== nl) return false;
  let j = 0;
  for (let i = 0; i < qTokens.length - 1; i++) {
    while (j < nameTokens.length - 1 && !nameTokens[j].startsWith(qTokens[i])) j++;
    if (j >= nameTokens.length - 1) return false;
    j++;
  }
  return true;
}

/**
 * 시군구 이름 → LAWD_CD 목록.
 * "강남구"·"서울 강남구"·"성남시 분당구"·"화성시"(→ 하위 구로 펼침).
 * 같은 이름이 여러 시도에 있으면(중구 등) 후보를 돌려주고 고르게 한다.
 */
export async function resolveLawd(region, meter) {
  const qTokens = String(region).trim().split(/\s+/).filter(Boolean);
  const rows = await regionSearch(qTokens[qTokens.length - 1], meter);
  // 시군구 단위 행: 읍면동 코드 000·리 코드 00 (시도 행은 sgg_cd 000)
  const sgg = rows
    .filter((r) => String(r.umd_cd) === "000" && String(r.ri_cd) === "00" && String(r.sgg_cd) !== "000")
    .map((r) => ({ 코드: String(r.region_cd).slice(0, 5), 이름: trimStr(r.locatadd_nm) }));
  let cands = sgg.filter((c) => tokensMatch(qTokens, c.이름.split(" ")));
  // 완전일치가 없으면 접두 일치("세종" → "세종특별자치시")
  if (!cands.length) cands = sgg.filter((c) => tokensMatch(qTokens, c.이름.split(" "), true));
  if (cands.length === 1) {
    const p = cands[0];
    const kids = sgg.filter((c) => c.이름.startsWith(p.이름 + " "));
    if (kids.length)
      return { 해석: "하위구로 펼침", 지역: kids, 안내: `${p.이름}(${p.코드})는 일반구가 있어 시 코드로 조회하면 0건입니다(과거 월 포함, 실측). 하위 구 ${kids.length}개 코드로 조회합니다.` };
    return { 해석: "단일", 지역: cands };
  }
  return { 해석: cands.length ? "모호" : "없음", 후보: (cands.length ? cands : sgg).slice(0, 30) };
}

export function monthsBetween(fromYm, toYm) {
  return ymRange(fromYm, toYm);
}
export function currentYm() {
  return nowKst().toISOString().slice(0, 7).replace("-", "");
}
export { addMonths };
