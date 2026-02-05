import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { getJob } from "@/lib/jobsDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = await getJob(id);
    if (!job) {
      return new Response(JSON.stringify({ error: "Job not found." }), {
        status: 404,
      });
    }
    if (!job.csv_s3_key) {
      return new Response(JSON.stringify({ error: "CSV not ready." }), {
        status: 400,
      });
    }

    const bucket = process.env.BEAVER_JOB_BUCKET;
    const region = process.env.AWS_REGION;
    if (!bucket || !region) {
      return new Response(JSON.stringify({ error: "Missing S3 configuration." }), {
        status: 500,
      });
    }

    const s3Client = new S3Client({ region });
    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: job.csv_s3_key,
      }),
    );

    const body = result.Body as Readable | undefined;
    if (!body) {
      return new Response(JSON.stringify({ error: "CSV not found." }), {
        status: 404,
      });
    }

    const buffer = await streamToBuffer(body);
    return new Response(buffer, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename=\"job_${id}.csv\"`,
      },
    });
  } catch (error) {
    console.error("Job CSV API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
