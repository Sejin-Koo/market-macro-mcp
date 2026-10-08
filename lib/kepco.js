// market-macro-mcp / lib/kepco.js
//
// 한국전력 전력데이터 개방포털(bigdata.kepco.co.kr) Open API.
//   https://bigdata.kepco.co.kr/openapi/v1/<경로>?apiKey=…&returnType=json
//   공식 가이드: https://bigdata.kepco.co.kr/cmsmain.do?scode=S01&pcode=000493&pstate=<서비스>
//
// ── 실측으로 확인한 함정 (2026-10-08) ───────────────────────────────────────
// ★★ 지역코드 체계가 두 가지다(공통코드 API codeTy로 구분).
//     법정동 체계(lglDngMetroCd/lglDngCityCd: 서울 11·부산 26·경기 41, 강남구 680) — 계약종별·산업분류별·
//       가구평균·고객증감·요금청구방식·복지할인·분산전원
//     한전 체계(metroCd/cityCd: 서울 11·부산 21·경기 31, 강남구 26) — 전기차 충전소 설치현황
//     업종별 전력사용량은 코드가 아니라 **이름**(metro=서울특별시, city=강남구)을 받고 metroCd는 무시한다.
// ★★ 2026-07 자료부터 광주(29)·전남(46)이 '전남광주통합특별시'(12)로 합쳐져 수록된다(2026-06까지는 46·29,
//   2026-07은 12만 200). 전북은 45가 아니라 52(전북특별자치도), 강원은 51에만 자료가 있다. 공통코드에는
//   옛 코드와 새 코드가 함께 있어서, 서버는 후보 코드를 차례로 시도하고 실제로 쓴 코드를 알린다.
// ★★ 시도를 빼면 응답이 **JSON 객체 두 개를 이어 붙인 형태**다: {"totData":[전국 합계]}{"data":[시군구별]}.
//   JSON.parse가 실패하므로 객체 단위로 끊어 읽는다. 404 응답도 {"errCd":"404",…}{"errCd":"404",…}처럼 두 번 온다.
// ★ 자료 없음·없는 코드·미래 월은 모두 HTTP 404 {"errCd":"404","errMsg":"NotFound"} — 0건과 구분되지 않는다.
// ★ 필수 파라미터 누락은 HTTP 400인데 본문이 JSON이 아니다({ "errCd" : 400, "errMsg" : "month" is a required parameter. }).
// ★ month는 두 자리여야 한다("1"은 404, "01"은 정상).
// ★ 가끔 HTTP 401에 본문 "{}"(2바이트)가 온다(같은 호출을 다시 하면 200) — 일시 오류로 보고 재시도한다.
//   틀린 키는 401 {"errCd":"401","errMsg":"InvalidApiKeyException"}.
// ★ 신재생에너지(renewEnergy.do)는 metroCd를 주면 어떤 코드(11·31·41·이름)든 404다 → 전국을 받아 서버에서 거른다.
//   genSrcCd는 지켜진다(2025년 전체 229건 → 태양광 221·소수력 3). 응답이 10~34초로 느리다.
// ★ 업종별(businessType.do) bizType은 원문 공백까지 같아야 맞는다("1차   금속") — 서버에서 공백 무시로 거른다.
// ★ 고객증감(change/custNum)·가구평균(houseAve)·충전소(EVcharge)는 시도코드 필수(빼면 400 또는 404).
// ★ 수록 시점(2026-10-08 기준): 월별 자료는 대부분 2026-07까지, 요금청구방식만 2026-08까지.
// ★ 전자입찰 계약정보(electContract.do): 공고기간 최대 90일, 날짜는 YYYYMMDD("2026-10-01"은 401+errCd 400).
//   7일 323건 1.9MB·11초, 30일 1,460건 9MB·53초 — 그대로 길게 받으면 함수 제한시간(60초)을 넘는다.
//   companyId·name(부분일치)·progressState는 서버에서 지켜진다. 결과 0건도 404.

import { UpstreamError, httpGet, envKey, qs, toNum, trimStr, sleep, Lru } from "./common.js";

const BASE = "https://bigdata.kepco.co.kr/openapi/v1/";
const SOURCE = "한국전력 전력데이터 개방포털";

