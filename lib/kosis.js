// market-macro-mcp / lib/kosis.js
//
// KOSIS(국가통계포털) Open API 범용 클라이언트 — 통계표 검색·메타·자료 조회.
//
// ── 실측으로 확인한 함정 (2026-09-14 최초, 2026-10-08 재실측) ────────────────
//
// ★★ 메타와 자료의 엔드포인트가 다르다.
//     메타  method=getMeta  → https://kosis.kr/openapi/statisticsData.do
//     자료  method=getList  → https://kosis.kr/openapi/Param/statisticsParameterData.do
//   getMeta를 Param/… 쪽으로 보내면 err 20("필수요청변수값이 누락")만 온다.
// ★ getMeta type: ITM(항목+분류 코드 전부)·PRD(주기별 수록기간)·TBL(표 이름)·CMMT(주석)·SOURCE(출처)는 된다.
//   type=OBJ·UNIT은 err 30("데이터가 존재하지 않습니다")을 준다 — 쓰지 않는다.
// ★★ objL 레벨 수는 표마다 다르다. 부족하면 err 20 "(objL)", 많으면 err 21 "잘못된 요청 변수" —
//   둘 다 몇 개가 맞는지는 말해주지 않는다. 그런데 ITM 메타의 분류 행에 OBJ_ID_SN(레벨 순번)이
//   있어서, ITEM이 아닌 OBJ_ID의 개수가 곧 필요한 objL 수다(DT_1J22003=1, DT_MLTM_5498=3 실측).
//   그래서 자료 호출 전에 메타로 레벨 수를 맞춰 err 20/21을 미리 막는다.
// ★★ 40,000셀 상한(err 31)은 반환 행이 아니라 **선언된 교차곱**으로 계산된다.
//     셀 = 항목 수 × Π(레벨별 코드 수) × 시점 수
//   실측(DT_MLTM_5498, 시군구=계 고정 → 월 360셀): 111개월 39,960셀 정상(실제 37,380행) /
//   112개월 40,320셀 err 31. 항목 1개·전 분류 ALL(월 22,500셀): 1개월 정상, 2개월 err 31.
//   단, **시점 수는 실제 수록된 시점만 센다** — 2019-01~2028-04(112개월 선언, 수록 92개월)는 정상이었다.
//   그래서 시점 수는 PRD 메타의 수록기간과 겹치는 구간으로 계산한다.
// ★ 여러 코드는 공백으로 잇는다(objL1="T10 T11" — URL에서 + 또는 %20). 쉼표는 err 21.
// ★ 없는 코드·없는 통계표는 err 21(표는 "해당 통계표가 존재하지 않습니다"),
//   미래·과거 범위 밖·지원하지 않는 주기(prdSe)는 err 30 — "데이터 없음"과 구분되지 않는다.
// ★ 잘못된 인증키는 err 11. apiKey 파라미터가 중복되면 HTTP 404 HTML 페이지가 온다.
// ★ 응답이 크다: 37,380행 ≈ 19MB, 21초. 한 번에 받는 셀 수를 줄이는 편이 안전하다.
// ★ 검색(statisticsSearch.do)은 resultCount 5,000까지 그대로 준다(실측). startCount는 "몇 번째
//   페이지"다(행 오프셋이 아님). STAT_DB_CNT가 전체 검색 건수로 보인다(인구 114,707).

import { UpstreamError, httpGet, envKey, qs, toNum, trimStr, Lru } from "./common.js";

const META_URL = "https://kosis.kr/openapi/statisticsData.do";
const DATA_URL = "https://kosis.kr/openapi/Param/statisticsParameterData.do";
const SEARCH_URL = "https://kosis.kr/openapi/statisticsSearch.do";
const SOURCE = "KOSIS";
export const KOSIS_CELL_LIMIT = 40000;

