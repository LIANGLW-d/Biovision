import { useState, useCallback } from "react";
import { Job, DetectionResult, DetectionLabel } from "@/types/detection";

const generateJobId = () =>
  `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const useDetectionJob = () => {
  const [currentJob, setCurrentJob] = useState<Job | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [s3Path, setS3Path] = useState("");
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  const createJob = useCallback((name: string) => {
    const job: Job = {
      id: generateJobId(),
      name,
      status: "idle",
      created_at: new Date().toISOString(),
      image_count: 0,
      results: [],
      csv_ready: false,
    };
    setCurrentJob(job);
    return job;
  }, []);

  const uploadFiles = useCallback(
    (files: File[]) => {
      setUploadedFiles(files);
      setS3Path("");
      const nextPreviewUrls: Record<string, string> = {};
      files.forEach((file) => {
        nextPreviewUrls[file.name] = URL.createObjectURL(file);
      });
      setPreviewUrls(nextPreviewUrls);
      if (currentJob) {
        setCurrentJob({
          ...currentJob,
          image_count: files.length,
        });
      }
    },
    [currentJob]
  );

  const updateS3Path = useCallback(
    (value: string) => {
      setS3Path(value);
      if (value.trim().length > 0) {
        setUploadedFiles([]);
        setPreviewUrls({});
        if (currentJob) {
          setCurrentJob({
            ...currentJob,
            image_count: 0,
          });
        }
      }
    },
    [currentJob]
  );

  const runDetection = useCallback(async () => {
    if (!currentJob) return;
    if (uploadedFiles.length === 0 && !s3Path.trim()) return;

    setCurrentJob({ ...currentJob, status: "queued" });
    setProgress(10);

    try {
      setCurrentJob((prev) => (prev ? { ...prev, status: "running" } : null));

      const formData = new FormData();
      formData.append("jobName", currentJob.name);
      if (s3Path.trim()) {
        formData.append("s3Path", s3Path.trim());
      } else {
        uploadedFiles.forEach((file) => {
          formData.append("files", file, file.name);
        });
      }

      const response = await fetch("/api/beaver/run", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || "Detection failed");
      }

      const payload = await response.json();
      const results: DetectionResult[] = (payload.results || []).map((result: DetectionResult) => {
        const preview = previewUrls[result.filename];
        return preview ? { ...result, image_path: preview } : result;
      });

      setProgress(100);
      setCurrentJob((prev) =>
        prev
          ? {
              ...prev,
              status: "complete",
              results,
              csv_ready: true,
              image_count: results.length,
            }
          : null
      );
    } catch (error) {
      console.error("Detection error:", error);
      setCurrentJob((prev) => (prev ? { ...prev, status: "error" } : null));
    }
  }, [currentJob, previewUrls, s3Path, uploadedFiles]);

  const updateResultLabel = useCallback((resultId: string, newLabel: DetectionLabel) => {
    setCurrentJob((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        results: prev.results.map((result) =>
          result.id === resultId
            ? {
                ...result,
                review_label: newLabel,
                was_corrected: newLabel !== result.predicted_label,
              }
            : result
        ),
      };
    });
  }, []);

  const updateResultNotes = useCallback((resultId: string, notes: string) => {
    setCurrentJob((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        results: prev.results.map((result) =>
          result.id === resultId ? { ...result, notes } : result
        ),
      };
    });
  }, []);

  const exportCSV = useCallback(() => {
    if (!currentJob) return;

    const headers = [
      "image_path",
      "has_beaver",
      "confidence",
      "reason",
      "bbox",
      "has_animal",
      "Common_Name",
      "manual_review",
      "animal_group",
      "animal_confidence",
      "animal_reason",
      "overlay_location",
      "overlay_confidence",
      "overlay_reason",
      "model_id",
      "exif_timestamp",
      "exif_location",
      "error",
      "review_label",
      "was_corrected",
      "notes",
    ];

    const rows = currentJob.results.map((r) =>
      [
        r.image_path,
        r.has_beaver ?? "",
        typeof r.confidence === "number" ? r.confidence.toFixed(3) : r.confidence ?? "",
        `"${r.reason}"`,
        r.bbox ?? "",
        r.has_animal ?? "",
        r.Common_Name ?? r.animal_type ?? "",
        r.manual_review ?? "",
        r.animal_group ?? "",
        r.animal_confidence ?? "",
        `"${r.animal_reason ?? ""}"`,
        r.overlay_location ?? "",
        r.overlay_confidence ?? "",
        `"${r.overlay_reason ?? ""}"`,
        r.model_id,
        r.exif_timestamp ?? "",
        r.exif_location ?? "",
        `"${r.error ?? ""}"`,
        r.review_label,
        r.was_corrected,
        `"${r.notes}"`,
      ].join(",")
    );

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentJob.name.replace(/\s+/g, "_")}_results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentJob]);

  return {
    currentJob,
    uploadedFiles,
    s3Path,
    progress,
    createJob,
    uploadFiles,
    setS3Path: updateS3Path,
    runDetection,
    updateResultLabel,
    updateResultNotes,
    exportCSV,
    setCurrentJob,
  };
};