// region: lgl(법정동 코드) | kepco(한전 코드) | name(이름 전송) | client(보내지 않고 서버에서 거름) | none
export const KEPCO_DATASETS = {
  contract_type: {
    path: "powerUsage/contractType.do", label: "계약종별 전력사용량", period: "month", region: "lgl",
    params: { contract_code: "cntrCd" },
    req: "year·month 필수. 시도·시군구·계약종별 선택(시도 생략 시 전국 합계+전 시군구)",
    sum: ["custCnt", "powerUsage", "bill", "cntrPwr"],
  },
  industry_type: {
    path: "powerUsage/industryType.do", label: "산업분류별 전력사용량", period: "month", region: "lgl",
    params: { biz_code: "bizCd" },
    req: "year·month 필수. 시도·시군구·산업분류코드(A~U) 선택",
    sum: ["custCnt", "powerUsage", "bill"],
  },
  business_type: {
    path: "powerUsage/businessType.do", label: "업종별 전력사용량", period: "month", region: "name",
    req: "year·month 필수. 시도·시군구는 이름으로 전송(코드 무시됨). 업종명(biz_type)은 서버에서 공백 무시 부분일치로 거름",
    sum: ["custCnt", "powerUsage", "cntrPwr"],
  },
  house_avg: {
    path: "powerUsage/houseAve.do", label: "가구평균 전력사용량", period: "month", region: "lgl", metroRequired: true,
    req: "year·month·시도 필수, 시군구 선택",
    sum: [],
  },
  cust_change: {
    path: "change/custNum/industryType.do", label: "산업분류별 전기사용고객 증감(신설·증설·해지)", period: "month", region: "lgl", metroRequired: true,
    params: { biz_code: "bizCd" },
    req: "year·month·시도 필수. 시군구·산업분류코드 선택",
    sum: ["new", "expansion", "cancel"],
  },
  billing_type: {
    path: "billingType.do", label: "요금청구방식(우편·이메일·모바일) 건수", period: "month", region: "lgl",
    req: "year·month 필수. 시도·시군구 선택",
    sum: ["billCnt"],
  },
  welfare: {
    path: "welfareDiscount.do", label: "복지할인 대상 건수", period: "month", region: "lgl",
    params: { welfare_code: "wfTypeCd" },
    req: "year·month 필수. 시도·시군구·복지할인유형코드 선택",
    sum: ["wfCnt"],
  },
  ev_charger: {
    path: "EVcharge.do", label: "전기차 충전소 설치현황", period: "none", region: "kepco", metroRequired: true,
    req: "시도 필수(한전 코드 체계: 서울 11·부산 21·경기 31 — 이름으로 주면 서버가 변환), 시군구 선택",
    sum: ["rapidCnt", "slowCnt"],
  },
  ev_status: {
    path: "EVchargeManage.do", label: "전기차 충전기 운영정보(위치·상태)", period: "none", region: "none",
    req: "addr 필수(서버 정책 — 생략하면 전국 9,753건·2.9MB). 주소 부분일치(예: '빛가람동'). 2026-07 이후 광주·전남 주소는 '전남광주통합특별시'로 표기",
    sum: [],
  },
  renewable: {
    path: "renewEnergy.do", label: "신재생에너지 계약현황(발전원별 개수·용량)", period: "year", region: "client",
    params: { gen_src_code: "genSrcCd" },
    req: "year 필수. 발전원코드 선택. 시도 필터는 원 API에서 작동하지 않아(항상 404) 서버가 전국 자료를 받아 이름으로 거름. 응답 10~34초",
    sum: ["cnt", "capacity"],
  },
  dispersed_gen: {
    path: "dispersedGeneration.do", label: "분산전원 연계정보(변전소·변압기·DL 여유용량)", period: "none", region: "lgl", metroRequired: true,
    params: { subst_code: "substCd", eupmyeondong: "addrLidong" },
    req: "시도 필수(서버 정책 — 생략하면 전국 8,433건·1.7MB·15초). 시군구·읍면동·변전소코드 선택",
    sum: [],
  },
};

