// market-macro-mcp / lib/spcde.js
//
// 한국천문연구원 특일정보(SpcdeInfoService) — 공휴일·국경일·기념일·24절기·잡절.
//   https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/<op>
//
// ── 실측으로 확인한 특성 (2026-10-08) ───────────────────────────────────────
// ★★ 명세는 solYear+solMonth가 필수라고 하지만, **solMonth를 빼면 그 해 전체가 온다**
//   (2026 getRestDeInfo → totalCount 22). 단 기본 numOfRows가 10이라 그대로 쓰면 10건에서 잘린다.
//   그래서 numOfRows=200으로 1년을 1회에 받는다(기념일이 가장 많아 2026년 82건).
// ★ solMonth는 두 자리여야 한다. "5"를 보내면 오류 없이 0건("05"는 4건). solYear "26"도 조용히 0건.
// ★ 수록 범위: 2004 ~ 2028년(2003·2029는 0건). 범위 밖도 오류가 아니라 0건이다.
// ★ 1건이면 item이 객체로, 0건이면 items가 ""로 온다.
// ★ getHoliDeInfo(국경일)와 getRestDeInfo(공휴일)가 2026년에는 같은 22건을 줬다. 2025년에는
//   국경일 쪽에만 제헌절(isHoliday=N, remarks "국경일이지만 공휴일 아님")이 더 있었다.
// ★ 노동절(5/1)·제헌절(7/17): 2026-04-28 국무회의에서 「관공서의 공휴일에 관한 규정」 개정안이
//   의결돼 2026년부터 관공서 공휴일이다(대체공휴일 적용, 언론 보도 확인). API의 isHoliday=Y는 맞다.
//   2025년 이전의 '근로자의 날'은 공휴일 목록에 없다(민간 유급휴일이었음). 기념일 목록에는 2026년에도
//   '근로자의 날'(N)이 따로 남아 있다.
// ★ 임시공휴일·선거일은 지정 고시 후 반영까지 하루 정도 늦을 수 있다.

import { UpstreamError, WEEKDAY_KO, weekday, dashed } from "./common.js";
import { dataGoGet, asArray } from "./datago.js";

const BASE = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/";
const SOURCE = "한국천문연구원 특일정보";
export const SPCDE_YEAR_MIN = 2004;
export const SPCDE_YEAR_MAX = 2028;

export const SPCDE_KINDS = {
  rest: { op: "getRestDeInfo", label: "공휴일" },
  national: { op: "getHoliDeInfo", label: "국경일" },
  anniversary: { op: "getAnniversaryInfo", label: "기념일" },
  solar_terms: { op: "get24DivisionsInfo", label: "24절기" },
  sundry: { op: "getSundryDayInfo", label: "잡절" },
};
const DATE_KIND = { "01": "국경일·공휴일", "02": "기념일", "03": "24절기", "04": "잡절" };

/** 한 종류·한 해(또는 한 달)를 1회 호출로 받는다 */
export async function fetchSpcde(kind, year, month, meter) {
  const k = SPCDE_KINDS[kind];
  if (!k) throw new UpstreamError(`알 수 없는 종류: ${kind}`, "BAD_PARAM");
  const params = { _type: "json", solYear: String(year), numOfRows: 200, pageNo: 1 };
  if (month) params.solMonth = String(month).padStart(2, "0");
  const { header, body } = await dataGoGet(BASE + k.op, params, { meter, source: SOURCE, keyParam: "ServiceKey" });
  if (header.resultCode && String(header.resultCode) !== "00")
    throw new UpstreamError(`${SOURCE}: ${header.resultMsg} (resultCode ${header.resultCode})`, "UPSTREAM");
  const items = asArray(body.items);
  const total = Number(body.totalCount ?? items.length);
  return {
    total,
    truncated: total > items.length,
    rows: items.map((it) => {
      const ymd = String(it.locdate);
      return {
        날짜: dashed(ymd),
        요일: WEEKDAY_KO[weekday(ymd)],
        이름: String(it.dateName ?? "").trim(),
        공휴일여부: it.isHoliday === "Y",
        구분: DATE_KIND[String(it.dateKind)] || String(it.dateKind ?? ""),
        ...(it.remarks ? { 비고: String(it.remarks).trim() } : {}),
        _ymd: ymd,
      };
    }),
  };
}
