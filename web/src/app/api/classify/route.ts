import { classifyImageBuffer } from "@/lib/classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGES = 5;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const files = [
      ...formData.getAll("file"),
      ...formData.getAll("files"),
    ].filter((item): item is File => item instanceof File);

    if (files.length === 0) {
      return new Response(JSON.stringify({ error: "No files uploaded." }), {
        status: 400,
      });
    }
    if (files.length > MAX_IMAGES) {
      return new Response(
        JSON.stringify({ error: `Too many files. Max ${MAX_IMAGES}.` }),
        { status: 400 },
      );
    }

    const modelId =
      (formData.get("modelId") as string | null) ||
      process.env.BEAVER_BEDROCK_MODEL_ID ||
      process.env.BEDROCK_MODEL_ID;

    if (!modelId) {
      return new Response(
        JSON.stringify({ error: "Missing Bedrock model id. Set BEAVER_BEDROCK_MODEL_ID." }),
        { status: 400 },
      );
    }

    const results = [];
    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const output = await classifyImageBuffer(modelId, Buffer.from(arrayBuffer));
      const result = { filename: file.name, ...output };
      results.push(result);
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error("Classify API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