const FIELD_KO = {
  year: "연도", month: "월", metro: "시도", city: "시군구", cntr: "계약종별", biz: "산업분류", bizType: "업종",
  custCnt: "고객호수", powerUsage: "전력사용량_kWh", powerUseage: "전력사용량_kWh", bill: "전기요금_원", unitCost: "평균판매단가_원per_kWh", cntrPwr: "계약전력_kW",
  houseCnt: "가구수", new: "신설건수", expansion: "증설건수", cancel: "해지건수", billTy: "청구방식", billCnt: "청구건수",
  wfType: "복지할인유형", wfCnt: "복지할인건수", stnPlace: "충전소명", stnAddr: "주소", rapidCnt: "급속충전기수", slowCnt: "완속충전기수", carType: "지원차종",
  genSrc: "발전원", cnt: "발전기수", capacity: "발전용량", areaCnt: "시도합계_발전기수", areaCapacity: "시도합계_발전용량",
  substCd: "변전소코드", substNm: "변전소명", jsSubstPwr: "변전소용량", substPwr: "변전소누적연계용량", mtrNo: "변압기번호", jsMtrPwr: "변압기용량", mtrPwr: "변압기누적연계용량",
  dlCd: "DL코드", dlNm: "DL명", jsDlPwr: "DL용량", dlPwr: "DL누적연계용량", vol1: "변전소여유용량", vol2: "변압기여유용량", vol3: "DL여유용량",
  addr: "주소", chargeTp: "충전기타입", cpId: "충전기ID", cpNm: "충전기명", cpStat: "충전기상태", cpTp: "충전방식", csId: "충전소ID", csNm: "충전소명", lat: "위도", longi: "경도", statUpdatedatetime: "상태갱신시각",
};
const DATASET_FIELD_KO = {
  house_avg: { powerUsage: "가구평균전력사용량_kWh", powerUseage: "가구평균전력사용량_kWh", bill: "가구평균전기요금_원" },
};
const CP_STAT = { 1: "충전가능", 2: "충전중", 3: "고장/점검", 4: "통신장애", 5: "통신미연결", 6: "충전종료", 7: "계획정지" };
const CHARGE_TP = { 1: "완속", 2: "급속" };

export const KEPCO_CODE_TYPES = {
  lglDngMetroCd: "시도(법정동 체계)", lglDngCityCd: "시군구(법정동 체계)", metroCd: "시도(한전 체계 — 충전소)", cityCd: "시군구(한전 체계 — 충전소)",
  cntrCd: "계약종별", bizCd: "산업분류", genSrcCd: "발전원", wfTypeCd: "복지할인유형",
};

/** {…}{…} 처럼 이어 붙은 JSON 객체를 하나씩 읽는다. 따옴표 없는 오류 본문은 정규식으로 건진다 */
export function parseConcatJson(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const s = text.slice(start, i + 1);
        try {
          out.push(JSON.parse(s));
        } catch {
          const cd = s.match(/"errCd"\s*:\s*"?(\d+)/);
          const msg = s.match(/"errMsg"\s*:\s*(.*?)\s*}\s*$/s);
          out.push({ errCd: cd ? cd[1] : null, errMsg: msg ? msg[1].replace(/^"|"$/g, "").trim() : s.slice(0, 120) });
        }
      }
    }
  }
  return out;
}

