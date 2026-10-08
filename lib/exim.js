// market-macro-mcp / lib/exim.js
//
// 한국수출입은행 Open API — 환율(AP01)·대출금리(AP02)·국제금리(AP03).
//   공식 안내: https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C (환율)
//             …apino=3 (대출금리) / …apino=4 (국제금리)
//
// ── 실측으로 확인한 함정 (2026-10-08) ───────────────────────────────────────
//
// ★★ **data 코드마다 엔드포인트가 다르다.** 명세 예시가 모두 exchangeJSON이라 AP02·AP03도
//   거기로 보내기 쉬운데, 그러면 result 2(DATA코드 오류)만 돌아온다.
//     AP01 → /site/program/financial/exchangeJSON
//     AP02 → /site/program/financial/interestJSON
//     AP03 → /site/program/financial/internationalJSON   (배열이 아니라 객체로 온다)
//   인증키는 셋 다 같은 키 하나로 된다.
//
// ★★ 옛 도메인 www.koreaexim.go.kr은 2026-04-30 병행 가동이 끝났다. oapi.koreaexim.go.kr만 쓴다.
//
// ★ 일일제한 1,000회(세 API 공통 표기, 2020-07-13부터). 넘으면 result 4 + 데이터 미제공.
//   재시도해도 소용없으므로 즉시 멈추고 알린다.
// ★ result 3(인증코드 오류)은 개인정보 보유기간(2년) 만료로 키가 파기된 경우가 많다(공식 안내).
//
// ★ 날짜별 응답(AP01):
//   - 주말·공휴일·미래 → HTTP 200 + [] (빈 배열). 형식이 틀린 날짜(20261307)는 200 + 빈 본문.
//     실측: 2026-10-05(개천절 대체공휴일)·10-04(일)·10-09(미래) 모두 [].
//   - 명세는 "영업당일 11시 이전에는 null"이라 하지만 2026-10-08 10:04 KST에 당일 자료가 이미 나왔다.
//     그래서 "11시 전이라 없다"고 단정하지 않고, 빈 응답이면 하루씩 거슬러 간다.
//   - 2005-01-03 자료까지 조회됐다(USD 1,036.6). 2010년 이전에는 통화 31종(옛 유럽 통화 포함).
//   - 통화코드는 JPY(100)·IDR(100)처럼 100단위 표시가 붙는다 → 표시단위로 분리해 돌려준다.
//   - 값은 "1,343.4" 같은 쉼표 문자열 → 숫자로 바꾼다.
// ★ AP02(수은채 유통수익률 41개 기간): 주말·공휴일에도 직전 값을 그대로 준다(빈 배열이 아님).
//   그래서 AP02만으로는 그날이 영업일인지 알 수 없다 → 영업일 판정은 AP01로 한다.
//   먼 미래(2026-12-31)는 []. 2015-01-05는 81행, 2010-01-04는 8행으로 기간 구성이 시대별로 다르다.
// ★ AP03: 영업일에는 SOFR·ESTR·EURIBOR·TONA·TIBOR·SWAP(RFR)·SWAP·CIRR(신) 목록이 차고,
//   주말·한국 공휴일에는 SOFR·ESTR·TONA 3개만 찬다(부분 자료). 미래일은 new_cirr_list만 남는다.
//   new_cirr_list에는 기간명(sfln_intrc_nm)이 null이다. 명세 변경이력(2023-07-15)상
//   고시 구분이 3년~10년 8개이므로, 통화별 8개일 때만 순서대로 3년…10년 라벨을 붙인다.

import { UpstreamError, httpGet, envKey, toNum, trimStr, todayKst, addDays, isWeekend, dashed, weekday, WEEKDAY_KO, kstHour, Lru, round } from "./common.js";

const BASE = "https://oapi.koreaexim.go.kr/site/program/financial/";
export const EXIM_TYPES = {
  AP01: { ep: "exchangeJSON", label: "환율" },
  AP02: { ep: "interestJSON", label: "대출금리(수은채 유통수익률)" },
  AP03: { ep: "internationalJSON", label: "국제금리" },
};
export const EXIM_DAILY_LIMIT = 1000;
const SOURCE = "수출입은행";

