// KCSC(국가건설기준센터) 건설기준 조회용 원격 MCP 서버 (Cloudflare Workers, Streamable HTTP, stateless)
const BASE = "https://kcsc.re.kr/OpenApi";
const PROTOCOL = "2025-03-26";

const TOOLS = [
  {
    name: "kcsc_search_codes",
    description:
      "건설기준(KDS 설계기준 / KCS 표준시방서) 목록에서 이름·코드로 검색한다. 예: '콘크리트구조', '내진', '14 20 10'. 결과의 codeType과 code를 kcsc_get_code에 넣어 본문을 조회한다.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "검색어(코드명 또는 코드번호 일부). 공백으로 여러 단어는 모두 포함(AND)" },
        codeType: { type: "string", enum: ["KDS", "KCS"], description: "생략하면 둘 다" },
        limit: { type: "integer", description: "최대 결과 수(기본 30, 최대 100)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "kcsc_get_code",
    description:
      "건설기준 하나의 본문(목차별 내용)을 조회한다. 길면 section 으로 목차 제목을 좁히거나 maxChars 로 자른다. 인용 시 반드시 version(개정연도)을 함께 표기할 것.",
    inputSchema: {
      type: "object",
      properties: {
        codeType: { type: "string", enum: ["KDS", "KCS"] },
        code: { type: "string", description: "6자리 코드번호. 예: KDS 14 20 10 → 142010" },
        section: { type: "string", description: "목차 제목에 포함된 단어. 예: '4.2', '철근', '내진'" },
        maxChars: { type: "integer", description: "본문 최대 글자수(기본 12000)" },
      },
      required: ["codeType", "code"],
    },
  },
];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

function stripHtml(html = "") {
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function kcscFetch(path, env) {
  const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(env.KCSC_KEY)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`KCSC 응답 오류 HTTP ${res.status}`);
  try { return JSON.parse(body); } catch { throw new Error("KCSC 응답을 해석할 수 없습니다(인증키 또는 요청값 확인)."); }
}

let listCache = { at: 0, data: null };
async function getList(env) {
  if (listCache.data && Date.now() - listCache.at < 6 * 3600 * 1000) return listCache.data;
  const data = await kcscFetch("CodeList", env);
  if (!Array.isArray(data)) throw new Error("목록 응답 형식이 예상과 다릅니다.");
  listCache = { at: Date.now(), data };
  return data;
}

async function searchCodes(args, env) {
  const kw = String(args.keyword || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!kw.length) return text("keyword 가 비어 있습니다.", true);
  const limit = Math.min(Math.max(parseInt(args.limit) || 30, 1), 100);
  const list = await getList(env);
  const hits = list.filter((c) => {
    if (args.codeType && c.codeType !== args.codeType) return false;
    const spaced = String(c.code || "").replace(/(\d{2})(?=\d)/g, "$1 ").trim();
    const hay = `${c.codeType} ${c.code} ${spaced} ${c.name}`.toLowerCase();
    return kw.every((w) => hay.includes(w));
  });
  if (!hits.length) return text(`'${args.keyword}' 검색 결과가 없습니다.`);
  const lines = hits.slice(0, limit).map((c) => {
    const c6 = String(c.code || "");
    const spaced = c6.length === 6 ? `${c6.slice(0, 2)} ${c6.slice(2, 4)} ${c6.slice(4)}` : c6;
    return `${c.codeType} ${spaced} | ${c.name} | 버전 ${c.version} | 수정 ${String(c.updateDate || "").slice(0, 10)} | code=${c6}`;
  });
  return text(`총 ${hits.length}건 중 ${lines.length}건\n` + lines.join("\n"));
}

async function getCode(args, env) {
  const type = String(args.codeType || "").toUpperCase();
  const code = String(args.code || "").replace(/\D/g, "");
  if (!["KDS", "KCS"].includes(type) || code.length !== 6)
    return text("codeType 은 KDS/KCS, code 는 6자리 숫자여야 합니다. 예: KDS 14 20 10 → 142010", true);
  const data = await kcscFetch(`CodeViewer/${type}/${code}`, env);
  const doc = Array.isArray(data) ? data[0] : data;
  if (!doc || (doc.message && !doc.list)) return text(`조회 실패: ${doc?.message || "결과 없음"}`, true);
  const max = Math.min(Math.max(parseInt(args.maxChars) || 12000, 500), 60000);
  const sec = args.section ? String(args.section).toLowerCase() : null;
  const items = (doc.list || []).filter((it) => !sec || String(it.title || "").toLowerCase().includes(sec) || String(it.label || "").toLowerCase().includes(sec));
  let body = items.map((it) => `${"#".repeat(Math.min(Math.max(it.level || 1, 1), 5))} ${it.title}\n${stripHtml(it.contents)}`).join("\n\n");
  let cut = "";
  if (body.length > max) { body = body.slice(0, max); cut = `\n\n[… ${max}자에서 잘림. section 또는 maxChars 로 범위를 조정하세요]`; }
  if (!items.length) body = sec ? `목차 제목에 '${args.section}' 가 포함된 항목이 없습니다.` : "본문 항목이 없습니다.";
  const head = `${doc.codeType} ${code} ${doc.name}\n버전 ${doc.version} / 수정일 ${String(doc.updateDate || "").slice(0, 10)}\n출처: 국가건설기준센터(kcsc.re.kr)\n\n`;
  return text(head + body + cut);
}

async function handleRpc(msg, env) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize":
      return rpcOk(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "kcsc-mcp", version: "0.1.0" } });
    case "ping": return rpcOk(id, {});
    case "tools/list": return rpcOk(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const { name, arguments: a = {} } = params || {};
        if (name === "kcsc_search_codes") return rpcOk(id, await searchCodes(a, env));
        if (name === "kcsc_get_code") return rpcOk(id, await getCode(a, env));
        return rpcErr(id, -32602, `알 수 없는 도구: ${name}`);
      } catch (e) {
        return rpcOk(id, text(`오류: ${e.message}`, true));
      }
    }
    default: return rpcErr(id, -32601, `지원하지 않는 메서드: ${method}`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // 접속 주소 자체를 비밀로 사용: /mcp/<PATH_TOKEN>
    if (!env.PATH_TOKEN || !env.KCSC_KEY || url.pathname !== `/mcp/${env.PATH_TOKEN}`)
      return new Response("Not found", { status: 404 });
    if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body;
    try { body = await req.json(); } catch { return json(rpcErr(null, -32700, "JSON 파싱 오류"), 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, env)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const out = await handleRpc(body, env);
    return out ? json(out) : new Response(null, { status: 202 });
  },
};
