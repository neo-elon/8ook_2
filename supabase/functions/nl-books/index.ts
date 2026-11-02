// National Library of Korea holdings search proxy. NL_API_KEY is a Supabase secret.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const endpoint = "https://www.nl.go.kr/NL/search/openApi/search.do";
const value = (v: unknown): string => typeof v === "string" ? v : (v == null ? "" : String(v));
function records(payload: any): any[] {
  const root = payload?.result ?? payload?.response ?? payload;
  const candidate = root?.items?.item ?? root?.items ?? root?.item ?? root?.list ?? root?.data ?? root?.searchResult?.item ?? root?.searchResult?.list ?? root?.result;
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    const nested = candidate.item ?? candidate.list ?? candidate.data;
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") return [nested];
  }
  return candidate && typeof candidate === "object" && (candidate.title_info || candidate.title) ? [candidate] : [];
}
serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  const key = Deno.env.get("NL_API_KEY");
  if (!key) return Response.json({ error: "NL_API_KEY is not configured" }, { status: 503, headers: cors });
  try {
    const body = await request.json();
    const isbnSearch = body?.isbnSearch === true;
    const query = value(body?.query).trim().slice(0, 120);
    if (!query || (isbnSearch && !/^(?:[0-9]{10}|[0-9]{13}|[0-9]{9}X)$/i.test(query))) {
      return Response.json({ error: "Invalid query" }, { status: 400, headers: cors });
    }
    const params = new URLSearchParams({
      key, apiType: "json", pageNum: "1", pageSize: "25", category: "도서",
    });
    if (isbnSearch) {
      params.set("detailSearch", "true");
      params.set("isbnOp", "isbn");
      params.set("isbnCode", query);
    } else {
      params.set("srchTarget", "total");
      params.set("kwd", query);
      if (body?.sort === "PublishTime") {
        params.set("sort", "ipub_year");
        params.set("order", "desc");
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let upstream: Response;
    try {
      upstream = await fetch(endpoint + "?" + params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) throw new Error("NL API HTTP " + upstream.status);
    const raw = await upstream.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new Error("NL API did not return JSON"); }
    const code = value(data?.errorCode ?? data?.error?.code ?? data?.code);
    if (code && /^(000|010|011|012|013|014|015|021|101)$/.test(code)) {
      throw new Error("NL API error " + code);
    }
    const items = records(data).map((item: any) => {
      const isbnText = value(item.isbn ?? item.isbn_info);
      const matches = isbnText.match(/97[89][0-9]{10}|[0-9]{9}[0-9X]/gi) ?? [];
      const isbn13 = matches.find((s: string) => s.length === 13) ?? "";
      const isbn = matches.find((s: string) => s.length === 10) ?? "";
      return {
        title: value(item.title_info ?? item.title),
        author: value(item.author_info ?? item.author),
        publisher: value(item.pub_info ?? item.publisher),
        pubDate: value(item.pub_year_info ?? item.pub_year),
        pages: "",
        cover: "",
        isbn, isbn13,
        itemId: value(item.control_no ?? item.id ?? isbn13 ?? isbn),
      };
    }).filter((item: any) => item.title && (!isbnSearch || item.isbn13 === query || item.isbn === query));
    return Response.json({ items }, { headers: cors });
  } catch (error) {
    console.error("NL books search failed", error);
    return Response.json({ error: "National Library search unavailable" }, { status: 502, headers: cors });
  }
});