// KOSIS 오류코드 → 한국어 안내. 11·20·21·30·31은 실측, 나머지는 KOSIS 개발가이드 표기(미실측).
export const KOSIS_ERRORS = {
  "10": "인증키 누락 — 서버의 KOSIS_API_KEY를 확인하세요.",
  "11": "인증키가 유효하지 않습니다(만료·오타). 서버의 KOSIS_API_KEY를 확인하세요.",
  "20": "필수 요청변수 누락 — objL 레벨 수가 표보다 적거나 itmId·prdSe가 빠졌습니다. kosis_get_table_meta의 필요objL수를 확인하세요.",
  "21": "잘못된 요청변수 — objL 레벨이 표보다 많거나, 없는 항목·분류 코드, 또는 없는 통계표입니다. 여러 코드는 쉼표가 아니라 공백으로 잇습니다.",
  "30": "조회 결과 없음 — 기간이 수록 범위 밖이거나, 그 표가 지원하지 않는 주기(prdSe)이거나, 코드 조합에 자료가 없습니다.",
  "31": "40,000셀 초과 — 셀 수는 항목×분류 코드 수×시점 수의 선언된 교차곱으로 계산됩니다. 코드를 줄이거나 기간을 나누세요.",
  "40": "호출 가능 건수 초과 — 재시도하지 말고 나중에 조회하세요.",
  "41": "호출 가능 행 수 초과 — 재시도하지 말고 나중에 조회하세요.",
  "42": "사용자별 이용 제한 — 재시도하지 말고 나중에 조회하세요.",
  "50": "KOSIS 서버 오류.",
};
const NON_RETRY = new Set(["40", "41", "42"]);

export const PRD_CODES = { 년: "Y", 반기: "H", 분기: "Q", 월: "M", 일: "D", 부정기: "IR", 다년: "F", 격월: "B", 주: "W" };

const metaCache = new Lru(60);

function key() {
  const k = envKey("KOSIS_API_KEY");
  if (!k) throw new UpstreamError("서버에 KOSIS_API_KEY 환경변수가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

class KosisErr extends UpstreamError {}

/** KOSIS 호출 1회 — 배열이면 성공, {err,errMsg}이면 KosisErr(code=KOSIS_xx) */
async function kosisGet(base, params, meter, { timeoutMs = 45000 } = {}) {
  const url = `${base}?${qs({ ...params, apiKey: key(), format: "json", jsonVD: "Y" })}`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, text } = await httpGet(url, { meter, source: SOURCE, timeoutMs });
    if (status === 429) throw new UpstreamError("KOSIS가 HTTP 429(호출 과다)를 돌려줬습니다. 재시도하지 말고 나중에 조회하세요.", "RATE_LIMIT");
    if (status >= 500 || !text.trim()) {
      last = new UpstreamError(status >= 500 ? `KOSIS 서버 오류 HTTP ${status}` : "KOSIS가 HTTP 200에 빈 본문을 보냈습니다.", "UPSTREAM");
      continue;
    }
    if (status !== 200) throw new UpstreamError(`KOSIS 응답 HTTP ${status}${/<html/i.test(text) ? " (HTML 오류 페이지 — 파라미터 중복·주소 오류 가능)" : ""}`, "UPSTREAM");
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new UpstreamError(`KOSIS 응답을 JSON으로 읽지 못했습니다: ${text.slice(0, 120)}`, "UPSTREAM");
    }
    if (Array.isArray(j)) return j;
    const code = String(j.err ?? "");
    const msg = String(j.errMsg ?? "").trim();
    const e = new KosisErr(`KOSIS err ${code}: ${msg} — ${KOSIS_ERRORS[code] || "알 수 없는 오류코드"}`, NON_RETRY.has(code) ? "RATE_LIMIT" : code === "11" || code === "10" ? "BAD_KEY" : `KOSIS_${code}`, { kosisCode: code, kosisMsg: msg });
    throw e;
  }
  throw last;
}

// ── 검색 ─────────────────────────────────────────────────────────────────────
export async function searchTables({ keyword, limit = 20, page = 1 }, meter) {
  let rows;
  try {
    rows = await kosisGet(SEARCH_URL, { method: "getList", searchNm: keyword, startCount: page, resultCount: limit }, meter);
  } catch (e) {
    if (e.kosisCode === "30") return { 전체건수: 0, 행: [] };
    throw e;
  }
  return {
    전체건수: toNum(rows[0]?.STAT_DB_CNT),
    행: rows.map((r) => ({
      기관ID: r.ORG_ID,
      기관명: trimStr(r.ORG_NM),
      통계표ID: r.TBL_ID,
      통계표명: trimStr(r.TBL_NM),
      조사명: trimStr(r.STAT_NM),
      수록시작: trimStr(r.STRT_PRD_DE),
      수록종료: trimStr(r.END_PRD_DE),
      분류경로: trimStr(r.MT_ATITLE),
      KOSIS화면: trimStr(r.TBL_VIEW_URL) || trimStr(r.LINK_URL),
    })),
  };
}