function key() {
  const k = envKey("KEPCO_API_KEY");
  if (!k) throw new UpstreamError("서버에 KEPCO_API_KEY 환경변수가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

/**
 * 한전 API 1회(+일시 401 재시도). 반환 { status, total:[], data:[], notFound:boolean }
 * 0건(404 NotFound)은 오류가 아니라 notFound=true로 돌려준다.
 */
export async function kepcoGet(path, params, meter, { timeoutMs = 50000 } = {}) {
  const url = `${BASE}${path}?${qs({ ...params, apiKey: key(), returnType: "json" })}`;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(800 * attempt);
    const { status, text } = await httpGet(url, { meter, source: SOURCE, timeoutMs });
    if (status === 429) throw new UpstreamError("한전 API가 HTTP 429(호출 과다)를 돌려줬습니다. 재시도하지 말고 나중에 조회하세요.", "RATE_LIMIT");
    if (/^\s*<(!DOCTYPE|html)/i.test(text)) throw new UpstreamError(`한전 API 경로 오류(HTTP ${status} HTML '잘못된 접근' 페이지): ${path}`, "UPSTREAM");
    const objs = parseConcatJson(text);
    const errs = objs.filter((o) => o && o.errCd);
    const total = objs.flatMap((o) => (Array.isArray(o.totData) ? o.totData : []));
    const data = objs.flatMap((o) => (Array.isArray(o.data) ? o.data : []));
    if (status === 401 && objs.length === 1 && !Object.keys(objs[0]).length) {
      last = new UpstreamError("한전 API가 HTTP 401에 빈 객체({})를 돌려줬습니다(일시 오류로 보임 — 재시도 후에도 같음).", "UPSTREAM");
      continue;
    }
    if (errs.length && !total.length && !data.length) {
      const e = errs[0];
      const code = String(e.errCd);
      if (code === "404") return { status, total: [], data: [], notFound: true };
      if (/InvalidApiKey/i.test(e.errMsg || "")) throw new UpstreamError("한전 API 인증키 오류(InvalidApiKeyException). 서버의 KEPCO_API_KEY를 확인하세요.", "BAD_KEY");
      if (code === "400") throw new UpstreamError(`한전 API 파라미터 오류: ${e.errMsg}`, "BAD_PARAM");
      if (status >= 500) {
        last = new UpstreamError(`한전 API 서버 오류 HTTP ${status}: ${e.errMsg}`, "UPSTREAM");
        continue;
      }
      throw new UpstreamError(`한전 API 오류 HTTP ${status} errCd ${code}: ${e.errMsg}`, "UPSTREAM");
    }
    if (!objs.length) {
      last = new UpstreamError(`한전 API 응답을 읽지 못했습니다(HTTP ${status}): ${text.slice(0, 120)}`, "UPSTREAM");
      if (status >= 500 || !text.trim()) continue;
      throw last;
    }
    // totData는 있는데 data가 404인 경우(고객증감에서 시도 생략 시 실측) — 합계만 있는 셈
    return { status, total, data, notFound: false, partialError: errs.length ? errs[0] : null };
  }
  throw last;
}

// ── 공통코드·지역 해석 ─────────────────────────────────────────────────────────
const codeCache = new Lru(20);
export async function getCodes(codeTy, meter) {
  const hit = codeCache.get(codeTy);
  if (hit) {
    meter.cacheHits++;
    return hit;
  }
  const r = await kepcoGet("commonCode.do", { codeTy }, meter, { timeoutMs: 20000 });
  const rows = r.data.map((x) => ({ 코드: String(x.code), 이름: trimStr(x.codeNm), ...(x.uppoCd ? { 상위코드: String(x.uppoCd), 상위이름: trimStr(x.uppoCdNm) } : {}) }));
  if (rows.length) codeCache.set(codeTy, rows);
  return rows;
}

const compact = (s) => String(s || "").replace(/\s+/g, "");
const SHORT_METRO = { 충북: "충청북도", 충남: "충청남도", 전남: "전라남도", 경북: "경상북도", 경남: "경상남도", 전북: "전북특별자치도", 전라북도: "전북특별자치도", 강원도: "강원", 제주도: "제주" };
// 2026-07 통합 이후 자료 코드(실측). 이름은 옛 시도로 들어와도 이 코드를 함께 시도한다.
const MERGED = { lgl: { code: "12", from: ["46", "29"] }, kepco: { code: "12", from: ["36", "24"] } };
const GWANGJU_GU = ["동구", "서구", "남구", "북구", "광산구"];

function matchMetro(list, q) {
  const raw = compact(q);
  if (/^\d+$/.test(raw)) return list.filter((x) => x.코드 === raw);
  const want = SHORT_METRO[raw] || raw;
  const exact = list.filter((x) => compact(x.이름) === want);
  if (exact.length) return exact;
  return list.filter((x) => compact(x.이름).startsWith(want));
}

/**
 * 시도·시군구 인자(코드 또는 이름)를 실제로 보낼 후보 목록으로 바꾼다.
 * 반환: [{ metroCd, metroNm, cityCd, cityNm, rowFilter? , note? }] — 앞에서부터 시도해 404가 아니면 멈춘다.
 */
export async function planRegions(system, metroArg, cityArg, ym, meter) {
  if (!metroArg && !cityArg) return [{}];
  const metroTy = system === "kepco" ? "metroCd" : "lglDngMetroCd";
  const cityTy = system === "kepco" ? "cityCd" : "lglDngCityCd";
  const metros = await getCodes(metroTy, meter);
  let metroCands = [];
  if (metroArg) {
    metroCands = matchMetro(metros, metroArg);
    if (!metroCands.length) throw new UpstreamError(`시도 '${metroArg}'를 찾지 못했습니다. 가능한 값: ${metros.map((m) => `${m.코드}=${m.이름}`).join(", ")}`, "BAD_PARAM");
  }
  const merged = MERGED[system === "kepco" ? "kepco" : "lgl"];
  let cities = null;
  const plans = [];
  const pushPlan = async (m, rowFilter, note) => {
    if (!cityArg) return plans.push({ metroCd: m.코드, metroNm: m.이름, rowFilter, note });
    cities = cities || (await getCodes(cityTy, meter));
    const raw = compact(cityArg);
    const inMetro = cities.filter((c) => c.상위코드 === m.코드);
    const hit = /^\d+$/.test(raw) ? inMetro.filter((c) => c.코드 === raw) : inMetro.filter((c) => compact(c.이름) === raw).concat(inMetro.filter((c) => compact(c.이름) !== raw && compact(c.이름).startsWith(raw)));
    if (hit.length) plans.push({ metroCd: m.코드, metroNm: m.이름, cityCd: hit[0].코드, cityNm: hit[0].이름, note });
  };
  if (!metroArg) {
    // 시군구만 준 경우: 전체 시군구 목록에서 찾고 시도는 거기서 정한다
    cities = await getCodes(cityTy, meter);
    const raw = compact(cityArg);
    const hits = cities.filter((c) => (/^\d+$/.test(raw) ? false : compact(c.이름) === raw));
    const groups = new Set(hits.map((h) => (merged.from.includes(h.상위코드) || h.상위코드 === merged.code ? "merged" : h.상위이름.slice(0, 2))));
    if (!hits.length) throw new UpstreamError(`시군구 '${cityArg}'를 찾지 못했습니다(숫자 코드는 시도와 함께 주세요). kepco_get_codes로 ${cityTy} 목록을 확인하세요.`, "BAD_PARAM");
    if (groups.size > 1) throw new UpstreamError(`시군구 '${cityArg}'가 여러 시도에 있습니다: ${hits.map((h) => `${h.상위이름} ${h.이름}`).join(", ")}. metro(시도)를 함께 주세요.`, "BAD_PARAM");
    metroCands = hits.map((h) => metros.find((m) => m.코드 === h.상위코드)).filter(Boolean);
  }
  // 옛 광주·전남 코드 ↔ 통합 코드 보강
  const ordered = [];
  for (const m of metroCands) {
    if (merged.from.includes(m.코드)) {
      const mg = metros.find((x) => x.코드 === merged.code);
      const isGwangju = /광주/.test(m.이름);
      const filt = isGwangju ? (r) => GWANGJU_GU.includes(r.city) : (r) => !GWANGJU_GU.includes(r.city);
      const note = `2026-07 자료부터 ${m.이름}이 '${mg ? mg.이름 : "전남광주통합특별시"}'(${merged.code})로 합쳐져 수록됩니다. 통합 코드로 받아 ${isGwangju ? "광주 5개 구만" : "광주 5개 구를 빼고"} 남겼습니다.`;
      const later = !ym || ym >= "202607";
      const pair = [{ m, rowFilter: null, note: null }, mg ? { m: mg, rowFilter: cityArg ? null : filt, note } : null].filter(Boolean);
      ordered.push(...(later ? pair.reverse() : pair));
    } else ordered.push({ m, rowFilter: null, note: null });
  }
  const seen = new Set();
  for (const o of ordered) {
    const k = o.m.코드;
    if (seen.has(k)) continue;
    seen.add(k);
    await pushPlan(o.m, o.rowFilter, o.note);
  }
  if (!plans.length) throw new UpstreamError(`시군구 '${cityArg}'를 시도 ${metroCands.map((m) => m.이름).join("/")} 안에서 찾지 못했습니다. kepco_get_codes(code_type=${cityTy})로 확인하세요.`, "BAD_PARAM");
  return plans;
}

// ── 정규화 ──────────────────────────────────────────────────────────────────
export function normalizeRow(dataset, r) {
  const over = DATASET_FIELD_KO[dataset] || {};
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    const ko = over[k] || FIELD_KO[k] || k;
    let val = v;
    if (typeof v === "string") {
      const t = v.replace(/\s+/g, " ").trim();
      val = t === "" ? null : t;
    }
    if (dataset === "ev_status") {
      if (k === "cpStat") val = CP_STAT[Number(v)] ? `${CP_STAT[Number(v)]}(${v})` : val;
      if (k === "chargeTp") val = CHARGE_TP[Number(v)] || val;
      if (k === "lat" || k === "longi") val = toNum(v);
    }
    if (dataset === "dispersed_gen" && /^(js|subst|mtr|dl)?Pwr$|Pwr$|^vol\d$/.test(k)) val = toNum(v);
    o[ko] = val;
  }
  return o;
}

