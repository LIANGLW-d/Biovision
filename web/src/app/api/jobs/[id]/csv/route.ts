export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { resolveBeaverApiBase } from "@/lib/beaverApiBase";

function pickForwardHeaders(response: Response, id: string) {
  const forward = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) forward.set("content-type", contentType);

  const disposition = response.headers.get("content-disposition");
  forward.set(
    "content-disposition",
    disposition || `attachment; filename=\"job_${id}.csv\"`,
  );

  const errType = response.headers.get("x-amzn-errortype");
  if (errType) forward.set("x-amzn-errortype", errType);
  const reqId = response.headers.get("x-amzn-requestid");
  if (reqId) forward.set("x-amzn-requestid", reqId);

  return forward;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const base = resolveBeaverApiBase().value;
    const url = new URL(`/api/jobs/${id}/csv`, base);
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return new Response(buffer, {
      status: response.status,
      headers: pickForwardHeaders(response, id),
    });
  } catch (error) {
    console.error("Job CSV API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