const AP03_LISTS = {
  sofr_list: "SOFR",
  estr_list: "ESTR",
  euribor_list: "EURIBOR",
  tona_list: "TONA",
  tibor_list: "TIBOR",
  swapRfr_list: "SWAP(RFR)",
  swap_list: "SWAP",
  libor_list: "LIBOR",
  cirr_list: "CIRR(구)",
  new_cirr_list: "CIRR",
};
// 영업일에만 차는 목록(주말·공휴일엔 비어 있음 — 실측)
const AP03_FULL_LISTS = ["euribor_list", "tibor_list", "swapRfr_list", "swap_list", "libor_list", "cirr_list"];
const AP03_DAILY_LISTS = ["sofr_list", "estr_list", "tona_list", ...AP03_FULL_LISTS];
const NEW_CIRR_TERMS = ["3년", "4년", "5년", "6년", "7년", "8년", "9년", "10년"];

const cache = new Lru(200);

function resultCode(j) {
  if (Array.isArray(j)) return j.length ? j[0].result : null;
  return j && typeof j === "object" ? j.result : null;
}

/**
 * 원본 한 건 조회. 반환: { empty:boolean, raw } — 빈 배열·빈 본문이면 empty.
 * 과거 날짜의 비어 있지 않은 응답만 캐시한다(당일·미래·빈 응답은 시간이 지나면 바뀔 수 있다).
 */
export async function fetchExim(type, ymd, meter) {
  const t = EXIM_TYPES[type];
  if (!t) throw new UpstreamError(`알 수 없는 data 코드: ${type}`, "BAD_PARAM");
  const key = envKey("EXIM_API_KEY");
  if (!key) throw new UpstreamError("서버에 EXIM_API_KEY 환경변수가 설정되어 있지 않습니다.", "NO_KEY");
  const ck = `${type}:${ymd}`;
  const hit = cache.get(ck);
  if (hit) {
    if (meter) meter.cacheHits++;
    return { empty: false, raw: hit };
  }
  const url = `${BASE}${t.ep}?authkey=${encodeURIComponent(key)}&searchdate=${ymd}&data=${type}`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, text } = await httpGet(url, { meter, source: SOURCE, timeoutMs: 20000 });
    if (status === 429) throw new UpstreamError("수출입은행이 HTTP 429(호출 과다)를 돌려줬습니다. 재시도하지 말고 나중에 다시 조회하세요.", "RATE_LIMIT");
    if (status >= 500) {
      last = new UpstreamError(`수출입은행 서버 오류 HTTP ${status}${text.trim() ? ` (${text.trim().slice(0, 100)})` : ""} — 연결 장애로 보입니다. 잠시 후 다시 조회하세요.`, "UPSTREAM");
      continue;
    }
    if (status !== 200) throw new UpstreamError(`수출입은행 응답 HTTP ${status}`, "UPSTREAM");
    if (!text.trim()) return { empty: true, raw: null, reason: "빈 본문" };
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new UpstreamError(`수출입은행 응답을 JSON으로 읽지 못했습니다: ${text.slice(0, 120)}`, "UPSTREAM");
    }
    const rc = resultCode(j);
    if (rc === 4) throw new UpstreamError(`수출입은행 일일제한횟수(${EXIM_DAILY_LIMIT}회) 마감(result 4). 재시도해도 데이터가 오지 않으니 내일 다시 조회하세요.`, "RATE_LIMIT");
    if (rc === 3) throw new UpstreamError("수출입은행 인증코드 오류(result 3). 키가 틀렸거나, 개인정보 보유기간(2년) 만료로 키가 파기됐을 수 있습니다(공식 안내) — 수출입은행 Open API에서 재발급하세요.", "BAD_KEY");
    if (rc === 2) throw new UpstreamError(`수출입은행 DATA코드 오류(result 2) — ${type}는 ${t.ep} 엔드포인트로 보내야 합니다.`, "UPSTREAM");
    if (Array.isArray(j) && j.length === 0) return { empty: true, raw: null, reason: "빈 배열" };
    if (rc !== 1) throw new UpstreamError(`수출입은행 알 수 없는 result 값: ${rc}`, "UPSTREAM");
    if (ymd < todayKst()) {
      // AP03는 부분 자료(주말)도 그대로 캐시해도 된다 — 과거 날짜 응답은 바뀌지 않는다
      cache.set(ck, j);
    }
    return { empty: false, raw: j };
  }
  throw last;
}

