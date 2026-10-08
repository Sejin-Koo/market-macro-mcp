// market-macro-mcp / lib/datago.js
//
// 공공데이터포털(apis.data.go.kr) 공통 호출기 — 국토교통부 실거래가·한국천문연구원 특일정보·
// 행정안전부 법정동코드가 함께 쓴다. 인증키 환경변수는 DATA_PORTAL_KEY 하나다.
//
// ── 실측으로 확인한 공통 특성 (2026-10-08) ──────────────────────────────────
// ★ 실거래가(RTMS)도 _type=json을 받는다(명세는 XML만 안내). JSON으로 받으면 XML 파서가 필요 없다.
//   단, JSON에서는 일부 값이 숫자로 온다(buildYear 2004 등) — 정규화 단계에서 문자열/숫자를 직접 고른다.
// ★ 미승인 서비스·틀린 키 → HTTP 403 + OpenAPI_ServiceResponse.cmmMsgHeader
//   (SERVICE_KEY_IS_NOT_REGISTERED_ERROR, returnReasonCode 30). 정상 응답 구조와 다르다.
// ★ 결과코드 자릿수가 서비스마다 다르다: 특일정보 "00", 실거래가 "000", 법정동코드 "INFO-0".
// ★ 0건이면 body.items가 빈 문자열("")로 오고, 1건이면 item이 배열이 아니라 객체로 온다 → asArray()로 정규화.
// ★ 간헐적으로 연결이 끊기거나(ECONNRESET) HTTP 200에 빈 본문이 온다(연속 호출 시) — 재시도로 흡수한다.
//   반대로 호출 한도 초과(returnReasonCode 22, HTTP 429)는 재시도해도 소용없어 즉시 멈춘다.
// ★ serviceKey/ServiceKey 대소문자는 특일정보에서 둘 다 통했다(실측). 그래도 명세대로 보낸다.

import { UpstreamError, httpGet, envKey, qs, sleep } from "./common.js";

export const DATA_PORTAL_ENV = "DATA_PORTAL_KEY";

// cmmMsgHeader.returnReasonCode → 한국어 안내(공공데이터포털 공통 오류코드)
const CMM_REASON = {
  "1": "어플리케이션 에러",
  "4": "HTTP 에러",
  "10": "잘못된 요청 파라미터",
  "12": "해당 오픈API 서비스가 없거나 폐기됨",
  "20": "서비스 접근 거부(활용신청 승인 전이거나 미승인)",
  "22": "서비스 요청 제한 횟수 초과(일일 트래픽 소진)",
  "30": "등록되지 않은 서비스키(이 키로 활용신청·승인되지 않은 서비스이거나 키가 틀림)",
  "31": "기한 만료된 서비스키",
  "32": "등록되지 않은 IP",
  "99": "기타 에러",
};

export function asArray(items) {
  if (!items || typeof items !== "object") return [];
  const it = items.item;
  if (it === undefined || it === null || it === "") return [];
  return Array.isArray(it) ? it : [it];
}

/**
 * data.go.kr JSON 호출 1회(+일시 오류 재시도).
 * @returns {{header, body, raw}} — 결과코드 검사는 호출부가 한다(서비스마다 자릿수가 다르다).
 */
export async function dataGoGet(url, params, { meter, source, keyParam = "serviceKey", retries = 2, timeoutMs = 25000 } = {}) {
  const key = envKey(DATA_PORTAL_ENV);
  if (!key) throw new UpstreamError(`서버에 ${DATA_PORTAL_ENV} 환경변수가 설정되어 있지 않습니다.`, "NO_KEY");
  const full = `${url}?${qs({ [keyParam]: key, ...params })}`;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(700 * attempt * attempt);
    let status, text;
    try {
      ({ status, text } = await httpGet(full, { meter, source, timeoutMs }));
    } catch (e) {
      last = e;
      if (e.code === "TIMEOUT" || e.code === "UPSTREAM") continue;
      throw e;
    }
    if (status === 429) throw new UpstreamError(`${source}: HTTP 429(호출 과다). 재시도하지 말고 나중에 조회하세요.`, "RATE_LIMIT");
    if (!text.trim()) {
      last = new UpstreamError(`${source}: HTTP ${status}에 빈 본문(연속 호출에 따른 일시 제한으로 보임).`, "EMPTY_BODY");
      continue;
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      if (status >= 500) {
        last = new UpstreamError(`${source}: 서버 오류 HTTP ${status}`, "UPSTREAM");
        continue;
      }
      // 일부 오류는 JSON을 요청해도 XML로 온다
      const m = text.match(/<returnReasonCode>(\d+)<\/returnReasonCode>/);
      if (m) throw cmmError(source, m[1], (text.match(/<errMsg>([^<]*)<\/errMsg>/) || [])[1]);
      throw new UpstreamError(`${source}: 응답을 JSON으로 읽지 못했습니다(HTTP ${status}): ${text.slice(0, 150)}`, "UPSTREAM");
    }
    const cmm = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (cmm) throw cmmError(source, String(cmm.returnReasonCode ?? ""), cmm.errMsg);
    if (status >= 500) {
      last = new UpstreamError(`${source}: 서버 오류 HTTP ${status}`, "UPSTREAM");
      continue;
    }
    const resp = j.response || j;
    return { header: resp.header || {}, body: resp.body || {}, raw: j, status };
  }
  throw last;
}

function cmmError(source, code, errMsg) {
  const desc = CMM_REASON[code] || "알 수 없는 오류";
  const kind = code === "22" ? "RATE_LIMIT" : code === "30" || code === "20" ? "UNAPPROVED" : code === "31" ? "BAD_KEY" : "UPSTREAM";
  const tail = kind === "RATE_LIMIT" ? " 재시도하지 말고 내일 다시 조회하세요." : kind === "UNAPPROVED" ? " 공공데이터포털에서 이 키로 해당 API 활용신청이 승인됐는지 확인하세요." : "";
  return new UpstreamError(`${source}: ${errMsg || "오류"} (returnReasonCode ${code} — ${desc}).${tail}`, kind);
}
