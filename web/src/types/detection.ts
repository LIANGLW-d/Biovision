export type DetectionLabel = "beaver" | "other_animal" | "no_animal" | "other";

export type JobStatus = "idle" | "queued" | "running" | "complete" | "error";

export interface DetectionResult {
  id: string;
  image_path: string;
  filename: string;
  predicted_label: DetectionLabel;
  confidence: number;
  reason: string;
  review_label: DetectionLabel;
  was_corrected: boolean;
  notes: string;
  model_id: string;
  has_beaver?: boolean;
  has_animal?: boolean;
  Common_Name?: string;
  manual_review?: boolean;
  animal_type?: string;
  animal_group?: string;
  animal_confidence?: number | string;
  animal_reason?: string;
  bbox?: string;
  overlay_location?: string;
  overlay_confidence?: number | string;
  overlay_reason?: string;
  overlay_temperature?: string;
  exif_timestamp?: string;
  exif_location?: string;
  error?: string;
}

export interface Job {
  id: string;
  name: string;
  status: JobStatus;
  created_at: string;
  image_count: number;
  results: DetectionResult[];
  csv_ready: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