export function sumRows(dataset, rows) {
  const f = KEPCO_DATASETS[dataset].sum;
  if (!f.length) return null;
  const out = {};
  for (const k of f) {
    const ko = (DATASET_FIELD_KO[dataset] || {})[k] || FIELD_KO[k];
    out[ko] = rows.reduce((s, r) => s + (toNum(r[k]) || 0), 0);
  }
  return out;
}

// ── 전자입찰 계약정보 ─────────────────────────────────────────────────────────
export const KEPCO_COMPANIES = {
  COM01: "한국전력공사", COM02: "한국서부발전", COM03: "한국전력국제원자력대학원대학교", COM04: "한국남부발전", COM05: "한국중부발전",
  COM06: "한국남동발전", COM08: "한국동서발전", COM09: "한국전력기술", COM10: "한전KPS", COM11: "한국전력거래소", COM12: "한국원자력연료",
  COM14: "한국발전교육원", COM16: "한국해상풍력", COM19: "KAPES",
};
export const KEPCO_PROGRESS = { PreAttendProgress: "공고진행", AttendProgress: "입찰진행", Close: "마감", Fail: "유찰", OpenTimed: "개찰", Final: "공고종료" };
const PURCHASE = { Product: "자재구매", ConstructionService: "공사용역" };
const COMPETITION = { Open: "일반경쟁", Destination: "지명경쟁", Limited: "제한경쟁", Private: "수의" };
const BIDTYPE = { LimitedLowestPrice: "제한적최저가", LowestPrice: "최저가", QualifiedEval: "적격심사", CollectivelyBid: "일괄입찰", Nego: "협상", TotalEvalSuccess: "종합심사낙찰제" };
const ITEMTYPE = { Construction: "공사", Service: "용역" };
const nz = (v) => (v === null || v === undefined || String(v).trim() === "" || String(v).trim() === "-" ? null : String(v).trim());

