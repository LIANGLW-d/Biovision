export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { resolveBeaverApiBase } from "@/lib/beaverApiBase";

function pickForwardHeaders(response: Response) {
  const forward = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) forward.set("content-type", contentType);

  // Useful when BEAVER_API_BASE_URL points at API Gateway/Lambda URL.
  const errType = response.headers.get("x-amzn-errortype");
  if (errType) forward.set("x-amzn-errortype", errType);
  const reqId = response.headers.get("x-amzn-requestid");
  if (reqId) forward.set("x-amzn-requestid", reqId);

  return forward;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const base = resolveBeaverApiBase().value;
    const url = new URL("/api/classify", base);
    const response = await fetch(url, { method: "POST", body: formData });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: pickForwardHeaders(response),
    });
  } catch (error) {
    console.error("Classify API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
