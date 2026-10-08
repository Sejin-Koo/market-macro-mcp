// market-macro-mcp — 시장·거시 데이터 MCP 서버
//
// 그동안 셸에서 인증키를 들고 직접 부르던 거시·시장 API를 한 서버로 묶는다.
//   한국수출입은행(환율·대출금리·국제금리) · KOSIS 국가통계 · 한국전력 전력데이터 ·
//   국토교통부 부동산 실거래가 · 한국천문연구원 특일정보(공휴일·절기)
// 저장소는 두지 않는다(매번 실시간 조회). 과거 날짜 응답·코드표만 인스턴스 메모리에 잠시 캐시한다.
// 원천별 실측 함정은 lib/<원천>.js 머리 주석에 있다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Meter, UpstreamError, scrub, envKey, KEY_ENVS, normalizeDate, normalizeYm, todayKst, dashed, addDays, isWeekend, weekday, WEEKDAY_KO, daysBetween, toNum, mapLimit, addMonths } from "./common.js";
import { getRates, getFxSeries, planSamples, EXIM_DAILY_LIMIT } from "./exim.js";
import { searchTables, getMeta, getData, PRD_CODES, KOSIS_CELL_LIMIT } from "./kosis.js";
import { KEPCO_DATASETS, KEPCO_CODE_TYPES, KEPCO_COMPANIES, KEPCO_PROGRESS, kepcoGet, getCodes, planRegions, normalizeRow, sumRows, normalizeContract } from "./kepco.js";
import { RTMS_DATASETS, RTMS_UNAPPROVED, fetchDeals, dealStats, resolveLawd, monthsBetween, currentYm } from "./rtms.js";
import { SPCDE_KINDS, SPCDE_YEAR_MIN, SPCDE_YEAR_MAX, fetchSpcde } from "./spcde.js";

export const SERVER_VERSION = "1.0.0";

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
const MAX_TEXT = 400000; // 응답 텍스트 상한(문자). 넘으면 행을 줄이고 잘렸다고 알린다

const ok = (obj) => {
  let text = JSON.stringify(obj, null, 1);
  if (text.length > 100000) text = JSON.stringify(obj);
  return { content: [{ type: "text", text: scrub(text) }] };
};
const fail = (e, meter) => ({
  content: [
    {
      type: "text",
      text: scrub(`오류: ${e && e.message ? e.message : String(e)}`) + (e && e.code ? ` [${e.code}]` : "") + (meter ? `\n(이번 호출 원천 API 호출 수: ${meter.calls})` : ""),
    },
  ],
  isError: true,
});

/** MCP 클라이언트가 인자를 문자열로 직렬화해 보내는 경우가 있어 number/boolean/배열은 관대하게 받는다 */
const num = (min, max, def) => {
  let s = z.coerce.number().int();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return def === undefined ? s.optional() : s.default(def);
};
const bool = (def = false) =>
  z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(def);
const strList = () =>
  z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .transform((v) => {
      let a;
      if (Array.isArray(v)) a = v;
      else {
        const s = String(v).trim();
        if (s.startsWith("[")) {
          try {
            const j = JSON.parse(s);
            if (Array.isArray(j)) a = j.map(String);
          } catch {
            /* 아래로 */
          }
        }
        if (!a) a = s.split(/[,\n]+/);
      }
      return a.map((x) => String(x).trim()).filter(Boolean);
    })
    .optional();
const str = () => z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional();

const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const contains = (hay, needle) => norm(hay).includes(norm(needle));

/** 행 목록을 offset/limit로 자르고, 텍스트 상한을 넘으면 더 줄인다 */
function page(rows, offset, limit) {
  const total = rows.length;
  let slice = rows.slice(offset, offset + limit);
  let reason = null;
  const len = JSON.stringify(slice).length;
  if (len > MAX_TEXT && slice.length) {
    const per = len / slice.length;
    const keep = Math.max(1, Math.floor(MAX_TEXT / per));
    slice = slice.slice(0, keep);
    reason = `응답 크기 상한(${MAX_TEXT.toLocaleString()}자) 때문에 ${keep}건만 담았습니다`;
  }
  const truncated = offset + slice.length < total;
  return {
    info: {
      전체건수: total,
      반환건수: slice.length,
      offset,
      잘림: truncated,
      ...(truncated ? { 잘림사유: reason || `limit=${limit}에서 멈췄습니다`, 다음호출: `offset=${offset + slice.length}로 이어 받거나 필터를 좁히세요. 집계만 필요하면 summary_only=true.` } : {}),
    },
    rows: slice,
  };
}

const prdArg = () =>
  z
    .string()
    .transform((v) => {
      const t = String(v).trim();
      return PRD_CODES[t] || t.toUpperCase();
    })
    .describe("수록주기: Y(년)·H(반기)·Q(분기)·M(월)·D(일)·IR(부정기) — 한글(년/분기/월)도 됨");