export function normalizeContract(r, detail = false) {
  const o = {
    공고번호: r.no,
    입찰건명: nz(r.name),
    회사: KEPCO_COMPANIES[r.companyId] || r.companyId,
    구분: PURCHASE[r.purchaseType] || r.purchaseType,
    도급구분: ITEMTYPE[r.itemType] || nz(r.itemType),
    진행상태: KEPCO_PROGRESS[r.progressState] || r.progressState,
    공고일: nz(r.noticeDate),
    입찰신청마감: nz(r.bidAttendReqCloseDatetime),
    투찰시작: nz(r.beginDatetime),
    입찰종료: nz(r.endDatetime),
    추정가격_원: toNum(r.presumedPrice),
    추정금액_원: toNum(r.presumedAmount),
    예비가격기초금액_원: toNum(r.estimatedPriceBasicAmount),
    계약방법: COMPETITION[r.competitionType] || nz(r.competitionType),
    낙찰방법: BIDTYPE[r.bidType] || nz(r.bidType),
    발주기관: nz(r.placeName),
    계약의뢰부서: nz(r.contractReqDepartmentName),
    공동수급가능: r.jointSupplyDemandYn === "1",
    현장설명회: r.fieldIntroYn === "1",
  };
  if (detail) {
    Object.assign(o, {
      입찰참가자격: nz(r.etc),
      참가자격제한: nz(r.bidAttendRestrict),
      입찰참가신청서류: nz(r.bidAttendDocument),
      입찰보증금귀속: nz(r.bidBondBelong),
      입찰무효사항: nz(r.bidNullIfication ?? r.bidNullification),
      낙찰자결정방법설명: nz(r.bidTypeDetail),
      추가정보: nz(r.moreInformation),
      납품장소: nz(r.deliveryLocation),
      납기일: nz(r.deliveryDueDate),
      계약담당자: nz(r.creatorName),
      첨부파일: [1, 2, 3, 4, 5].map((i) => (r[`filenlink${i}`] ? { 이름: r[`filename${i}`], 링크: r[`filenlink${i}`] } : null)).filter(Boolean),
    });
  }
  return o;
}