// ── 정규화 ───────────────────────────────────────────────────────────────────
export function normalizeFx(rows) {
  return rows.map((r) => {
    const m = String(r.cur_unit || "").match(/^([A-Z]{3})(?:\((\d+)\))?$/);
    const unit = m && m[2] ? Number(m[2]) : 1;
    return {
      통화코드: m ? m[1] : r.cur_unit,
      원문통화코드: r.cur_unit,
      통화명: trimStr(r.cur_nm),
      표시단위: unit,
      매매기준율: toNum(r.deal_bas_r),
      전신환_받을때: toNum(r.ttb),
      전신환_보낼때: toNum(r.tts),
      장부가격: toNum(r.bkpr),
      년환가료율: toNum(r.yy_efee_r),
      "10일환가료율": toNum(r.ten_dd_efee_r),
      서울외국환중개_매매기준율: toNum(r.kftc_deal_bas_r),
      서울외국환중개_장부가격: toNum(r.kftc_bkpr),
    };
  });
}

export function normalizeLoan(rows) {
  return rows.map((r) => ({ 대출기간: trimStr(r.sfln_intrc_nm), 고정기준금리: toNum(r.int_r) }));
}

export function ap03Completeness(obj) {
  if (!obj || typeof obj !== "object") return "없음";
  const n = (k) => (Array.isArray(obj[k]) ? obj[k].length : 0);
  if (AP03_FULL_LISTS.some((k) => n(k) > 0)) return "완전";
  if (AP03_DAILY_LISTS.some((k) => n(k) > 0)) return "부분";
  return "없음";
}

export function normalizeIntl(obj) {
  const out = [];
  for (const [k, label] of Object.entries(AP03_LISTS)) {
    const arr = Array.isArray(obj[k]) ? obj[k] : [];
    if (k === "new_cirr_list") {
      const byCur = {};
      for (const r of arr) (byCur[r.cur_fund] = byCur[r.cur_fund] || []).push(r);
      for (const [cur, list] of Object.entries(byCur)) {
        list.forEach((r, i) => {
          out.push({
            구분: label,
            통화: cur,
            기간: trimStr(r.sfln_intrc_nm) || (list.length === NEW_CIRR_TERMS.length ? NEW_CIRR_TERMS[i] : `순번${i + 1}`),
            금리: toNum(r.int_r),
          });
        });
      }
      continue;
    }
    for (const r of arr) out.push({ 구분: label, 통화: trimStr(r.cur_fund), 기간: trimStr(r.sfln_intrc_nm), 금리: toNum(r.int_r) });
  }
  return out;
}

function emptyReason(ymd) {
  const today = todayKst();
  if (isWeekend(ymd)) return "주말";
  if (ymd === today && kstHour() < 12) return "당일 고시 전(영업일 11시 전후 갱신)이거나 공휴일";
  if (ymd >= today) return "당일 미고시 또는 미래";
  return "공휴일 등 비영업일(자료 없음)";
}

/**
 * 기준일 결정 + 거슬러 조회.
 * - 주말은 호출하지 않고 건너뛴다.
 * - 영업일 판정은 AP01(빈 배열 여부)로 한다. AP02는 휴일에도 직전 값을 주기 때문이다.
 * - AP03만 요청하면 AP03 목록 완전성(EURIBOR·TIBOR·SWAP 등)으로 판정한다.
 */