// ── 서버 ─────────────────────────────────────────────────────────────────────
export function buildServer() {
  const server = new McpServer({ name: "market-macro-mcp", version: SERVER_VERSION });

  const eximDateDesc =
    "기준일 YYYYMMDD 또는 YYYY-MM-DD. 생략하면 오늘. 주말·공휴일·고시 전(영업일 11시 전후 갱신)·미래면 자료가 있는 날까지 최대 10일 거슬러 조회하고, 응답의 사용기준일에 실제로 쓴 날을 적는다";
  const exactDesc = "true면 거슬러 조회하지 않고 그날 자료만(없으면 오류)";

  // ── 1. 수출입은행 환율 ─────────────────────────────────────────────────────
  server.registerTool(
    "exim_get_fx",
    {
      title: "환율 조회 (한국수출입은행)",
      description:
        "한국수출입은행 고시 환율(매매기준율·전신환 받을때/보낼때·장부가격, 23개 통화)을 특정일 기준으로 돌려준다. " +
        "단위는 원(KRW)이고 JPY·IDR은 100단위당 원이다(표시단위 필드). 주말·공휴일은 직전 영업일 자료로 보정하며 사용기준일을 표시한다. " +
        "2005-01-03 자료부터 조회된다. 기간 추이는 exim_get_fx_series, 금리는 exim_get_interest.",
      inputSchema: {
        date: z.string().optional().describe(eximDateDesc),
        exact: bool(false).describe(exactDesc),
        currencies: strList().describe("통화코드 목록(예: USD,JPY,EUR,CNH). 생략하면 전체. JPY(100)처럼 줘도 된다"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const date = normalizeDate(a.date, "date");
        const r = await getRates({ date, types: ["AP01"], currencies: a.currencies, exact: a.exact }, meter);
        const { notes, ...rest } = r;
        return ok({ ...rest, ...(notes.length ? { 안내: notes } : {}), 요약: meter.summary({ 기관: "한국수출입은행", 기준일: rest.사용기준일, 일일한도: `${EXIM_DAILY_LIMIT}회(키 공유)` }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 2. 수출입은행 금리 ─────────────────────────────────────────────────────
  server.registerTool(
    "exim_get_interest",
    {
      title: "대출금리·국제금리 조회 (한국수출입은행)",
      description:
        "kinds=loan: 수은채 유통수익률 기반 대출 고정기준금리(기간별 %, 41개 기간). kinds=intl: 국제금리 — SOFR·ESTR·TONA(일별 RFR), EURIBOR·TIBOR, SWAP(RFR)·SWAP, CIRR(통화별 3~10년). " +
        "대출금리는 휴일에도 직전 값을 그대로 주므로 영업일 판정은 환율(AP01)로 하고(그래서 1회 더 호출), 국제금리는 한국 비영업일에 SOFR·ESTR·TONA만 차는 부분 자료라 완전한 영업일로 거슬러 간다. " +
        "CIRR 기간 라벨은 원문에 없어 명세 변경이력(2023-07-15) 순서로 붙인다.",
      inputSchema: {
        date: z.string().optional().describe(eximDateDesc),
        exact: bool(false).describe(exactDesc),
        kinds: z
          .union([z.array(z.enum(["loan", "intl"])), z.enum(["loan", "intl", "all"])])
          .default("all")
          .describe("loan(대출금리)·intl(국제금리)·all"),
        rate_types: strList().describe("국제금리 구분 필터(예: SOFR, EURIBOR, SWAP, CIRR). 부분일치"),
        currencies: strList().describe("국제금리 통화 필터(예: USD, EUR, JPY)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const date = normalizeDate(a.date, "date");
        const kinds = Array.isArray(a.kinds) ? a.kinds : a.kinds === "all" ? ["loan", "intl"] : [a.kinds];
        const types = [...(kinds.includes("loan") ? ["AP02"] : []), ...(kinds.includes("intl") ? ["AP03"] : [])];
        const r = await getRates({ date, types, exact: a.exact }, meter);
        const { notes, ...rest } = r;
        if (rest.국제금리?.행 && (a.rate_types?.length || a.currencies?.length)) {
          const before = rest.국제금리.행.length;
          rest.국제금리.행 = rest.국제금리.행.filter(
            (x) => (!a.rate_types?.length || a.rate_types.some((t) => contains(x.구분, t))) && (!a.currencies?.length || a.currencies.some((c) => norm(x.통화) === norm(c)))
          );
          rest.국제금리.필터 = `${before}건 중 ${rest.국제금리.행.length}건`;
        }
        return ok({ ...rest, ...(notes.length ? { 안내: notes } : {}), 요약: meter.summary({ 기관: "한국수출입은행", 기준일: rest.사용기준일 }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 3. 환율 시계열 ─────────────────────────────────────────────────────────
  server.registerTool(
    "exim_get_fx_series",
    {
      title: "환율 기간 추이 (한국수출입은행)",
      description:
        "통화별 매매기준율 시계열. 원 API는 하루 단위 조회만 되므로 날짜마다 1회씩 부른다(일일 1,000회 한도 공유). " +
        "interval=day는 모든 평일(공휴일은 빠짐), week는 주 마지막 영업일, month는 월 마지막 영업일(휴일이면 최대 4일 거슬러 감). " +
        "계획 표본 수가 max_calls를 넘으면 호출하지 않고 안내만 돌려준다. 응답에 관측수·시작·끝·최고·최저·평균·변화율과 값 목록을 담는다.",
      inputSchema: {
        currencies: strList().describe("통화코드 목록(필수, 예: USD,JPY,EUR)"),
        from: z.string().describe("시작일 YYYYMMDD/YYYY-MM-DD(필수)"),
        to: z.string().optional().describe("종료일. 생략하면 오늘"),
        interval: z.enum(["day", "week", "month"]).default("week").describe("표본 간격"),
        max_calls: num(1, 250, 60).describe("원천 호출 상한(기본 60, 최대 250)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        if (!a.currencies?.length) throw new UpstreamError("currencies가 필요합니다(예: USD,JPY).", "BAD_PARAM");
        const from = normalizeDate(a.from, "from");
        let to = normalizeDate(a.to, "to") || todayKst();
        if (to > todayKst()) to = todayKst();
        if (from > to) throw new UpstreamError(`from(${dashed(from)})이 to(${dashed(to)})보다 뒤입니다.`, "BAD_PARAM");
        const plan = planSamples(from, to, a.interval).length;
        if (plan > a.max_calls) {
          const alt = ["day", "week", "month"].map((iv) => `${iv}=${planSamples(from, to, iv).length}개`).join(", ");
          return ok({
            실행안함: true,
            사유: `계획 표본 ${plan}개가 max_calls=${a.max_calls}를 넘습니다(표본당 최소 1회 호출).`,
            간격별표본수: alt,
            권고: "interval을 넓히거나(week/month) 기간을 나누거나 max_calls를 올리세요(최대 250, 일일 한도 1,000회 공유).",
            요약: meter.summary({ 기관: "한국수출입은행" }),
          });
        }
        const r = await getFxSeries({ currencies: a.currencies, from, to, interval: a.interval, maxCalls: a.max_calls }, meter);
        const { notes, ...rest } = r;
        return ok({ 기간: `${dashed(from)} ~ ${dashed(to)}`, 간격: a.interval, 단위: "원(KRW), JPY·IDR은 100단위당", ...rest, ...(notes.length ? { 안내: notes } : {}), 요약: meter.summary({ 기관: "한국수출입은행" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 4. KOSIS 통계표 검색 ───────────────────────────────────────────────────
  server.registerTool(
    "kosis_search_tables",
    {
      title: "KOSIS 통계표 검색",
      description:
        "KOSIS(국가통계포털) 통계표를 키워드로 검색해 기관ID(orgId)·통계표ID(tblId)·표 이름·수록기간·분류경로를 돌려준다. " +
        "찾은 표는 kosis_get_table_meta로 항목·분류 코드를 확인한 뒤 kosis_get_data로 수치를 받는다. page는 행 오프셋이 아니라 페이지 번호다.",
      inputSchema: {
        keyword: z.string().describe("검색어(예: 소비자물가지수, 자동차등록)"),
        limit: num(1, 100, 20).describe("페이지당 건수"),
        page: num(1, 1000, 1).describe("페이지 번호"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r = await searchTables({ keyword: a.keyword, limit: a.limit, page: a.page }, meter);
        const more = r.전체건수 && a.page * a.limit < r.전체건수;
        return ok({
          검색어: a.keyword,
          전체건수: r.전체건수,
          반환건수: r.행.length,
          ...(more ? { 다음호출: `page=${a.page + 1}` } : {}),
          ...(r.행.length === 0 ? { 안내: "0건입니다. 띄어쓰기를 바꾸거나 더 짧은 검색어로 다시 찾아보세요." } : {}),
          통계표: r.행,
          요약: meter.summary({ 기관: "통계청 KOSIS" }),
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5. KOSIS 메타 ──────────────────────────────────────────────────────────
  server.registerTool(
    "kosis_get_table_meta",
    {
      title: "KOSIS 통계표 메타(항목·분류 코드·수록기간)",
      description:
        "통계표의 항목(itmId) 코드, 분류 레벨별(objL1~objL8) 코드, 필요한 objL 개수, 주기별 수록기간을 돌려준다. " +
        "objL 레벨 수는 표마다 달라 틀리면 KOSIS가 err 20(부족)/21(초과)만 준다 — 이 도구의 필요objL수를 그대로 쓰면 된다. " +
        "셀 상한 40,000은 항목 수 × 레벨별 코드 수 × 시점 수의 선언된 교차곱으로 계산되므로 코드수도 함께 보여준다. 메타 조회는 2~3회 호출.",
      inputSchema: {
        org_id: str().describe("기관ID(예: 101)"),
        tbl_id: str().describe("통계표ID(예: DT_1J22003)"),
        code_query: z.string().optional().describe("코드 이름 부분일치 필터(예: 서울). 레벨별 코드 목록에만 적용"),
        max_codes: num(1, 2000, 60).describe("레벨별로 보여줄 코드 수 상한(기본 60). 코드수 필드는 항상 전체 개수"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        if (!a.org_id || !a.tbl_id) throw new UpstreamError("org_id와 tbl_id가 필요합니다(kosis_search_tables로 찾으세요).", "BAD_PARAM");
        const m = await getMeta(a.org_id, a.tbl_id, meter);
        const cut = (codes) => {
          const f = a.code_query ? codes.filter((c) => contains(c.이름, a.code_query)) : codes;
          return { 표시: f.slice(0, a.max_codes), ...(f.length > a.max_codes ? { 생략: f.length - a.max_codes } : {}), ...(a.code_query ? { 필터일치: f.length } : {}) };
        };
        const items = cut(m.항목);
        return ok({
          기관ID: m.기관ID,
          통계표ID: m.통계표ID,
          통계표명: m.통계표명,
          필요objL수: m.필요objL수,
          항목: { 코드수: m.항목.length, 코드: items.표시, ...(items.생략 ? { 생략: items.생략 } : {}) },
          분류: m.분류.map((l) => {
            const c = cut(l.코드);
            return { 파라미터: l.파라미터, 분류ID: l.분류ID, 분류명: l.분류명, 코드수: l.코드수, 코드: c.표시, ...(c.생략 ? { 생략: c.생략 } : {}), ...(a.code_query ? { 필터일치: c.필터일치 } : {}) };
          }),
          수록주기: m.수록주기,
          시점당전체셀수: m.항목.length * m.분류.reduce((x, l) => x * l.코드수, 1),
          안내: `kosis_get_data에 objL1~objL${m.필요objL수}를 모두 주세요(ALL 가능). 셀 상한 ${KOSIS_CELL_LIMIT.toLocaleString()} — 시점당전체셀수 × 시점 수가 넘으면 코드를 지정하세요.`,
          요약: meter.summary({ 기관: "통계청 KOSIS" }),
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 6. KOSIS 자료 ──────────────────────────────────────────────────────────
  const objL = () => str().describe("분류 코드(여러 개는 공백/쉼표, 전체는 ALL)");
  server.registerTool(
    "kosis_get_data",
    {
      title: "KOSIS 통계 수치 조회",
      description:
        "통계표의 수치를 항목·분류·기간으로 받는다. 기본으로 먼저 메타를 읽어(precheck) objL 개수, 코드 존재, 주기 지원, 40,000셀 상한(선언된 교차곱 기준)을 검사하고, " +
        "어긋나면 KOSIS를 부르지 않고 이유와 고칠 방법을 돌려준다(실행안함=true). 기간은 start(+end) 또는 recent(최근 N개 시점). " +
        "시점 형식: 년 2024, 반기 202401, 분기 202403, 월 202409, 일 20240930. KOSIS err 30(데이터 없음)은 0건으로 돌려준다.",
      inputSchema: {
        org_id: str().describe("기관ID"),
        tbl_id: str().describe("통계표ID"),
        prd_se: prdArg(),
        start: str().describe("시작 시점(예: 202401)"),
        end: str().describe("종료 시점. 생략하면 start와 같음"),
        recent: num(1, 1000).describe("최근 N개 시점(start 대신)"),
        items: strList().describe("항목 코드 목록(itmId). 생략하면 ALL"),
        objL1: objL(), objL2: objL(), objL3: objL(), objL4: objL(), objL5: objL(), objL6: objL(), objL7: objL(), objL8: objL(),
        precheck: bool(true).describe("메타로 사전 검사(기본 true, 호출 2~3회 추가 — 같은 인스턴스에선 캐시)"),
        limit: num(1, 20000, 1000).describe("반환 행 상한"),
        offset: num(0, undefined, 0),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        if (!a.org_id || !a.tbl_id) throw new UpstreamError("org_id와 tbl_id가 필요합니다.", "BAD_PARAM");
        const levels = [];
        let last = 0;
        for (let i = 1; i <= 8; i++) if (a[`objL${i}`]) last = i;
        for (let i = 1; i <= last; i++) {
          if (!a[`objL${i}`]) throw new UpstreamError(`objL${last}를 주려면 objL${i}도 필요합니다(레벨은 1부터 빠짐없이).`, "BAD_PARAM");
          levels.push(a[`objL${i}`]);
        }
        const r = await getData({ orgId: a.org_id, tblId: a.tbl_id, prdSe: a.prd_se, start: a.start, end: a.end, recent: a.recent, levels, items: a.items, precheck: a.precheck }, meter);
        if (r.실행안함) return ok({ ...r, 요약: meter.summary({ 기관: "통계청 KOSIS" }) });
        const p = page(r.행, a.offset, a.limit);
        const periods = [...new Set(r.행.map((x) => x.시점))].sort();
        return ok({
          통계표명: r.통계표명,
          최종수정일: r.최종수정일,
          시점범위: periods.length ? `${periods[0]} ~ ${periods[periods.length - 1]} (${periods.length}개)` : null,
          ...p.info,
          ...(r.행.length === 0 ? { 안내0건: "정상 응답 0건입니다. 기간이 수록 범위 밖이거나 코드 조합에 자료가 없을 수 있습니다(시점 형식도 확인)." } : {}),
          셀계산: r.셀계산,
          ...(r.notes?.length ? { 안내: r.notes } : {}),
          행: p.rows,
          요약: meter.summary({ 기관: "통계청 KOSIS", 기준: `${a.org_id}/${a.tbl_id}` }),
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 7. 한전 데이터 ─────────────────────────────────────────────────────────
  const dsDesc = Object.entries(KEPCO_DATASETS)
    .map(([k, d]) => `${k}=${d.label} [${d.req}]`)
    .join(" / ");
  server.registerTool(
    "kepco_get_data",
    {
      title: "한국전력 전력데이터 조회",
      description:
        "한국전력 전력데이터 개방포털 Open API. dataset별 필수 인자: " +
        dsDesc +
        ". metro·city는 코드나 이름(서울·서울특별시·강남구)을 모두 받고, 서버가 데이터셋에 맞는 코드 체계(법정동/한전)로 바꾼다. " +
        "2026-07 자료부터 광주·전남은 '전남광주통합특별시'(12)로 합쳐져 수록되므로 서버가 옛·새 코드를 차례로 시도한다. 월별 자료는 2026-10 기준 2026-07(요금청구방식은 2026-08)까지 있다. " +
        "원 API는 페이지가 없어 한 번에 전부 주며, 서버가 limit/offset으로 잘라 돌려주고 합계를 낸다. 0건(원 API 404)은 오류가 아니라 0건으로 알린다.",
      inputSchema: {
        dataset: z.enum(Object.keys(KEPCO_DATASETS)).describe("데이터셋"),
        year: num(2000, 2100).describe("조회연도(월별·연별 데이터셋 필수)"),
        month: num(1, 12).describe("조회월 1~12(월별 데이터셋 필수, 서버가 두 자리로 맞춤)"),
        metro: str().describe("시도 코드 또는 이름"),
        city: str().describe("시군구 코드 또는 이름(코드는 시도와 함께)"),
        contract_code: str().describe("contract_type: 계약종별 코드(100 주택용·200 일반용·250 교육용·300 산업용·500 농사용·600 가로등·900 심야)"),
        biz_code: str().describe("industry_type·cust_change: 산업분류 코드(A~U, 예: C 제조업)"),
        welfare_code: str().describe("welfare: 복지할인유형 코드(01 장애우·02 유공자·03 기초수급자·04 차상위·06 사회복지시설·07 생명유지장치·08 대가족·09 다자녀)"),
        gen_src_code: str().describe("renewable: 발전원 코드(1 태양광·2 소수력·3 풍력·4 바이오·5 폐기물·6 매립지가스·7 연료전지·8 해양)"),
        biz_type: z.string().optional().describe("business_type: 업종명 부분일치(공백 무시, 서버 필터)"),
        addr: z.string().optional().describe("ev_status: 충전소 주소 부분일치(필수)"),
        eupmyeondong: z.string().optional().describe("dispersed_gen: 읍면동(예: 남평읍)"),
        subst_code: str().describe("dispersed_gen: 변전소 코드"),
        keyword: z.string().optional().describe("반환 행 전체 문자열 필드에 대한 부분일치 필터(서버 측)"),
        summary_only: bool(false).describe("행 없이 건수·합계만"),
        limit: num(1, 5000, 100),
        offset: num(0, undefined, 0),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const ds = KEPCO_DATASETS[a.dataset];
        const notes = [];
        const params = {};
        let ym = null;
        if (ds.period === "month" || ds.period === "year") {
          if (!a.year) throw new UpstreamError(`${a.dataset}는 year가 필요합니다. [${ds.req}]`, "BAD_PARAM");
          params.year = String(a.year);
          if (ds.period === "month") {
            if (!a.month) throw new UpstreamError(`${a.dataset}는 month가 필요합니다. [${ds.req}]`, "BAD_PARAM");
            params.month = String(a.month).padStart(2, "0");
            ym = params.year + params.month;
          } else ym = params.year + "12";
        }
        if (ds.metroRequired && !a.metro && !a.city) throw new UpstreamError(`${a.dataset}는 시도(metro)가 필요합니다. [${ds.req}]`, "BAD_PARAM");
        if (a.dataset === "ev_status") {
          if (!a.addr) throw new UpstreamError("ev_status는 addr(주소 부분일치)가 필요합니다 — 생략하면 전국 9,753건(2.9MB)이 옵니다.", "BAD_PARAM");
          params.addr = a.addr.trim();
        }
        for (const [arg, p] of Object.entries(ds.params || {})) if (a[arg]) params[p] = String(a[arg]).trim();

        // 지역 → 후보 계획
        let plans = [{}];
        let clientRegion = null;
        if (ds.region === "lgl" || ds.region === "kepco" || ds.region === "name") {
          plans = await planRegions(ds.region === "kepco" ? "kepco" : "lgl", a.metro, a.city, ym, meter);
        } else if (ds.region === "client" && (a.metro || a.city)) {
          const pl = await planRegions("lgl", a.metro, a.city, ym, meter);
          clientRegion = { metros: new Set(pl.map((p) => p.metroNm).filter(Boolean)), city: a.city ? pl[0].cityNm || a.city : null };
          notes.push("이 데이터셋은 원 API의 시도 필터가 작동하지 않아(항상 404, 실측) 전국 자료를 받아 서버에서 지역 이름으로 걸렀습니다.");
        } else if (ds.region === "none" && (a.metro || a.city)) notes.push(`${a.dataset}는 시도·시군구 인자를 쓰지 않습니다(무시함).`);

        let res = null;
        let used = null;
        const tried = [];
        for (const pl of plans) {
          const p = { ...params };
          if (ds.region === "name") {
            if (pl.metroNm) p.metro = pl.metroNm;
            if (pl.cityNm) p.city = pl.cityNm;
          } else if (ds.region === "lgl" || ds.region === "kepco") {
            if (pl.metroCd) p.metroCd = pl.metroCd;
            if (pl.cityCd) p.cityCd = pl.cityCd;
          }
          const r = await kepcoGet(ds.path, p, meter, { timeoutMs: a.dataset === "renewable" ? 55000 : 45000 });
          tried.push(`${pl.metroNm ? `${pl.metroNm}(${pl.metroCd})` : "전국"}${pl.cityNm ? ` ${pl.cityNm}(${pl.cityCd})` : ""}: ${r.notFound ? "0건(404)" : `${r.data.length + r.total.length}행`}`);
          if (!r.notFound) {
            res = r;
            used = pl;
            break;
          }
        }
        if (plans.length > 1) notes.push(`지역 코드 후보를 차례로 시도했습니다 — ${tried.join(" / ")}`);
        if (used?.note) notes.push(used.note);

        const 요약 = () =>
          meter.summary({ 기관: "한국전력공사(전력데이터 개방포털)", 데이터셋: `${a.dataset} (${ds.label})`, ...(ym && ds.period === "month" ? { 기준월: dashed(ym) } : ds.period === "year" ? { 기준연도: params.year } : { 기준: "조회 시점 현황" }) });
        if (!res) {
          return ok({
            데이터셋: ds.label,
            전체건수: 0,
            행: [],
            안내0건:
              "원 API가 404 NotFound(자료 없음)를 줬습니다 — 정상 0건과 구분되지 않습니다. " +
              (ds.period === "month" ? "월별 자료는 보통 2~3개월 전까지만 있습니다(2026-10-08 실측: 대부분 2026-07, 요금청구방식 2026-08). " : "") +
              "코드·이름 철자, 연월, 필터 코드도 확인하세요.",
            ...(notes.length ? { 안내: notes } : {}),
            요약: 요약(),
          });
        }
        let rows = res.data;
        const masked = rows.some((r) => r.city === "XXX");
        if (used?.rowFilter) {
          if (masked) notes.push("통합 코드 자료의 시군구가 'XXX'(원문 마스킹, 시도 합계)로만 와서 광주·전남을 나눌 수 없습니다 — 아래 값은 광주+전남 합계입니다(2026-07 산업분류별에서 실측, 이때 시군구코드를 주면 404).");
          else rows = rows.filter(used.rowFilter);
        } else if (masked) notes.push("시군구가 'XXX'로 온 행은 원문 마스킹으로, 시도 합계로 보입니다.");
        if (clientRegion) {
          rows = rows.filter((r) => (!clientRegion.metros.size || [...clientRegion.metros].some((m) => norm(r.metro) === norm(m))) && (!clientRegion.city || norm(r.city) === norm(clientRegion.city)));
        }
        if (a.biz_type && a.dataset === "business_type") rows = rows.filter((r) => contains(r.bizType, a.biz_type));
        if (a.keyword) rows = rows.filter((r) => Object.values(r).some((v) => typeof v === "string" && contains(v, a.keyword)));
        const sums = sumRows(a.dataset, rows);
        const out = {
          데이터셋: ds.label,
          조회조건: { ...params, ...(used?.metroNm ? { 시도: `${used.metroNm}(${used.metroCd})` } : {}), ...(used?.cityNm ? { 시군구: `${used.cityNm}(${used.cityCd})` } : {}) },
          원본행수: res.data.length,
          필터후건수: rows.length,
          ...(sums ? { 합계_필터후: sums } : {}),
          ...(res.total.length ? { 전국합계: res.total.map((r) => normalizeRow(a.dataset, r)) } : {}),
        };
        if (res.partialError) notes.push(`원 API가 합계(totData)만 주고 상세는 ${res.partialError.errCd} ${res.partialError.errMsg}로 응답했습니다 — 시도를 지정하세요.`);
        if (a.dataset === "renewable") notes.push("발전용량 단위는 명세상 kWh로 표기돼 있으나 설비용량(kW)으로 보입니다. 시도합계 필드는 원문 그대로입니다.");
        if (!a.summary_only) {
          const p = page(rows.map((r) => normalizeRow(a.dataset, r)), a.offset, a.limit);
          Object.assign(out, p.info, { 행: p.rows });
        }
        if (notes.length) out.안내 = notes;
        out.요약 = 요약();
        return ok(out);
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 8. 한전 공통코드 ───────────────────────────────────────────────────────
  server.registerTool(
    "kepco_get_codes",
    {
      title: "한국전력 공통코드(지역·계약종별·산업분류 등)",
      description:
        "kepco_get_data에 쓰는 코드표. 지역은 두 체계가 있다 — lglDngMetroCd/lglDngCityCd(법정동 체계: 충전소 외 대부분)와 metroCd/cityCd(한전 체계: 전기차 충전소 설치현황). " +
        "공통코드에는 옛 코드(광주 29·전남 46·전북 45)와 새 코드(전남광주통합특별시 12·전북특별자치도 52)가 함께 있고, 실제 자료가 있는 코드는 시점마다 다르다(kepco_get_data 설명 참고).",
      inputSchema: {
        code_type: z.enum(Object.keys(KEPCO_CODE_TYPES)).describe(Object.entries(KEPCO_CODE_TYPES).map(([k, v]) => `${k}=${v}`).join(", ")),
        query: z.string().optional().describe("코드명 부분일치 필터"),
        parent: str().describe("시군구 코드표에서 상위 시도 코드로 거르기(예: 11)"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let rows = await getCodes(a.code_type, meter);
        const all = rows.length;
        if (a.parent) rows = rows.filter((r) => r.상위코드 === a.parent);
        if (a.query) rows = rows.filter((r) => contains(r.이름, a.query) || contains(r.상위이름, a.query));
        return ok({ 코드유형: `${a.code_type} (${KEPCO_CODE_TYPES[a.code_type]})`, 전체건수: all, 반환건수: rows.length, 코드: rows, 요약: meter.summary({ 기관: "한국전력공사(전력데이터 개방포털)" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 9. 한전 전자입찰 계약정보 ──────────────────────────────────────────────
  server.registerTool(
    "kepco_search_contracts",
    {
      title: "한전·발전자회사 전자입찰 공고 검색 (SRM)",
      description:
        "한전 SRM 전자입찰 계약정보(한전·발전 5사·한전KPS·한전기술·전력거래소 등). 공고일 기간(최대 90일, 원 API 제한)과 회사·건명·공고번호·진행상태로 검색한다. " +
        "필터 없이 길게 받으면 응답이 매우 커서(30일 1,460건·9MB·53초 실측) 함수 제한시간을 넘으므로, 서버는 회사(한전 COM01 제외)·건명·공고번호 필터가 없으면 기간을 14일로 제한한다. " +
        "회사·건명·진행상태 필터는 원 API에서 지켜진다(건명은 부분일치). 결과 0건도 원 API는 404로 주며 서버는 0건으로 알린다. " +
        "기본 응답은 요약 필드만, include_detail=true면 참가자격·첨부파일 링크까지.",
      inputSchema: {
        from: z.string().describe("공고 시작일 YYYYMMDD/YYYY-MM-DD(필수)"),
        to: z.string().optional().describe("공고 종료일(생략하면 오늘). from~to 최대 90일"),
        company: str().describe(`회사 코드 또는 이름: ${Object.entries(KEPCO_COMPANIES).map(([k, v]) => `${k}=${v}`).join(", ")}`),
        name: z.string().optional().describe("입찰건명 부분일치(원 API 필터)"),
        notice_no: z.string().optional().describe("공고번호"),
        progress_state: z.enum(Object.keys(KEPCO_PROGRESS)).optional().describe(Object.entries(KEPCO_PROGRESS).map(([k, v]) => `${k}=${v}`).join(", ")),
        min_price: z.coerce.number().optional().describe("추정가격 하한(원, 서버 필터)"),
        include_detail: bool(false).describe("참가자격·서류·첨부파일 등 긴 필드 포함"),
        summary_only: bool(false),
        limit: num(1, 1000, 50),
        offset: num(0, undefined, 0),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const from = normalizeDate(a.from, "from");
        const to = normalizeDate(a.to, "to") || todayKst();
        if (from > to) throw new UpstreamError(`from(${dashed(from)})이 to(${dashed(to)})보다 뒤입니다.`, "BAD_PARAM");
        const span = daysBetween(from, to) + 1;
        if (span > 90) throw new UpstreamError(`기간이 ${span}일입니다. 원 API는 최대 90일까지만 받습니다(넘기면 'The date range too long'). 나눠서 조회하세요.`, "BAD_PARAM");
        let company = null;
        if (a.company) {
          const c = a.company.toUpperCase();
          company = KEPCO_COMPANIES[c] ? c : Object.keys(KEPCO_COMPANIES).find((k) => contains(KEPCO_COMPANIES[k], a.company));
          if (!company) throw new UpstreamError(`회사 '${a.company}'를 모릅니다. 가능한 값: ${Object.entries(KEPCO_COMPANIES).map(([k, v]) => `${k}=${v}`).join(", ")}`, "BAD_PARAM");
        }
        const narrow = (company && company !== "COM01") || a.name || a.notice_no;
        if (!narrow && span > 14)
          return ok({
            실행안함: true,
            사유: `필터 없이(또는 한전 본사만으로) ${span}일을 받으면 응답이 수 MB·수십 초라 제한시간(60초)을 넘습니다(실측 7일 323건 1.9MB·11초, 30일 1,460건 9MB·53초).`,
            권고: "기간을 14일 이하로 나누거나, 건명(name)·발전자회사(company)·공고번호로 좁히세요.",
            요약: meter.summary({ 기관: "한국전력공사 SRM" }),
          });
        const params = { noticeBeginDate: from, noticeEndDate: to, companyId: company, name: a.name, no: a.notice_no, progressState: a.progress_state };
        const r = await kepcoGet("electContract.do", params, meter, { timeoutMs: 55000 });
        let rows = r.data;
        const raw = rows.length;
        if (a.min_price) rows = rows.filter((x) => (toNum(x.presumedPrice) || 0) >= a.min_price);
        rows.sort((x, y) => String(y.noticeDate).localeCompare(String(x.noticeDate)) || String(y.no).localeCompare(String(x.no)));
        const byCo = {};
        const bySt = {};
        for (const x of rows) {
          const co = KEPCO_COMPANIES[x.companyId] || x.companyId;
          byCo[co] = (byCo[co] || 0) + 1;
          const st = KEPCO_PROGRESS[x.progressState] || x.progressState;
          bySt[st] = (bySt[st] || 0) + 1;
        }
        const out = {
          조회조건: { 공고기간: `${dashed(from)} ~ ${dashed(to)} (${span}일)`, 회사: company ? `${company} ${KEPCO_COMPANIES[company]}` : "전체", 건명: a.name || null, 진행상태: a.progress_state || null },
          원본건수: raw,
          필터후건수: rows.length,
          회사별: byCo,
          진행상태별: bySt,
          ...(r.notFound ? { 안내0건: "원 API가 404(자료 없음)를 줬습니다 — 조건에 맞는 공고가 0건입니다. 날짜 형식은 YYYYMMDD." } : {}),
        };
        if (!a.summary_only) {
          const p = page(rows.map((x) => normalizeContract(x, a.include_detail)), a.offset, a.limit);
          Object.assign(out, p.info, { 공고: p.rows });
        }
        out.요약 = meter.summary({ 기관: "한국전력공사 SRM(전자입찰)", 기준: `공고일 ${dashed(from)}~${dashed(to)}` });
        return ok(out);
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 10. 부동산 실거래가 ────────────────────────────────────────────────────
  server.registerTool(
    "rtms_get_deals",
    {
      title: "부동산 실거래가 조회 (국토교통부)",
      description:
        "국토교통부 실거래가 — dataset: apt_trade(아파트 매매 상세, 2006-01~), apt_rent(아파트 전월세, 2011-01~), nrg_trade(상업업무용 매매, 2006-01~), land_trade(토지 매매, 2006-01~). " +
        "지역은 lawd_cd(시군구 5자리) 또는 region(시군구 이름: '강남구'·'서울 중구'·'성남시 분당구'). 구가 있는 시(화성시·수원시 등)는 시 코드로는 0건이라 하위 구 전부로 펼친다. " +
        "from_ym~to_ym 월 범위를 (시군구×월)마다 1000행 페이지로 totalCount까지 받고, 호출 상한(max_calls)·시간(45초)에 걸리면 미수신 월을 알린다. " +
        "count_only=true면 월별 신고건수(해제 포함)만 월당 1회로 받는다. 통계는 기본으로 해제(취소) 거래를 뺀다. 금액 단위 만원. " +
        "잘못된 LAWD_CD·월 형식도 원 API는 오류 없이 0건을 주므로 0건이면 형식을 의심할 것. 최근 1~2개월은 신고기한(30일) 때문에 계속 늘어난다. " +
        "오피스텔·연립다세대·단독다가구·분양권·공장창고는 이 키로 미승인이라 제공하지 않는다.",
      inputSchema: {
        dataset: z.enum(Object.keys(RTMS_DATASETS)).describe("데이터셋"),
        lawd_cd: strList().describe("시군구코드 5자리 목록(예: 11680). region과 둘 중 하나"),
        region: z.string().optional().describe("시군구 이름(예: 강남구, 서울 중구, 성남시 분당구, 화성시)"),
        from_ym: z.string().describe("시작 계약년월 YYYYMM 또는 YYYY-MM(필수)"),
        to_ym: z.string().optional().describe("종료 계약년월(생략하면 from_ym 한 달)"),
        count_only: bool(false).describe("건수만(월당 1회 호출, numOfRows=0)"),
        dong: z.string().optional().describe("법정동 이름 부분일치(서버 필터, 예: 대치동)"),
        name: z.string().optional().describe("단지명 부분일치(아파트, 서버 필터)"),
        min_area: z.coerce.number().optional().describe("면적 하한 ㎡(전용/건물/거래면적)"),
        max_area: z.coerce.number().optional().describe("면적 상한 ㎡"),
        include_cancelled: bool(false).describe("통계와 행에 해제(취소) 거래 포함"),
        sort: z.enum(["date_desc", "date_asc", "price_desc", "price_asc"]).default("date_desc"),
        summary_only: bool(false).describe("행 없이 통계만"),
        max_calls: num(1, 150, 40).describe("원천 호출 상한(기본 40)"),
        limit: num(1, 2000, 50),
        offset: num(0, undefined, 0),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const ds = RTMS_DATASETS[a.dataset];
        const notes = [];
        const fromYm = normalizeYm(a.from_ym, "from_ym");
        if (!fromYm) throw new UpstreamError("from_ym이 필요합니다(YYYYMM).", "BAD_PARAM");
        const toYm = normalizeYm(a.to_ym, "to_ym") || fromYm;
        if (fromYm > toYm) throw new UpstreamError(`from_ym(${fromYm})이 to_ym(${toYm})보다 뒤입니다.`, "BAD_PARAM");
        let months = monthsBetween(fromYm, toYm);
        const nowYm = currentYm();
        if (months.some((m) => m < ds.since)) {
          notes.push(`${ds.label}는 ${dashed(ds.since)}부터 수록돼 그 전 월은 뺐습니다.`);
          months = months.filter((m) => m >= ds.since);
        }
        if (months.some((m) => m > nowYm)) {
          notes.push("미래 월은 뺐습니다.");
          months = months.filter((m) => m <= nowYm);
        }
        if (!months.length) throw new UpstreamError("조회할 월이 없습니다(수록 시작 전 또는 미래).", "BAD_PARAM");
        let lawd = [];
        let regionInfo = null;
        if (a.lawd_cd?.length) {
          lawd = a.lawd_cd.map((x) => x.replace(/\D/g, ""));
          const bad = lawd.filter((x) => x.length !== 5);
          if (bad.length) throw new UpstreamError(`lawd_cd는 5자리 시군구코드입니다(법정동코드 10자리면 앞 5자리): ${bad.join(", ")}. 원 API는 틀린 코드에도 오류 없이 0건을 줍니다.`, "BAD_PARAM");
        } else if (a.region) {
          const r = await resolveLawd(a.region, meter);
          if (r.해석 === "모호" || r.해석 === "없음")
            return ok({
              실행안함: true,
              사유: r.해석 === "모호" ? `'${a.region}'에 해당하는 시군구가 여러 개입니다. 시도를 붙이거나(예: 서울 중구) lawd_cd로 주세요.` : `'${a.region}'를 시군구로 해석하지 못했습니다.`,
              후보: r.후보,
              요약: meter.summary({ 기관: "행정안전부 법정동코드" }),
            });
          lawd = r.지역.map((x) => x.코드);
          regionInfo = r.지역;
          if (r.안내) notes.push(r.안내);
        } else throw new UpstreamError("lawd_cd 또는 region이 필요합니다.", "BAD_PARAM");
        const minCalls = lawd.length * months.length;
        if (minCalls > a.max_calls)
          return ok({
            실행안함: true,
            사유: `시군구 ${lawd.length}개 × ${months.length}개월 = 최소 ${minCalls}회 호출이 필요해 max_calls=${a.max_calls}를 넘습니다.`,
            권고: "기간을 나누거나, 건수 추이만 필요하면 count_only=true(같은 호출 수지만 응답이 작음), 또는 max_calls를 올리세요(최대 150, 공공데이터포털 일일 트래픽 공유).",
            요약: meter.summary({ 기관: "국토교통부" }),
          });
        if (months.includes(nowYm) || months.includes(addMonths(nowYm, -1))) notes.push("최근 1~2개월은 신고기한(계약 후 30일) 때문에 아직 다 들어오지 않았습니다.");

        const r = await fetchDeals({ dataset: a.dataset, lawdCodes: lawd, months, countOnly: a.count_only, maxCalls: a.max_calls }, meter);
        const total = r.results.reduce((s, x) => s + (x.전체건수 || 0), 0);
        const received = r.results.reduce((s, x) => s + x.수신건수, 0);
        const notDone = r.results.filter((x) => !["완료", "건수만"].includes(x.상태));
        const zero = r.results.filter((x) => x.전체건수 === 0);
        const base = {
          데이터셋: ds.label,
          지역: regionInfo ? regionInfo.map((x) => `${x.이름}(${x.코드})`) : lawd,
          기간: `${dashed(months[0])} ~ ${dashed(months[months.length - 1])}`,
          전체건수_원천: total,
        };
        if (zero.length === r.results.length) notes.push("모든 (시군구×월)이 0건입니다. 원 API는 틀린 LAWD_CD·월 형식에도 오류 없이 0건을 주므로 코드를 확인하세요(구가 있는 시는 구 코드).");
        if (notDone.length)
          notes.push(`${notDone.length}개 (시군구×월)을 다 받지 못했습니다(${r.budgetStop ? "호출 상한" : r.timeStop ? "시간 상한" : "오류"}): ${notDone.slice(0, 8).map((x) => `${x.시군구코드}/${x.월} ${x.상태}${x.오류 ? `(${x.오류})` : ""}`).join(", ")}${notDone.length > 8 ? " …" : ""}. 기간을 나눠 다시 조회하세요.`);
        if (a.count_only) {
          return ok({ ...base, 월별: r.results.map((x) => ({ 시군구코드: x.시군구코드, 월: x.월, 건수: x.전체건수, 상태: x.상태 })), ...(notes.length ? { 안내: notes } : {}), 단위: "신고 건수(해제 거래 포함)", 요약: meter.summary({ 기관: "국토교통부 실거래가", 호출당행수: 0 }) });
        }
        let rows = r.rows;
        if (a.dong) rows = rows.filter((x) => contains(x.법정동, a.dong));
        if (a.name) rows = rows.filter((x) => contains(x.단지명, a.name));
        if (a.min_area !== undefined) rows = rows.filter((x) => (x[ds.areaField] ?? -1) >= a.min_area);
        if (a.max_area !== undefined) rows = rows.filter((x) => (x[ds.areaField] ?? Infinity) <= a.max_area);
        const st = dealStats(a.dataset, rows, { includeCancelled: a.include_cancelled });
        const priceKey = ds.kind === "rent" ? "보증금_만원" : "거래금액_만원";
        const sorter = {
          date_desc: (x, y) => String(y.계약일).localeCompare(String(x.계약일)),
          date_asc: (x, y) => String(x.계약일).localeCompare(String(y.계약일)),
          price_desc: (x, y) => (y[priceKey] ?? -1) - (x[priceKey] ?? -1),
          price_asc: (x, y) => (x[priceKey] ?? Infinity) - (y[priceKey] ?? Infinity),
        }[a.sort];
        const listRows = (a.include_cancelled ? rows : rows.filter((x) => !x.해제)).sort(sorter);
        const out = {
          ...base,
          수신건수: received,
          미수신건수: total - received,
          ...(a.dong || a.name || a.min_area !== undefined || a.max_area !== undefined ? { 필터후건수: rows.length } : {}),
          통계: st,
          시군구월별수신: r.results.length <= 24 ? r.results : { 작업수: r.results.length, 미완료: notDone.slice(0, 20) },
        };
        if (!a.summary_only) {
          const p = page(listRows, a.offset, a.limit);
          Object.assign(out, p.info, { 거래: p.rows });
        }
        if (notes.length) out.안내 = notes;
        out.단위 = "금액 만원, 면적 ㎡";
        out.요약 = meter.summary({ 기관: "국토교통부 실거래가", 페이지크기: 1000, 소요초: Math.round(r.elapsedMs / 100) / 10 });
        return ok(out);
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 11. 시군구 코드 찾기 ───────────────────────────────────────────────────
  server.registerTool(
    "rtms_find_region",
    {
      title: "시군구 이름 → 실거래가 지역코드(LAWD_CD)",
      description:
        "행정안전부 법정동코드로 시군구 이름을 5자리 LAWD_CD로 바꾼다. 구가 있는 시는 하위 구 코드로 펼치고(시 코드로는 실거래가가 0건), 같은 이름이 여러 시도에 있으면 후보를 돌려준다.",
      inputSchema: { region: z.string().describe("시군구 이름(예: 강남구, 서울 중구, 성남시 분당구, 화성시)") },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const r = await resolveLawd(a.region, meter);
        return ok({ 질의: a.region, ...r, 요약: meter.summary({ 기관: "행정안전부 법정동코드(공공데이터포털)" }) });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 12. 특일정보 ───────────────────────────────────────────────────────────
  server.registerTool(
    "holiday_get_days",
    {
      title: "공휴일·국경일·기념일·24절기 (한국천문연구원 특일정보)",
      description:
        "kinds: rest(공휴일 — 대체·임시공휴일·선거일 포함), national(국경일), anniversary(기념일), solar_terms(24절기), sundry(잡절: 정월대보름·한식·단오·초복 등). " +
        "year(+month) 또는 from~to(최대 3개 연도)로 조회한다. 원 API는 solMonth를 빼면 1년치를 주므로 종류·연도마다 1회 호출이다. 수록 범위 2004~2028년. " +
        "노동절(5/1)·제헌절(7/17)은 2026년부터 관공서 공휴일이다(2026-04-28 「관공서의 공휴일에 관한 규정」 개정, 대체공휴일 적용) — API의 공휴일여부=Y가 맞다. 2025년 이전 근로자의 날은 공휴일 목록에 없다. " +
        "임시공휴일은 지정 후 반영이 하루쯤 늦을 수 있다. check_date를 주면 그날이 영업일인지와 다음 영업일을 알려준다(주말+공휴일 기준).",
      inputSchema: {
        year: num(1900, 2100).describe("연도"),
        month: num(1, 12).describe("월(선택)"),
        from: z.string().optional().describe("시작일 YYYYMMDD(year 대신)"),
        to: z.string().optional().describe("종료일 YYYYMMDD"),
        kinds: z
          .union([z.array(z.enum(Object.keys(SPCDE_KINDS))), z.enum(Object.keys(SPCDE_KINDS)), z.string()])
          .default(["rest"])
          .describe("조회 종류(여러 개 가능): rest, national, anniversary, solar_terms, sundry"),
        check_date: z.string().optional().describe("영업일 여부를 확인할 날짜 YYYYMMDD"),
      },
    },
    async (a) => {
      const meter = new Meter();
      try {
        let kinds = Array.isArray(a.kinds) ? a.kinds : String(a.kinds).split(/[\s,]+/).filter(Boolean);
        const badKinds = kinds.filter((k) => !SPCDE_KINDS[k]);
        if (badKinds.length) throw new UpstreamError(`알 수 없는 kinds: ${badKinds.join(", ")}. 가능한 값: ${Object.keys(SPCDE_KINDS).join(", ")}`, "BAD_PARAM");
        const check = normalizeDate(a.check_date, "check_date");
        let from = normalizeDate(a.from, "from");
        let to = normalizeDate(a.to, "to");
        let years;
        let month = null;
        if (from || to) {
          from = from || to;
          to = to || from;
          if (from > to) throw new UpstreamError("from이 to보다 뒤입니다.", "BAD_PARAM");
          years = [];
          for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) years.push(y);
          if (years.length > 3) throw new UpstreamError("from~to는 최대 3개 연도까지입니다.", "BAD_PARAM");
        } else if (a.year) {
          years = [a.year];
          month = a.month || null;
        } else if (check) {
          years = [+check.slice(0, 4)];
          from = check;
          to = addDays(check, 14);
          if (to.slice(0, 4) !== from.slice(0, 4)) years.push(+to.slice(0, 4));
        } else throw new UpstreamError("year(+month) 또는 from~to 또는 check_date가 필요합니다.", "BAD_PARAM");
        if (check && !kinds.includes("rest")) kinds = [...kinds, "rest"];
        const notes = [];
        const outOfRange = years.filter((y) => y < SPCDE_YEAR_MIN || y > SPCDE_YEAR_MAX);
        if (outOfRange.length) notes.push(`${outOfRange.join(", ")}년은 수록 범위(${SPCDE_YEAR_MIN}~${SPCDE_YEAR_MAX}) 밖이라 원 API가 0건을 줍니다(오류 아님).`);
        const jobs = [];
        for (const k of kinds) for (const y of years) jobs.push({ k, y });
        const got = await mapLimit(jobs, 4, async (j) => ({ ...j, r: await fetchSpcde(j.k, j.y, month, meter) }));
        const result = {};
        let restDays = [];
        for (const k of kinds) {
          let rows = got.filter((g) => g.k === k).flatMap((g) => g.r.rows);
          const trunc = got.filter((g) => g.k === k && g.r.truncated);
          if (trunc.length) notes.push(`${SPCDE_KINDS[k].label}: 원 API 전체건수보다 적게 받았습니다(numOfRows 200 초과).`);
          if (k === "rest") restDays = rows;
          if (from) rows = rows.filter((r) => r._ymd >= from && r._ymd <= to);
          rows.sort((x, y) => x._ymd.localeCompare(y._ymd));
          result[SPCDE_KINDS[k].label] = { 건수: rows.length, 목록: rows.map(({ _ymd, ...rest }) => rest) };
        }
        const out = { 기간: from ? `${dashed(from)} ~ ${dashed(to)}` : month ? `${years[0]}-${String(month).padStart(2, "0")}` : `${years[0]}년`, ...result };
        if (result["공휴일"]) {
          const wk = result["공휴일"].목록.filter((d) => d.공휴일여부 && (d.요일 === "토" || d.요일 === "일"));
          if (wk.length) notes.push(`주말과 겹친 공휴일 ${wk.length}일(${wk.map((d) => `${d.날짜} ${d.이름}`).join(", ")}) — 대체공휴일은 별도 항목으로 들어 있습니다.`);
        }
        if (check) {
          const hol = new Set(restDays.filter((d) => d.공휴일여부).map((d) => d._ymd));
          const isBiz = (d) => !isWeekend(d) && !hol.has(d);
          let next = addDays(check, 1);
          for (let i = 0; i < 14 && !isBiz(next); i++) next = addDays(next, 1);
          const why = isWeekend(check) ? `주말(${WEEKDAY_KO[weekday(check)]})` : hol.has(check) ? `공휴일(${restDays.filter((d) => d._ymd === check).map((d) => d.이름).join(", ")})` : null;
          out.영업일확인 = { 날짜: dashed(check), 요일: WEEKDAY_KO[weekday(check)], 영업일: !why, ...(why ? { 사유: why } : {}), 다음영업일: dashed(next) };
        }
        if (notes.length) out.안내 = notes;
        out.요약 = meter.summary({ 기관: "한국천문연구원(공공데이터포털 특일정보)", 기준연도: years.join(",") });
        return ok(out);
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 13. 상태 ───────────────────────────────────────────────────────────────
  server.registerTool(
    "macro_api_status",
    {
      title: "서버 상태·원천별 키 설정·실호출 점검",
      description:
        "환경변수별 인증키 설정 여부(값은 반환하지 않음), 원천·도구 대응표, 미승인 실거래가 데이터셋 목록을 돌려준다. " +
        "live_check=true면 원천마다 가벼운 호출 1~2회로 키·승인 상태를 실제로 확인한다(수출입은행 1, KOSIS 1, 한전 1, 공공데이터포털 2).",
      inputSchema: { live_check: bool(false).describe("true면 원천별 실호출 점검") },
    },
    async (a) => {
      const meter = new Meter();
      try {
        const keys = Object.fromEntries(KEY_ENVS.map((k) => [k, !!envKey(k)]));
        const out = {
          서버: { 이름: "market-macro-mcp", 버전: SERVER_VERSION, 오늘_KST: dashed(todayKst()) },
          인증키설정: keys,
          게이트: { MCP_GATE_KEYS_설정됨: !!(process.env.MCP_GATE_KEYS || "").trim(), MCP_GATE_MODE: (process.env.MCP_GATE_MODE || "observe").trim() },
          원천: [
            { 원천: "한국수출입은행 환율·금리", 키: "EXIM_API_KEY", 도구: "exim_get_fx · exim_get_interest · exim_get_fx_series", 한도: "일 1,000회" },
            { 원천: "KOSIS 국가통계", 키: "KOSIS_API_KEY", 도구: "kosis_search_tables · kosis_get_table_meta · kosis_get_data", 한도: "호출당 40,000셀" },
            { 원천: "한국전력 전력데이터", 키: "KEPCO_API_KEY", 도구: "kepco_get_data · kepco_get_codes · kepco_search_contracts" },
            { 원천: "국토교통부 실거래가·행안부 법정동코드", 키: "DATA_PORTAL_KEY", 도구: "rtms_get_deals · rtms_find_region" },
            { 원천: "한국천문연구원 특일정보", 키: "DATA_PORTAL_KEY", 도구: "holiday_get_days" },
          ],
          실거래가_승인: Object.values(RTMS_DATASETS).map((d) => d.label),
          실거래가_미승인: RTMS_UNAPPROVED,
        };
        if (a.live_check) {
          const checks = [
            ["수출입은행", () => getRates({ types: ["AP01"], currencies: ["USD"] }, meter).then((r) => `USD ${r.환율.행[0]?.매매기준율} (${r.사용기준일})`)],
            ["KOSIS", () => searchTables({ keyword: "소비자물가지수", limit: 1 }, meter).then((r) => `검색 ${r.전체건수}건`)],
            ["한국전력", () => getCodes("cntrCd", meter).then((r) => `계약종별 코드 ${r.length}개`)],
            ["특일정보", () => fetchSpcde("rest", +todayKst().slice(0, 4), null, meter).then((r) => `올해 공휴일 ${r.total}건`)],
            ["실거래가", async () => {
              const r = await fetchDeals({ dataset: "apt_trade", lawdCodes: ["11680"], months: [currentYm()], countOnly: true, maxCalls: 1000 }, meter);
              const x = r.results[0];
              if (x.상태 === "오류") throw new Error(x.오류);
              return `강남구 이번 달 아파트 매매 ${x.전체건수}건`;
            }],
          ];
          out.점검 = await mapLimit(checks, 5, async ([name, fn]) => {
            try {
              return { 원천: name, 상태: "정상", 결과: await fn() };
            } catch (e) {
              return { 원천: name, 상태: e.code || "오류", 메시지: scrub(e.message) };
            }
          });
          out.점검요약 = { 정상: out.점검.filter((x) => x.상태 === "정상").length, 전체: checks.length };
        }
        out.요약 = meter.summary();
        return ok(out);
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  return server;
}
