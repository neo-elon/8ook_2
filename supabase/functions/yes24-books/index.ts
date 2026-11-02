import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS" };
const str = (v: unknown) => v == null ? "" : String(v);
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null,{headers:cors});
  if (req.method !== "POST") return Response.json({error:"Method not allowed"},{status:405,headers:cors});
  const key = Deno.env.get("YES24_API_KEY");
  if (!key) return Response.json({error:"YES24_API_KEY not configured"},{status:503,headers:cors});
  try {
    const body = await req.json();
    const query = str(body?.query).trim().slice(0,120);
    const isbnSearch = body?.isbnSearch === true;
    if (!query || (isbnSearch && !/^(?:97[89][0-9]{10}|[0-9]{9}[0-9X])$/i.test(query))) return Response.json({error:"Invalid query"},{status:400,headers:cors});
    const url = new URL(isbnSearch ? "https://apis.yes24.com/v1/goods/itemDetail" : "https://apis.yes24.com/v1/goods/itemList");
    url.searchParams.set("query",query);
    url.searchParams.set("detail","Y");
    if (isbnSearch) url.searchParams.set("searchType","ISBN13");
    else {
      url.searchParams.set("category","BOOK");
      url.searchParams.set("page","1");
      url.searchParams.set("pageSize","25");
      url.searchParams.set("sort",body?.sort === "PublishTime" ? "RECENT" : "RELATION");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),10000);
    let response: Response;
    try { response = await fetch(url,{headers:{"X-Api-Key":key},signal:controller.signal}); }
    finally { clearTimeout(timer); }
    if (!response.ok) throw Error("YES24 HTTP "+response.status);
    const payload = await response.json();
    if (payload?.success !== true) throw Error("YES24 response failure");
    const raw = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    const items = raw.filter((v:any)=>v && v.adultYn !== "Y").map((v:any)=>({
      title:str(v.title), author:str(v.author), publisher:str(v.publisher),
      pubDate:str(v.publishDate), pages: Number(v.pages)>0 ? Number(v.pages) : "",
      cover:str(v.cover).startsWith("https://") ? v.cover : "",
      sideCover:str(v.sideCover).startsWith("https://") ? v.sideCover : "",
      isbn:str(v.isbn10), isbn13:str(v.isbn13), itemId:str(v.itemId),
      source:"YES24", sourceUrl:str(v.link)
    })).filter((v:any)=>v.title && (!isbnSearch || v.isbn13 === query));
    return Response.json({items},{headers:cors});
  } catch (error) {
    console.error("YES24 search failed",error instanceof Error ? error.message : "unknown");
    return Response.json({error:"YES24 search unavailable"},{status:502,headers:cors});
  }
});