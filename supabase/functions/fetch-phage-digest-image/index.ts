// Returns the bytes of a phage record's restriction digest image when it is held on PhagesDB.
// The Phage DNA Modification Analysis site uses it for TIFF and PDF images, which a browser cannot draw
// and usually cannot read from another site: the site converts the bytes to a picture itself.
// Only the address stored on the phage record is fetched, and only if it is a PhagesDB digest picture.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 30_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  let body: { phage_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const phageId = String(body?.phage_id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(phageId)) {
    return json({ error: "A valid phage_id is required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server configuration unavailable" }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data, error } = await supabase
    .from("phages")
    .select("restriction_digest_image_url")
    .eq("phage_id", phageId)
    .maybeSingle();
  if (error) return json({ error: "Database lookup failed" }, 500);
  if (!data) return json({ error: "Phage not found" }, 404);

  const imageUrl = String(data.restriction_digest_image_url || "").trim();
  if (!imageUrl) return json({ error: "No digest image address is recorded for this phage" }, 404);

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return json({ error: "The stored digest image address is invalid" }, 500);
  }
  const hostOk = parsed.protocol === "https:" && (parsed.hostname === "phagesdb.org" || parsed.hostname === "www.phagesdb.org");
  const pathOk = /^\/media\/digestPics\/[A-Za-z0-9._%()-]+\.(tiff?|pdf|png|jpe?g)$/i.test(parsed.pathname);
  if (!hostOk || !pathOk) return json({ error: "The stored address is not a PhagesDB digest picture" }, 400);

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: { "Accept": "image/*,application/pdf,*/*;q=0.8", "User-Agent": "RudnerLab-PhageTracker/1.0" },
      redirect: "follow",
    });
  } catch {
    return json({ error: "PhagesDB could not be reached" }, 502);
  }
  if (!upstream.ok) return json({ error: `PhagesDB image request returned ${upstream.status}` }, 502);
  if (Number(upstream.headers.get("content-length") || 0) > MAX_BYTES) return json({ error: "The image is larger than the permitted size" }, 413);

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return json({ error: "The image is larger than the permitted size" }, 413);
  if (!bytes.byteLength) return json({ error: "PhagesDB returned an empty file" }, 502);

  // application/octet-stream so the caller receives the bytes untouched
  return new Response(bytes, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" },
  });
});
