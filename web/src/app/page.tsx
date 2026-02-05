"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { postProcessAnimalOutput } from "@/lib/animalPostProcess";

type DetectionResult = {
  id: string;
  image_path: string;
  filename: string;
  predicted_label: string;
  review_label: string;
  was_corrected: boolean;
  confidence: number;
  reason: string;
  notes: string;
  model_id: string;
  has_beaver: boolean;
  has_animal: boolean;
  Common_Name: string;
  manual_review: boolean;
  animal_type: string;
  animal_group: string;
  animal_confidence: number | string;
  animal_reason: string;
  bbox: string;
  overlay_location: string;
  overlay_confidence: number | string;
  overlay_reason: string;
  overlay_temperature: string;
  exif_timestamp: string;
  exif_location: string;
  error: string;
};

const REVIEW_LABELS = [
  { value: "beaver", label: "Beaver" },
  { value: "other_animal", label: "Other animal" },
  { value: "no_animal", label: "No animal" },
];

function escapeCsv(value: unknown) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function buildCsv(rows: DetectionResult[]) {
  if (rows.length === 0) return "";
  const headers = [
    "image_path",
    "filename",
    "predicted_label",
    "review_label",
    "was_corrected",
    "confidence",
    "reason",
    "notes",
    "has_beaver",
    "has_animal",
    "Common_Name",
    "manual_review",
    "animal_group",
    "animal_confidence",
    "animal_reason",
    "bbox",
    "overlay_location",
    "overlay_confidence",
    "overlay_reason",
    "exif_timestamp",
    "exif_location",
    "error",
    "model_id",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((key) => escapeCsv((row as Record<string, unknown>)[key])).join(","),
    ),
  ];
  return lines.join("\n");
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "chat">("dashboard");
  const [s3Path, setS3Path] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [results, setResults] = useState<DetectionResult[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [jobCsvKey, setJobCsvKey] = useState<string>("");
  const [jobProgress, setJobProgress] = useState<{ completed: number; total: number }>({
    completed: 0,
    total: 0,
  });

  const [csvPath, setCsvPath] = useState("");
  const [modelId, setModelId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvName, setCsvName] = useState("");
  const [input, setInput] = useState("");
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [showCsvPanel, setShowCsvPanel] = useState(true);
  const [chatMessages, setChatMessages] = useState<
    Array<{ id: string; role: "user" | "assistant"; text: string }>
  >([]);
  const [chatStatus, setChatStatus] = useState<"idle" | "loading">("idle");
  const [chatError, setChatError] = useState("");

  const folderInputRef = useRef<HTMLInputElement>(null);
  const csvFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const inputEl = folderInputRef.current;
    if (inputEl) {
      inputEl.setAttribute("webkitdirectory", "");
      inputEl.setAttribute("directory", "");
    }
  }, []);

  const stats = useMemo(() => {
    let beavers = 0;
    let otherAnimals = 0;
    let noAnimals = 0;
    let manualReview = 0;
    let errors = 0;

    for (const row of results) {
      if (row.error) {
        errors += 1;
        continue;
      }
      if (row.manual_review) {
        manualReview += 1;
      }
      if (row.review_label === "beaver") {
        beavers += 1;
      } else if (row.review_label === "other_animal") {
        otherAnimals += 1;
      } else {
        noAnimals += 1;
      }
    }

    return {
      total: results.length,
      beavers,
      otherAnimals,
      noAnimals,
      manualReview,
      errors,
    };
  }, [results]);

  const resultsCsv = useMemo(() => buildCsv(results), [results]);

  const mapClassifyResults = (items: Array<{
    filename: string;
    is_beaver: boolean;
    confidence: number;
    common_name: string;
    group: string;
    notes: string;
    overlay_location?: string;
    overlay_confidence?: number;
    overlay_reason?: string;
    overlay_temperature?: string;
    exif_timestamp?: string;
  }>) => {
    const timestamp = Date.now();
    return items.map((result, index) => {
      const post = postProcessAnimalOutput({
        common_name: result.common_name,
        confidence: result.confidence,
        group: result.group,
        notes: result.notes,
      });

      let commonName = post.Common_Name;
      let manualReview = post.manual_review;
      let confidence = post.confidence;
      let group = result.group;

      if (result.is_beaver) {
        commonName = "Beaver";
        manualReview = false;
        group = "mammal";
        confidence = result.confidence;
      } else if (commonName === "No animal") {
        group = "none";
      }

      const predictedLabel =
        result.is_beaver
          ? "beaver"
          : commonName && commonName !== "No animal" && commonName !== "unknown"
            ? "other_animal"
            : "no_animal";

      return {
        id: `classify_${timestamp}_${index}`,
        image_path: result.filename || "",
        filename: result.filename || "",
        predicted_label: predictedLabel,
        review_label: predictedLabel,
        was_corrected: false,
        confidence,
        reason: result.notes || "",
        notes: post.notes || "",
        model_id: "",
        has_beaver: result.is_beaver,
        has_animal: commonName !== "No animal",
        Common_Name: commonName,
        manual_review: manualReview,
        animal_type: commonName,
        animal_group: group,
        animal_confidence: confidence,
        animal_reason: result.notes || "",
        bbox: "",
        overlay_location: result.overlay_location || "",
        overlay_confidence: result.overlay_confidence ?? "",
        overlay_reason: result.overlay_reason || "",
        overlay_temperature: result.overlay_temperature || "",
        exif_timestamp: result.exif_timestamp || "",
        exif_location: "",
        error: "",
      };
    });
  };

  const handleRunDetection = async () => {
    setRunError("");
    setIsRunning(true);
    try {
      const formData = new FormData();
      const s3 = s3Path.trim();
      const allFiles = [...files, ...folderFiles];
      const useClassifyApi = !s3 && allFiles.length > 0 && allFiles.length <= 5;
      const useJobsApi = Boolean(s3) || (!s3 && allFiles.length > 5);

      if (s3) {
        formData.set("s3Path", s3);
      } else {
        if (allFiles.length === 0) {
          throw new Error("Select files or enter an S3 path.");
        }
        for (const file of allFiles) {
          formData.append("files", file);
        }
      }

      const response = await fetch(useClassifyApi ? "/api/classify" : "/api/jobs", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Detection failed.");
      }

      const payload = await response.json();

      if (useJobsApi) {
        const nextJobId = payload.job_id as string | undefined;
        if (!nextJobId) {
          throw new Error("Job creation failed.");
        }
        setJobId(nextJobId);
        setJobStatus(payload.status || "queued");
        setJobCsvKey("");
        setJobProgress({ completed: 0, total: payload.total_images || 0 });

        let attempts = 0;
        const maxAttempts = Infinity;
        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const jobResponse = await fetch(`/api/jobs/${nextJobId}`);
          const jobPayload = await jobResponse.json();
          setJobStatus(jobPayload.status || "");
          setJobProgress({
            completed: jobPayload.completed_images || 0,
            total: jobPayload.total_images || 0,
          });
          if (jobPayload.status === "complete") {
            const mapped = mapClassifyResults(jobPayload.results || []);
            setResults(mapped);
            setJobCsvKey(jobPayload.csv_s3_key || "");
            break;
          }
          if (jobPayload.status === "error") {
            throw new Error(jobPayload.error || "Job failed.");
          }
          attempts += 1;
        }
      } else if (useClassifyApi) {
        const mapped = mapClassifyResults(payload.results || []);
        setResults(mapped);
        setJobId(null);
        setJobStatus("");
        setJobCsvKey("");
        setJobProgress({ completed: 0, total: 0 });
      }
      setCsvText("");
      setCsvPath("");
      setCsvName("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setRunError(message);
    } finally {
      setIsRunning(false);
    }
  };

  const handleUpdateReview = (id: string, nextLabel: string) => {
    setResults((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const was_corrected = row.predicted_label !== nextLabel;
        return { ...row, review_label: nextLabel, was_corrected };
      }),
    );
  };

  const handleUpdateNotes = (id: string, notes: string) => {
    setResults((prev) =>
      prev.map((row) => (row.id === id ? { ...row, notes } : row)),
    );
  };

  const handleDownloadCsv = () => {
    if (!resultsCsv) return;
    const blob = new Blob([resultsCsv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "beaver_results_reviewed.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJobCsv = async () => {
    if (!jobId || !jobCsvKey) return;
    const response = await fetch(`/api/jobs/${jobId}/csv`);
    if (!response.ok) {
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `job_${jobId}_results.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleSendChat = async (messageText: string = input) => {
    if (!messageText.trim()) return;
    setChatError("");
    const userMessage = {
      id: `user_${Date.now()}`,
      role: "user" as const,
      text: messageText.trim(),
    };
    const nextMessages = [...chatMessages, userMessage];
    setChatMessages(nextMessages);
    setInput("");
    setChatStatus("loading");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: messageText.trim(), csvText, modelId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Chat request failed.");
      }
      const assistantMessage = {
        id: `assistant_${Date.now()}`,
        role: "assistant" as const,
        text: payload.text || "",
      };
      setChatMessages([...nextMessages, assistantMessage]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setChatError(message);
    } finally {
      setChatStatus("idle");
    }
  };

  const displayMessages = useMemo(() => chatMessages, [chatMessages]);

  const isTyping = chatStatus === "loading";

  const toggleRow = (id: string) => {
    setExpandedRows((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };


  return (
    <div className="min-h-screen text-[hsl(var(--foreground))]">
      <div className="flex min-h-screen">
        <aside className="flex w-60 flex-col gap-6 border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar))]/80 px-5 py-6 backdrop-blur">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.35em] text-[hsl(var(--muted-foreground))]">
              DFW Beaver ID
            </p>
            <h1 className="mt-2 text-lg font-semibold">Field Ops Console</h1>
          </div>
          <nav className="flex flex-col gap-2 text-sm">
            <button
              type="button"
              onClick={() => setActiveTab("dashboard")}
              className={`rounded-[var(--radius)] px-3 py-2 text-left font-medium transition ${
                activeTab === "dashboard"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-sm"
                  : "hover:bg-white/70"
              }`}
            >
              Workflow
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("chat")}
              className={`rounded-[var(--radius)] px-3 py-2 text-left font-medium transition ${
                activeTab === "chat"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-sm"
                  : "hover:bg-white/70"
              }`}
            >
              Chat
            </button>
          </nav>
          <div className="mt-auto rounded-2xl border border-[hsl(var(--border))] bg-white/80 p-3 text-xs text-[hsl(var(--muted-foreground))] shadow-sm">
            Local runner
            <p className="mt-1 text-[11px]">
              Uses `/api/classify` ({"<=5"} images) or `/api/jobs` (batch) + Bedrock chat.
            </p>
          </div>
        </aside>

        <main className="flex-1 px-6 py-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col">
            <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold">
                {activeTab === "dashboard" ? "Detection Workflow" : "Chat"}
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-[hsl(var(--muted-foreground))]">
                Upload trail-cam batches, run Beaver + Animal ID, review labels, export CSVs, and
                ask questions against the results.
              </p>
            </div>
            <div className="rounded-full border border-[hsl(var(--border))] bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] shadow-sm">
              Vercel-style UI
            </div>
          </header>

            {activeTab === "dashboard" ? (
              <section className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-3xl border border-[hsl(var(--border))] bg-white/90 p-6 shadow-lg shadow-black/5">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Input
                </h3>
                <div className="mt-4 grid gap-4 text-sm">
                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      Upload images
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => {
                        setFiles(Array.from(event.target.files || []));
                      }}
                      className="mt-2 block w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-xs shadow-sm"
                    />
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {files.length} image(s) selected.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      Upload folder
                    </label>
                    <input
                      ref={folderInputRef}
                      type="file"
                      multiple
                      onChange={(event) => {
                        setFolderFiles(Array.from(event.target.files || []));
                      }}
                      className="mt-2 block w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-xs shadow-sm"
                    />
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {folderFiles.length} file(s) from folder.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      Or S3 path
                    </label>
                    <input
                      value={s3Path}
                      onChange={(event) => setS3Path(event.target.value)}
                      placeholder="s3://bucket/path/to/images/"
                      className="mt-2 block w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                    />
                  </div>

                  {runError && (
                    <p className="rounded-[var(--radius)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {runError}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={handleRunDetection}
                    disabled={isRunning}
                    className="rounded-2xl bg-[hsl(var(--accent))] px-4 py-3 text-sm font-semibold text-[hsl(var(--accent-foreground))] shadow-md shadow-black/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRunning ? "Running detection..." : "Run detection"}
                  </button>
                  {jobStatus && (
                    <div className="space-y-2 text-xs text-[hsl(var(--muted-foreground))]">
                      <p>
                        Job status: <span className="font-semibold">{jobStatus}</span>
                        {jobProgress.total > 0 && (
                          <span className="ml-2">
                            {jobProgress.completed}/{jobProgress.total}
                          </span>
                        )}
                      </p>
                      {jobProgress.total > 0 && (
                        <div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-[hsl(var(--border))]">
                            <div
                              className="h-full rounded-full bg-[hsl(var(--accent))] transition-all"
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.round(
                                    (jobProgress.completed / jobProgress.total) * 100,
                                  ),
                                )}%`,
                              }}
                            />
                          </div>
                          <p className="mt-1 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                            {Math.min(
                              100,
                              Math.round(
                                (jobProgress.completed / jobProgress.total) * 100,
                              ),
                            )}
                            % complete
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-[hsl(var(--border))] bg-white/90 p-6 shadow-lg shadow-black/5">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Summary
                </h3>
                <div className="mt-4 grid gap-3 text-sm">
                  <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-4">
                    <p className="text-xs uppercase text-[hsl(var(--muted-foreground))]">Total images</p>
                    <p className="text-2xl font-semibold">{stats.total}</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[hsl(var(--border))] bg-white p-4">
                      <p className="text-xs uppercase text-[hsl(var(--muted-foreground))]">Animals</p>
                      <p className="text-xl font-semibold">
                        {stats.beavers + stats.otherAnimals}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[hsl(var(--border))] bg-white p-4">
                      <p className="text-xs uppercase text-[hsl(var(--muted-foreground))]">Beavers</p>
                      <p className="text-xl font-semibold">{stats.beavers}</p>
                    </div>
                    <div className="rounded-2xl border border-[hsl(var(--border))] bg-white p-4">
                      <p className="text-xs uppercase text-[hsl(var(--muted-foreground))]">Other animals</p>
                      <p className="text-xl font-semibold">{stats.otherAnimals}</p>
                    </div>
                    <div className="rounded-2xl border border-[hsl(var(--border))] bg-white p-4">
                      <p className="text-xs uppercase text-[hsl(var(--muted-foreground))]">No animal</p>
                      <p className="text-xl font-semibold">{stats.noAnimals}</p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadCsv}
                  disabled={!resultsCsv}
                  className="mt-6 w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-4 py-3 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Download reviewed CSV
                </button>
                {jobCsvKey && (
                  <button
                    type="button"
                    onClick={handleDownloadJobCsv}
                    className="mt-3 w-full rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-4 py-3 text-sm font-semibold shadow-sm"
                  >
                    Download job CSV
                  </button>
                )}
              </div>
            </section>
            ) : (
              <section className="mt-8 grid gap-4">
                <div className="rounded-3xl border border-[hsl(var(--border))] bg-white/90 shadow-lg shadow-black/5">
                  <button
                    type="button"
                    onClick={() => setShowCsvPanel((prev) => !prev)}
                    className="flex w-full items-center justify-between px-6 py-4 text-left text-sm font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]"
                  >
                    CSV Inputs
                    <span className="text-xs normal-case text-[hsl(var(--muted-foreground))]">
                      {showCsvPanel ? "Hide" : "Show"}
                    </span>
                  </button>
                  {showCsvPanel && (
                    <div className="border-t border-[hsl(var(--border))] px-6 py-4">
                      <div className="grid gap-4 lg:grid-cols-[1fr_0.7fr]">
                        <div className="grid gap-3 text-sm">
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                              CSV path (server)
                            </label>
                            <input
                              value={csvPath}
                              onChange={(event) => setCsvPath(event.target.value)}
                              placeholder="/path/to/beaver_results.csv"
                              className="mt-2 w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                              Bedrock model ID (optional)
                            </label>
                            <input
                              value={modelId}
                              onChange={(event) => setModelId(event.target.value)}
                              placeholder="arn:aws:bedrock:us-east-2:..."
                              className="mt-2 w-full rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                              Upload CSV
                            </label>
                            <div className="mt-2 flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => csvFileRef.current?.click()}
                                className="rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-xs font-semibold shadow-sm"
                              >
                                Choose file
                              </button>
                              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                                {csvName || "No file selected"}
                              </span>
                            </div>
                            <input
                              ref={csvFileRef}
                              type="file"
                              accept=".csv"
                              className="hidden"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (!file) {
                                  setCsvText("");
                                  setCsvName("");
                                  return;
                                }
                                setCsvName(file.name);
                                const reader = new FileReader();
                                reader.onload = () => {
                                  setCsvText(String(reader.result || ""));
                                };
                                reader.readAsText(file);
                              }}
                            />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setCsvText(resultsCsv)}
                              disabled={!resultsCsv}
                              className="rounded-2xl bg-[hsl(var(--accent))] px-3 py-2 text-xs font-semibold text-[hsl(var(--accent-foreground))] shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Use latest results
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCsvText("");
                                setCsvPath("");
                                setCsvName("");
                              }}
                              className="rounded-2xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-xs font-semibold shadow-sm"
                            >
                              Clear CSV
                            </button>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-4 text-xs text-[hsl(var(--muted-foreground))]">
                          <p className="font-semibold text-[hsl(var(--foreground))]">CSV status</p>
                          <p className="mt-2">
                            {csvText
                              ? `CSV text loaded (${csvText.length} chars).`
                              : "No CSV text loaded yet."}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="rounded-3xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm">
                  <div className="flex items-center justify-between px-6 py-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      Chat
                    </h3>
                    {isTyping && (
                      <span className="text-xs text-[hsl(var(--muted-foreground))]">
                        Thinking...
                      </span>
                    )}
                  </div>

                  <div className="max-h-[55vh] overflow-y-auto px-6 pb-24">
                    <div className="flex flex-col gap-3">
                      {displayMessages.length === 0 && (
                        <p className="text-sm text-[hsl(var(--muted-foreground))]">
                          Ask: “How many beavers are detected?” or “List animals found.”
                        </p>
                      )}
                      {displayMessages.map((message) => (
                        <div
                          key={message.id}
                          className={`rounded-2xl px-4 py-3 text-sm ${
                            message.role === "user"
                              ? "ml-auto bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"
                              : "bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]"
                          }`}
                        >
                          {message.text}
                        </div>
                      ))}
                      {chatError && (
                        <p className="text-xs text-red-600">Error: {chatError}</p>
                      )}
                    </div>
                  </div>

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleSendChat();
                    }}
                    className="sticky bottom-0 border-t border-[hsl(var(--border))] bg-white/90 px-6 py-4 backdrop-blur"
                  >
                    <div className="flex gap-3">
                      <input
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        placeholder="Ask a question..."
                        className="flex-1 rounded-2xl border border-[hsl(var(--border))] bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                      />
                      <button
                        type="submit"
                        disabled={!input.trim()}
                        className="rounded-2xl bg-[hsl(var(--accent))] px-4 py-3 text-sm font-semibold text-[hsl(var(--accent-foreground))] shadow-md shadow-black/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Send
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            )}

            {activeTab === "dashboard" && (
              <section className="mt-8 rounded-3xl border border-[hsl(var(--border))] bg-white/90 p-6 shadow-lg shadow-black/5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Review Results
                </h3>
                <p className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  {results.length} row(s)
                </p>
              </div>

              {results.length === 0 ? (
                <p className="mt-6 text-sm text-[hsl(var(--muted-foreground))]">
                  Run a detection job to see results here.
                </p>
              ) : (
                <div className="mt-6 overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
                        <th className="px-3 py-2 font-semibold">File</th>
                        <th className="px-3 py-2 font-semibold">Predicted</th>
                        <th className="px-3 py-2 font-semibold">Review</th>
                        <th className="px-3 py-2 font-semibold">Confidence</th>
                        <th className="px-3 py-2 font-semibold">Common_Name</th>
                        <th className="px-3 py-2 font-semibold">Flags</th>
                        <th className="px-3 py-2 font-semibold">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((row) => {
                        const isExpanded = expandedRows.includes(row.id);
                        return (
                          <Fragment key={row.id}>
                            <tr
                              className="border-b border-[hsl(var(--border))] bg-white"
                            >
                              <td className="px-3 py-2">
                                <div className="font-semibold">
                                  {row.filename || "image"}
                                </div>
                                <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                  {row.image_path}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <span className="rounded-full bg-[hsl(var(--primary))] px-2 py-1 text-[10px] text-[hsl(var(--primary-foreground))]">
                                  {row.predicted_label}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <select
                                  value={row.review_label}
                                  onChange={(event) =>
                                    handleUpdateReview(row.id, event.target.value)
                                  }
                                  className="rounded-xl border border-[hsl(var(--border))] bg-white px-2 py-1 text-xs"
                                >
                                  {REVIEW_LABELS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-3 py-2 font-semibold">
                                {row.confidence || 0}
                              </td>
                              <td className="px-3 py-2">
                                {row.Common_Name || "unknown"}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap gap-1 text-[10px]">
                                  {row.manual_review && (
                                    <span className="rounded-full bg-[#f6d686] px-2 py-1 text-[#5d4a1f]">
                                      review
                                    </span>
                                  )}
                                  {row.error && (
                                    <span className="rounded-full bg-[#f5c0b6] px-2 py-1 text-[#6d2f24]">
                                      error
                                    </span>
                                  )}
                                  {row.was_corrected && (
                                    <span className="rounded-full bg-[#cbe6d6] px-2 py-1 text-[#1f5a3d]">
                                      corrected
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => toggleRow(row.id)}
                                  className="text-xs font-semibold text-[hsl(var(--accent))]"
                                >
                                  {isExpanded ? "Hide" : "Show"}
                                </button>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
                                <td colSpan={7} className="px-3 py-3">
                                  <div className="grid gap-3 text-xs">
                                    <div>
                                      <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                                        Reviewer notes
                                      </p>
                                      <textarea
                                        value={row.notes}
                                        onChange={(event) =>
                                          handleUpdateNotes(row.id, event.target.value)
                                        }
                                        rows={2}
                                        className="mt-1 w-full rounded-xl border border-[hsl(var(--border))] bg-white px-3 py-2 text-xs"
                                        placeholder="Add review notes..."
                                      />
                                    </div>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                      <div className="flex justify-between">
                                        <span>Animal group</span>
                                        <span className="font-semibold">
                                          {row.animal_group || "unknown"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Overlay site</span>
                                        <span className="font-semibold">
                                          {row.overlay_location || "—"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>EXIF time</span>
                                        <span className="font-semibold">
                                          {row.exif_timestamp || "—"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Animal reason</span>
                                        <span className="font-semibold">
                                          {row.animal_reason || "—"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Overlay reason</span>
                                        <span className="font-semibold">
                                          {row.overlay_reason || "—"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Overlay temp</span>
                                        <span className="font-semibold">
                                          {row.overlay_temperature || "—"}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span>Error</span>
                                        <span className="font-semibold">{row.error || "—"}</span>
                                      </div>
                                    </div>
                                    {row.reason && (
                                      <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                        Beaver reason: {row.reason}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