export async function getRates({ date, types = ["AP01"], currencies, exact = false, maxBack = 10 }, meter) {
  const today = todayKst();
  const notes = [];
  let start = date || today;
  if (start > today) {
    notes.push(`요청일 ${dashed(start)}이 미래라 오늘(${dashed(today)})부터 조회했습니다.`);
    start = today;
  }
  const anchorType = types.includes("AP01") || types.includes("AP02") ? "AP01" : "AP03";
  const skipped = [];
  let used = null;
  const got = {};
  for (let i = 0, d = start; i <= (exact ? 0 : maxBack); i++, d = addDays(d, -1)) {
    if (isWeekend(d) && !exact) {
      skipped.push({ 날짜: dashed(d), 사유: `주말(${WEEKDAY_KO[weekday(d)]}) — 호출 생략` });
      continue;
    }
    const r = await fetchExim(anchorType, d, meter);
    if (anchorType === "AP03") {
      const c = r.empty ? "없음" : ap03Completeness(r.raw);
      if (c === "완전") {
        used = d;
        got.AP03 = r.raw;
        break;
      }
      skipped.push({ 날짜: dashed(d), 사유: c === "부분" ? "국제금리 부분 자료(SOFR·ESTR·TONA만) — 비영업일로 판단" : emptyReason(d) });
      continue;
    }
    if (!r.empty) {
      used = d;
      got.AP01 = r.raw;
      break;
    }
    skipped.push({ 날짜: dashed(d), 사유: emptyReason(d) });
  }
  if (!used) {
    const why = exact
      ? `${dashed(start)}에는 자료가 없습니다(${skipped[0]?.사유 || "비영업일"}). exact=false로 두면 직전 영업일로 보정합니다.`
      : `${dashed(start)}부터 ${maxBack}일을 거슬러도 자료가 없습니다.`;
    throw new UpstreamError(why, "NO_DATA", { skipped });
  }
  if (skipped.length) notes.push(`${skipped.map((s) => `${s.날짜}(${s.사유})`).join(", ")} — 자료가 없어 ${dashed(used)} 자료를 사용했습니다.`);

  const out = { 요청기준일: date ? dashed(date) : "(생략 — 오늘)", 사용기준일: dashed(used), 건너뛴날짜: skipped };
  if (types.includes("AP01")) {
    let fx = normalizeFx(got.AP01);
    const all = fx.length;
    let missing = [];
    if (currencies && currencies.length) {
      const want = currencies.map((c) => c.toUpperCase().replace(/\(.*\)$/, "").trim());
      missing = want.filter((c) => !fx.some((r) => r.통화코드 === c));
      fx = fx.filter((r) => want.includes(r.통화코드));
    }
    out.환율 = { 전체통화수: all, 반환통화수: fx.length, ...(missing.length ? { 미발견통화: missing } : {}), 단위: "원(KRW). 표시단위 100이면 100단위 통화당 원(예: JPY(100))", 행: fx };
  }
  if (types.includes("AP02")) {
    const r = await fetchExim("AP02", used, meter);
    out.대출금리 = r.empty
      ? { 오류: `${dashed(used)} 대출금리 자료가 비어 있습니다.` }
      : { 설명: "수은채 유통수익률(고정기준금리, %)", 행: normalizeLoan(r.raw) };
    if (anchorType === "AP01" && !types.includes("AP01")) notes.push("대출금리(AP02)는 휴일에도 직전 값을 주므로, 영업일 판정을 위해 환율(AP01)을 1회 함께 호출했습니다.");
  }
  if (types.includes("AP03")) {
    let raw = got.AP03;
    if (!raw) {
      const r = await fetchExim("AP03", used, meter);
      raw = r.empty ? null : r.raw;
    }
    if (!raw) out.국제금리 = { 오류: `${dashed(used)} 국제금리 자료가 비어 있습니다.` };
    else {
      const comp = ap03Completeness(raw);
      const rows = normalizeIntl(raw);
      const counts = {};
      for (const r of rows) counts[r.구분] = (counts[r.구분] || 0) + 1;
      out.국제금리 = { 자료완전성: comp, 구분별건수: counts, 단위: "%", 행: rows };
      if (comp === "부분") notes.push("국제금리가 부분 자료(SOFR·ESTR·TONA만)입니다 — 한국 비영업일에는 나머지 목록이 비어 옵니다.");
      notes.push("CIRR 기간 라벨(3년~10년)은 원문에 없어 명세 변경이력(2023-07-15) 순서로 붙였습니다.");
    }
  }
  return { ...out, notes };
}

