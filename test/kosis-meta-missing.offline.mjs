// 키 없이 도는 재현 시험: KOSIS 응답을 가짜 fetch로 흉내 낸다.
//   node test/kosis-meta-missing.offline.mjs
// 2026-11-25 실패 인자 {org_id:"301", tbl_id:"DT_722Y001"} — 항목 메타 err 30은 '표 없음' 안내로 바뀌어야 한다.
import assert from "node:assert/strict";
process.env.KOSIS_API_KEY = process.env.KOSIS_API_KEY || "offline-test-key";

const ITM_OK = [
  { OBJ_ID: "ITEM", OBJ_ID_SN: "0", ITM_ID: "T10", ITM_NM: "총지수", UNIT_NM: "2020=100" },
  { OBJ_ID: "A", OBJ_ID_SN: "1", OBJ_NM: "지역별", ITM_ID: "00", ITM_NM: "전국" },
];
const PRD_OK = [{ PRD_SE: "월", STRT_PRD_DE: "198501", END_PRD_DE: "202610" }];
const TBL_OK = [{ TBL_NM: "소비자물가지수" }];
const ERR30 = { err: "30", errMsg: "데이터가 존재하지 않습니다." };

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const tbl = u.searchParams.get("tblId");
  const type = u.searchParams.get("type");
  let body;
  if (tbl === "DT_722Y001") body = ERR30;
  else if (type === "ITM") body = ITM_OK;
  else if (type === "PRD") body = PRD_OK;
  else if (type === "TBL") body = TBL_OK;
  else body = ERR30;
  const buf = new TextEncoder().encode(JSON.stringify(body));
  return { status: 200, arrayBuffer: async () => buf };
};

const { getMeta, getData } = await import("../lib/kosis.js");

// 1) 없는 표 — 표 없음 안내
await assert.rejects(getMeta("301", "DT_722Y001", null), (e) => {
  assert.equal(e.code, "KOSIS_NO_TABLE");
  assert.equal(e.kosisCode, "30");
  assert.match(e.message, /통계표가 KOSIS에 없습니다/);
  assert.match(e.message, /kosis_search_tables/);
  assert.doesNotMatch(e.message, /기간이 수록 범위 밖/);
  return true;
});

// 2) kosis_get_data도 사전 메타 단계에서 같은 안내
await assert.rejects(getData({ orgId: "301", tblId: "DT_722Y001", prdSe: "M", start: "202601", levels: [["ALL"]] }, null), (e) => e.code === "KOSIS_NO_TABLE");

// 3) 있는 표는 그대로
const m = await getMeta("101", "DT_1J22003", null);
assert.equal(m.통계표명, "소비자물가지수");
assert.equal(m.필요objL수, 1);
assert.equal(m.항목[0].코드, "T10");
assert.equal(m.수록주기[0].prdSe, "M");

// 4) 기간 PRD·TBL의 err 30은 지금처럼 넘어간다(항목은 있는 표)
globalThis.fetch = async (url) => {
  const type = new URL(url).searchParams.get("type");
  const body = type === "ITM" ? ITM_OK : ERR30;
  const buf = new TextEncoder().encode(JSON.stringify(body));
  return { status: 200, arrayBuffer: async () => buf };
};
const m2 = await getMeta("101", "DT_OTHER", null);
assert.equal(m2.통계표명, null);
assert.deepEqual(m2.수록주기, []);

console.log("ok kosis-meta-missing.offline (4 cases)");
