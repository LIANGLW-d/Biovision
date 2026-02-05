import { getJob } from "@/lib/jobsDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    return new Response(
      JSON.stringify({
        job_id: job.id,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        total_images: job.total_images,
        completed_images: job.completed_images,
        error: job.error,
        results: job.results || [],
        csv_s3_key: job.csv_s3_key,
      }),
      { status: 200 },
    );
  } catch (error) {
    console.error("Job status API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