/** 표본 날짜 계획 — interval: day(모든 평일) | week(주 마지막 평일) | month(월 마지막 평일) */
export function planSamples(from, to, interval) {
  const out = [];
  if (interval === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
    return out;
  }
  // 구간 끝(주의 금요일 / 월말)에서 평일로 맞춘 날짜를 대표일로 쓴다
  const buckets = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    let k;
    if (interval === "week") {
      const w = weekday(d); // 월=1 … 금=5
      k = addDays(d, -(w - 1)); // 그 주 월요일
    } else k = d.slice(0, 6);
    buckets.set(k, d); // 마지막 평일이 남는다
  }
  return [...buckets.values()];
}

/** 환율 시계열 */
export async function getFxSeries({ currencies, from, to, interval = "week", maxCalls = 60, fallbackDays = 4, deadlineMs = 45000 }, meter) {
  const t0 = Date.now();
  const samples = planSamples(from, to, interval);
  const want = currencies.map((c) => c.toUpperCase().replace(/\(.*\)$/, "").trim());
  const series = Object.fromEntries(want.map((c) => [c, []]));
  const names = {};
  const skippedSamples = [];
  let stoppedAt = null;
  let stopReason = null;
  const notes = [];
  for (const s of samples) {
    if (meter.calls >= maxCalls || Date.now() - t0 > deadlineMs) {
      stoppedAt = s;
      stopReason = meter.calls >= maxCalls ? `원천 호출 상한(max_calls=${maxCalls})` : `응답 시간 상한(${deadlineMs / 1000}초)`;
      break;
    }
    let d = s;
    let rows = null;
    const tries = interval === "day" ? 1 : fallbackDays + 1;
    for (let i = 0; i < tries && meter.calls < maxCalls; i++, d = addDays(d, -1)) {
      if (isWeekend(d)) continue;
      if (d > todayKst()) continue;
      const r = await fetchExim("AP01", d, meter);
      if (!r.empty) {
        rows = normalizeFx(r.raw);
        break;
      }
    }
    if (!rows) {
      skippedSamples.push(dashed(s));
      continue;
    }
    for (const c of want) {
      const row = rows.find((x) => x.통화코드 === c);
      if (row) {
        names[c] = `${row.통화명}${row.표시단위 > 1 ? ` (${row.표시단위}단위)` : ""}`;
        series[c].push({ 기준일: dashed(d), 매매기준율: row.매매기준율 });
      }
    }
  }
  const missing = want.filter((c) => series[c].length === 0);
  const result = want
    .filter((c) => series[c].length)
    .map((c) => {
      const pts = series[c];
      const vals = pts.map((p) => p.매매기준율).filter((v) => v !== null);
      const first = pts[0].매매기준율;
      const last = pts[pts.length - 1].매매기준율;
      return {
        통화코드: c,
        통화명: names[c],
        관측수: pts.length,
        시작: pts[0],
        끝: pts[pts.length - 1],
        최고: Math.max(...vals),
        최저: Math.min(...vals),
        평균: round(vals.reduce((a, b) => a + b, 0) / vals.length),
        변화율_퍼센트: first && last ? round(((last - first) / first) * 100) : null,
        값: pts,
      };
    });
  if (skippedSamples.length) notes.push(`${skippedSamples.length}개 표본일은 ${interval === "day" ? "비영업일(공휴일)이라" : `대표일부터 ${fallbackDays}일을 거슬러도`} 자료가 없어 뺐습니다: ${skippedSamples.slice(0, 10).join(", ")}${skippedSamples.length > 10 ? " …" : ""}`);
  if (stoppedAt) notes.push(`${stopReason}에 걸려 ${dashed(stoppedAt)} 이후 표본은 조회하지 않았습니다. 기간을 나누거나 interval을 넓히세요(일일 한도 ${EXIM_DAILY_LIMIT}회 공유).`);
  return { 표본수_계획: samples.length, 시계열: result, 미발견통화: missing, 잘림: !!stoppedAt, ...(stoppedAt ? { 미조회시작표본: dashed(stoppedAt) } : {}), notes };
}
