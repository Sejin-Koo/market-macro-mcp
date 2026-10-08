// market-macro-mcp / lib/common.js
//
// 모든 원천(수출입은행·KOSIS·한전·공공데이터포털)이 함께 쓰는 호출·날짜·숫자 도구.
//
// - 원천 호출은 반드시 httpGet()을 거친다. 호출 1회(재시도 포함)마다 Meter가 올라가고,
//   각 도구 응답의 요약.원천호출수로 보고된다(일일 한도가 있는 원천이 많아서다).
// - 오류 문구에 URL이 섞여도 인증키가 새지 않도록 scrub()으로 지운다.
//   키 값은 어떤 응답·오류에도 싣지 않는다.

// 공공데이터포털 일부 API는 브라우저가 아닌 User-Agent를 막은 이력이 있어 브라우저 UA를 쓴다.
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const KEY_ENVS = ["EXIM_API_KEY", "KOSIS_API_KEY", "KEPCO_API_KEY", "DATA_PORTAL_KEY"];

export function envKey(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : "";
}

/** 응답·오류 문구에서 인증키 값과 키 파라미터를 지운다 */
export function scrub(s) {
  let t = String(s ?? "");
  for (const n of KEY_ENVS) {
    const v = envKey(n);
    if (v.length >= 6) {
      t = t.split(v).join("***");
      t = t.split(encodeURIComponent(v)).join("***");
    }
  }
  return t.replace(/((?:authkey|apiKey|serviceKey|ServiceKey|crtfc_key)=)[^&\s"']+/gi, "$1***");
}

export class UpstreamError extends Error {
  /**
   * @param {string} message 한국어 안내
   * @param {string} code    NO_KEY | RATE_LIMIT | BAD_KEY | UNAPPROVED | UPSTREAM | TIMEOUT | EMPTY_BODY | BAD_PARAM | NO_DATA
   */
  constructor(message, code = "UPSTREAM", extra = {}) {
    super(scrub(message));
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 한 번의 도구 호출 안에서 원천을 몇 번 불렀는지 원천별로 센다 */
export class Meter {
  constructor() {
    this.calls = 0;
    this.cacheHits = 0;
    this.bySource = {};
  }
  hit(source) {
    this.calls++;
    this.bySource[source] = (this.bySource[source] || 0) + 1;
  }
  summary(extra = {}) {
    return {
      원천호출수: this.calls,
      ...(Object.keys(this.bySource).length > 1 ? { 원천별호출수: this.bySource } : {}),
      ...(this.cacheHits ? { 캐시사용: this.cacheHits } : {}),
      ...extra,
    };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET 한 번. 재시도는 하지 않는다(재시도 정책은 원천마다 달라 호출부가 정한다).
 * 바이트로 받아 UTF-8로 명시 디코딩한다(일부 원천이 charset을 안 준다).
 */
export async function httpGet(url, { meter, source = "?", timeoutMs = 25000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (meter) meter.hit(source);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ac.signal });
    const buf = await r.arrayBuffer();
    return { status: r.status, text: new TextDecoder("utf-8").decode(buf) };
  } catch (e) {
    if (e.name === "AbortError") throw new UpstreamError(`${source} 응답이 ${timeoutMs / 1000}초 안에 오지 않았습니다.`, "TIMEOUT");
    throw new UpstreamError(`${source} 연결 실패: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message || ""})` : ""}`, "UPSTREAM");
  } finally {
    clearTimeout(timer);
  }
}

export function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** 동시 실행 개수를 제한해 비동기 작업을 돈다 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 숫자 ────────────────────────────────────────────────────────────────────
/** "1,234" / " -1.2 " / "" / "-" → number | null. 숫자가 아니면 null */
export function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function stats(values) {
  const a = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return { 건수: 0 };
  const mid = Math.floor(a.length / 2);
  const median = a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  return {
    건수: a.length,
    최소: a[0],
    최대: a[a.length - 1],
    평균: round(a.reduce((s, x) => s + x, 0) / a.length),
    중위: round(median),
  };
}

export const trimStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

// ── 날짜(KST) ───────────────────────────────────────────────────────────────
export function nowKst() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
export function todayKst() {
  return nowKst().toISOString().slice(0, 10).replace(/-/g, "");
}
export function kstHour() {
  const d = nowKst();
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
export function parseYmd(s) {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
}
export function fmtYmd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
export function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtYmd(d);
}
export function weekday(ymd) {
  return parseYmd(ymd).getUTCDay(); // 0=일 … 6=토
}
export const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
export function isWeekend(ymd) {
  const w = weekday(ymd);
  return w === 0 || w === 6;
}
export function dashed(ymd) {
  if (!ymd) return ymd;
  const s = String(ymd);
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  return s;
}
export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

/** YYYYMMDD 정규화. YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD 허용. 존재하지 않는 날짜는 거부 */
export function normalizeDate(input, name = "date") {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const s = String(input).trim().replace(/[-./\s]/g, "");
  if (!/^\d{8}$/.test(s)) throw new UpstreamError(`${name} 형식이 잘못됐습니다: "${input}". YYYYMMDD 또는 YYYY-MM-DD로 주세요.`, "BAD_PARAM");
  if (fmtYmd(parseYmd(s)) !== s) throw new UpstreamError(`${name}가 존재하지 않는 날짜입니다: "${input}".`, "BAD_PARAM");
  return s;
}

/** YYYYMM 정규화. YYYY-MM, YYYY.MM 허용 */
export function normalizeYm(input, name = "ym") {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const s = String(input).trim().replace(/[-./\s]/g, "");
  if (!/^\d{6}$/.test(s)) throw new UpstreamError(`${name} 형식이 잘못됐습니다: "${input}". YYYYMM 또는 YYYY-MM으로 주세요.`, "BAD_PARAM");
  const m = +s.slice(4);
  if (m < 1 || m > 12) throw new UpstreamError(`${name}의 월이 1~12 범위를 벗어났습니다: "${input}".`, "BAD_PARAM");
  return s;
}

export function addMonths(ym, n) {
  let y = +ym.slice(0, 4);
  let m = +ym.slice(4) + n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}${String(m).padStart(2, "0")}`;
}

export function ymRange(from, to) {
  const out = [];
  for (let ym = from; ym <= to; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

/** 간단한 LRU — 과거 자료처럼 바뀌지 않는 응답만 넣는다 */
export class Lru {
  constructor(max = 100) {
    this.max = max;
    this.m = new Map();
  }
  get(k) {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k);
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  set(k, v) {
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  get size() {
    return this.m.size;
  }
}