// ── 메타 ─────────────────────────────────────────────────────────────────────
/** PRD 메타의 "1965.01" / "1965 1/4" / "1965" / "2024 1/2" → KOSIS 시점 코드(YYYYMM/YYYYQQ/YYYY…) */
export function prdToCode(se, s) {
  const t = String(s || "").trim();
  let m;
  if ((m = t.match(/^(\d{4})\s+(\d)\/(\d)$/))) return `${m[1]}${m[2].padStart(2, "0")}`; // 분기·반기
  if ((m = t.match(/^(\d{4})\.(\d{2})\.(\d{2})$/))) return `${m[1]}${m[2]}${m[3]}`;
  if ((m = t.match(/^(\d{4})\.(\d{2})$/))) return `${m[1]}${m[2]}`;
  if ((m = t.match(/^(\d{4})$/))) return m[1];
  return t.replace(/[^0-9]/g, "");
}

export async function getMeta(orgId, tblId, meter, { withPeriods = true } = {}) {
  const ck = `${orgId}:${tblId}:${withPeriods}`;
  const hit = metaCache.get(ck);
  if (hit) {
    if (meter) meter.cacheHits++;
    return hit;
  }
  const itm = await kosisGet(META_URL, { method: "getMeta", orgId, tblId, type: "ITM" }, meter);
  let prd = [];
  let tblNm = null;
  if (withPeriods) {
    try {
      prd = await kosisGet(META_URL, { method: "getMeta", orgId, tblId, type: "PRD" }, meter);
    } catch (e) {
      if (e.kosisCode !== "30") throw e;
    }
    try {
      const tb = await kosisGet(META_URL, { method: "getMeta", orgId, tblId, type: "TBL" }, meter);
      tblNm = trimStr(tb[0]?.TBL_NM);
    } catch (e) {
      if (e.kosisCode !== "30") throw e;
    }
  }
  const items = itm
    .filter((x) => x.OBJ_ID === "ITEM")
    .map((x) => ({ 코드: x.ITM_ID, 이름: trimStr(x.ITM_NM), 단위: trimStr(x.UNIT_NM), ...(x.UP_ITM_ID ? { 상위코드: x.UP_ITM_ID } : {}) }));
  const levelMap = new Map();
  for (const x of itm) {
    if (x.OBJ_ID === "ITEM") continue;
    if (!levelMap.has(x.OBJ_ID)) levelMap.set(x.OBJ_ID, { sn: Number(x.OBJ_ID_SN) || 99, 분류ID: x.OBJ_ID, 분류명: trimStr(x.OBJ_NM), 코드: [] });
    levelMap.get(x.OBJ_ID).코드.push({ 코드: x.ITM_ID, 이름: trimStr(x.ITM_NM), ...(x.UP_ITM_ID ? { 상위코드: x.UP_ITM_ID } : {}) });
  }
  const levels = [...levelMap.values()].sort((a, b) => a.sn - b.sn).map((l, i) => ({ 파라미터: `objL${i + 1}`, 분류ID: l.분류ID, 분류명: l.분류명, 코드수: l.코드.length, 코드: l.코드 }));
  const periods = prd.map((p) => ({ 주기: trimStr(p.PRD_SE), prdSe: PRD_CODES[trimStr(p.PRD_SE)] || null, 시작: prdToCode(p.PRD_SE, p.STRT_PRD_DE), 종료: prdToCode(p.PRD_SE, p.END_PRD_DE), 원문시작: p.STRT_PRD_DE, 원문종료: p.END_PRD_DE }));
  const meta = { 기관ID: orgId, 통계표ID: tblId, 통계표명: tblNm, 항목: items, 분류: levels, 필요objL수: levels.length, 수록주기: periods };
  metaCache.set(ck, meta);
  return meta;
}

// ── 시점 수 계산 ─────────────────────────────────────────────────────────────
function periodIndex(se, code) {
  const y = +code.slice(0, 4);
  switch (se) {
    case "Y":
      return y;
    case "H":
      return y * 2 + (+code.slice(4, 6) - 1);
    case "Q":
      return y * 4 + (+code.slice(4, 6) - 1);
    case "M":
      return y * 12 + (+code.slice(4, 6) - 1);
    case "D":
      return Math.round(Date.UTC(y, +code.slice(4, 6) - 1, +code.slice(6, 8)) / 86400000);
    default:
      return null;
  }
}
const PERIOD_LEN = { Y: 4, H: 6, Q: 6, M: 6, D: 8 };

