import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/server.js";

export const config = {
  api: { bodyParser: true },
};

// ─── 접근 게이트 ─────────────────────────────────────────────────────────────
// 엔드포인트 주소만 알면 누구나 호출할 수 있는 상태를 막기 위해, 호출자는 URL
// 쿼리스트링으로 발급받은 게이트키를 전달한다:  https://<도메인>/api/mcp?k=<발급키>
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//                   그 밖(기본 "observe")이면 통과시키되 로그만 남긴다.
// 로그에는 키 전문 대신 발급 대상 식별자(plk_<대상>_… 의 <대상>)만 남긴다.
// 상세 운영 절차는 sys-mcp-gatekey 스킬 참조.
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function gateKeyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

/** 통과하면 true. 차단하면 401 응답을 보내고 false를 돌려준다. */
function gateCheck(req, res) {
  let k = (req.query && req.query.k) || null;
  if (!k) {
    try {
      k = new URL(req.url, "http://localhost").searchParams.get("k");
    } catch (e) {
      k = null;
    }
  }
  const allowed = GATE_KEYS.length === 0 || (!!k && GATE_KEYS.includes(k));
  console.log(
    `[gate] mode=${GATE_MODE} method=${req.method} caller=${gateKeyLabel(k)} allowed=${allowed}`
  );
  if (!allowed && GATE_MODE === "enforce") {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message:
            "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/api/mcp?k=<발급키>)로만 호출할 수 있습니다.",
        },
      })
    );
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!gateCheck(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "POST만 지원합니다" }, id: null });
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