export function validatePeriod(se, code, name) {
  const len = PERIOD_LEN[se];
  if (!len) return code;
  const c = String(code).replace(/[-./\s]/g, "");
  if (!new RegExp(`^\\d{${len}}$`).test(c)) {
    const ex = { Y: "2024", H: "202401(상반기)", Q: "202403(3분기)", M: "202409", D: "20240930" }[se];
    throw new UpstreamError(`${name} 형식이 주기 ${se}와 맞지 않습니다: "${code}". 예: ${ex}`, "BAD_PARAM");
  }
  const sub = +c.slice(4, 6);
  if ((se === "Q" && (sub < 1 || sub > 4)) || (se === "H" && (sub < 1 || sub > 2)) || (se === "M" && (sub < 1 || sub > 12)))
    throw new UpstreamError(`${name}의 기간 값이 주기 ${se} 범위를 벗어났습니다: "${code}"(분기는 01~04, 반기는 01~02, 월은 01~12).`, "BAD_PARAM");
  return c;
}

/** 수록기간과 겹치는 시점 수. 계산할 수 없는 주기면 null */
export function countPeriods(se, start, end, avail) {
  if (!PERIOD_LEN[se]) return null;
  let s = start;
  let e = end;
  if (avail) {
    if (avail.시작 && s < avail.시작) s = avail.시작;
    if (avail.종료 && e > avail.종료) e = avail.종료;
  }
  if (!s || !e || s > e) return 0;
  const a = periodIndex(se, s);
  const b = periodIndex(se, e);
  return a === null || b === null ? null : b - a + 1;
}

// ── 자료 조회 ────────────────────────────────────────────────────────────────
/**
 * @param a.levels  레벨별 코드 배열의 배열 — [["T10","T11"], ["ALL"]] 또는 문자열 배열 ["T10 T11","ALL"]
 * @param a.items   항목 코드 배열 또는 ["ALL"]
 */
export async function getData(a, meter) {
  const { orgId, tblId, prdSe, start, end, recent, precheck = true } = a;
  const notes = [];
  const levels = (a.levels || []).map((l) => (Array.isArray(l) ? l : String(l).split(/[\s+,]+/)).map((x) => String(x).trim()).filter(Boolean));
  const items = (a.items && a.items.length ? a.items : ["ALL"]).flatMap((x) => String(x).split(/[\s+,]+/)).filter(Boolean);
  if (!recent && !start) throw new UpstreamError("기간을 정하세요: start(+end) 또는 recent(최근 N개 시점) 중 하나가 필요합니다.", "BAD_PARAM");
  const s = start ? validatePeriod(prdSe, start, "start") : null;
  const e = end ? validatePeriod(prdSe, end, "end") : s;
  if (s && e && s > e) throw new UpstreamError(`start(${s})가 end(${e})보다 뒤입니다.`, "BAD_PARAM");

  let meta = null;
  let estimate = null;
  if (precheck) {
    meta = await getMeta(orgId, tblId, meter);
    // 1) 레벨 수
    if (levels.length !== meta.필요objL수) {
      return {
        실행안함: true,
        사유: `이 통계표는 objL ${meta.필요objL수}개가 필요한데 ${levels.length}개를 주셨습니다(그대로 보내면 KOSIS가 ${levels.length < meta.필요objL수 ? "err 20" : "err 21"}을 줍니다).`,
        필요한분류: meta.분류.map((l) => ({ 파라미터: l.파라미터, 분류명: l.분류명, 코드수: l.코드수, 코드예시: l.코드.slice(0, 5) })),
      };
    }
    // 2) 코드 존재 여부
    const unknown = [];
    const itemCodes = new Set(meta.항목.map((x) => x.코드));
    for (const c of items) if (c !== "ALL" && !itemCodes.has(c)) unknown.push({ 파라미터: "itmId", 코드: c });
    levels.forEach((codes, i) => {
      const set = new Set(meta.분류[i].코드.map((x) => x.코드));
      for (const c of codes) if (c !== "ALL" && !set.has(c)) unknown.push({ 파라미터: `objL${i + 1}`, 분류명: meta.분류[i].분류명, 코드: c });
    });
    if (unknown.length) return { 실행안함: true, 사유: "메타에 없는 코드가 있습니다(그대로 보내면 err 21).", 없는코드: unknown, 안내: "kosis_get_table_meta로 코드를 확인하세요." };
    // 3) 주기 지원 여부
    const avail = meta.수록주기.find((p) => p.prdSe === prdSe);
    if (meta.수록주기.length && !avail)
      return { 실행안함: true, 사유: `이 통계표는 주기 ${prdSe}를 수록하지 않습니다(그대로 보내면 err 30 '데이터 없음').`, 수록주기: meta.수록주기 };
    // 4) 셀 수
    const nItems = items.includes("ALL") ? meta.항목.length : items.length;
    const perLevel = levels.map((codes, i) => (codes.includes("ALL") ? meta.분류[i].코드수 : codes.length));
    const perPeriod = nItems * perLevel.reduce((x, y) => x * y, 1);
    let nPeriods = recent ? recent : countPeriods(prdSe, s, e, avail);
    if (s && avail && nPeriods === 0)
      return { 실행안함: true, 사유: `요청 기간 ${s}~${e}이 수록기간(${avail.시작}~${avail.종료}, 주기 ${prdSe}) 밖입니다(그대로 보내면 err 30).`, 수록주기: avail };
    estimate = { 항목수: nItems, 레벨별코드수: perLevel, 시점수: nPeriods, 시점당셀: perPeriod, 예상셀수: nPeriods === null ? null : perPeriod * nPeriods, 상한: KOSIS_CELL_LIMIT };
    if (estimate.예상셀수 !== null && estimate.예상셀수 > KOSIS_CELL_LIMIT) {
      const maxP = Math.floor(KOSIS_CELL_LIMIT / perPeriod);
      return {
        실행안함: true,
        사유: `예상 셀 수 ${estimate.예상셀수.toLocaleString()}이 KOSIS 상한 40,000을 넘습니다(그대로 보내면 err 31).`,
        셀계산: estimate,
        권고: maxP >= 1 ? `현재 코드 구성으로는 한 번에 최대 ${maxP}개 시점까지 됩니다. 기간을 나누거나 ALL 대신 필요한 코드만 지정하세요.` : "시점 1개로도 상한을 넘습니다. 항목이나 분류 코드를 줄이세요(ALL 대신 코드 지정).",
      };
    }
    if (estimate.예상셀수 > 15000) notes.push(`예상 셀 ${estimate.예상셀수.toLocaleString()}개 — 응답이 수 MB이고 10초 이상 걸릴 수 있습니다(실측 37,380행 ≈ 19MB·21초).`);
  }

  const params = { method: "getList", orgId, tblId, itmId: items.join(" "), prdSe };
  levels.forEach((codes, i) => (params[`objL${i + 1}`] = codes.join(" ")));
  if (recent) params.newEstPrdCnt = recent;
  else {
    params.startPrdDe = s;
    params.endPrdDe = e;
  }
  let rows;
  try {
    rows = await kosisGet(DATA_URL, params, meter, { timeoutMs: 50000 });
  } catch (err) {
    if (err.kosisCode === "30") return { 행: [], 셀계산: estimate, notes: [...notes, "KOSIS err 30(데이터 없음): " + KOSIS_ERRORS["30"]] };
    throw err;
  }
  const levelNames = meta ? meta.분류.map((l) => l.분류명) : null;
  const out = rows.map((r) => {
    const cls = {};
    for (let i = 1; i <= 8; i++) {
      if (r[`C${i}`] === undefined) break;
      const nm = trimStr(r[`C${i}_OBJ_NM`]) || (levelNames && levelNames[i - 1]) || `분류${i}`;
      cls[nm] = trimStr(r[`C${i}_NM`]);
    }
    const v = toNum(r.DT);
    return {
      시점: r.PRD_DE,
      항목: trimStr(r.ITM_NM),
      분류: cls,
      값: v,
      ...(v === null && trimStr(r.DT) ? { 원문값: trimStr(r.DT) } : {}),
      단위: trimStr(r.UNIT_NM),
      _코드: { 항목: r.ITM_ID, ...Object.fromEntries(Object.keys(cls).map((_, i) => [`objL${i + 1}`, r[`C${i + 1}`]])) },
    };
  });
  const tblNm = trimStr(rows[0]?.TBL_NM);
  const lastChange = rows.reduce((m, r) => (r.LST_CHN_DE && r.LST_CHN_DE > m ? r.LST_CHN_DE : m), "");
  return { 통계표명: tblNm, 최종수정일: lastChange || null, 행: out, 셀계산: estimate, notes };
}
