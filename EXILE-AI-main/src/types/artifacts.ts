/** Shapes returned by the local artifact engine (local/artifacts). */

export type ArtifactStage =
  | "queued" | "understanding" | "researching" | "generating" | "processing"
  | "validating" | "repairing" | "saving" | "delivering" | "completed" | "failed";

export interface ArtifactValidation {
  passed: boolean;
  checks: string[];
  failures: string[];
  /** Deeper checks that could not run on this machine (for example LibreOffice rendering). */
  skipped: string[];
}

export interface ArtifactResult {
  success: boolean;
  artifactId?: string;
  name?: string;
  mimeType?: string;
  extension?: string;
  sizeBytes?: number;
  version?: number;
  storageUri?: string;
  previewUri?: string;
  downloadUri?: string;
  state?: "validated";
  validation?: ArtifactValidation;
  metadata?: Record<string, unknown>;
  error?: string;
  code?: string;
  jobId?: string;
}

export type DeliveryState = "queued" | "sent" | "failed";

export interface ArtifactDelivery {
  id: string;
  channel: string;
  state: DeliveryState;
  queuedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface ArtifactSummary {
  artifactId: string;
  name: string;
  format: string;
  mimeType: string;
  kind: "document" | "data" | "presentation" | "archive" | "image" | "audio" | "video";
  extension: string;
  sizeBytes: number;
  version: number;
  versions: number;
  createdAt: number;
  updatedAt: number;
  validated: boolean;
  whatsappDeliverable: boolean;
  deliveries: ArtifactDelivery[];
}

export interface ArtifactVersionInfo {
  version: number;
  sizeBytes: number;
  createdAt: number;
  sha256: string;
  validation: ArtifactValidation;
}

export interface ArtifactDetail extends ArtifactSummary {
  versionList?: ArtifactVersionInfo[];
  derivedFrom?: { artifactId: string; version: number };
}

export interface ArtifactFormatInfo {
  format: string;
  label: string;
  mime: string;
  kind: ArtifactSummary["kind"];
  available: boolean;
  engine: string;
  reason?: string;
  whatsapp: boolean;
  preview: string;
}

export interface ArtifactCapabilities {
  formats: ArtifactFormatInfo[];
  validation: { officeRendering: string; mediaDecoding: string };
  engines: Record<string, unknown>;
  providers: { text: { providers: string[]; policy?: string; cooling?: string[]; note?: string } } & Record<string, unknown>;
  limits: { whatsappAttachmentBytes: number };
  conversions: string[];
}

export interface ArtifactPreview {
  artifactId: string;
  version: number;
  kind: "image" | "pdf" | "audio" | "video" | "text" | "html" | "table" | "slides" | "archive";
  mime: string;
  name: string;
  sizeBytes: number;
  text?: string;
  truncated?: boolean;
  width?: number;
  height?: number;
  sheets?: { name: string; rows: string[][]; totalRows: number }[];
  slides?: string[];
  entries?: { path: string; sizeBytes: number }[];
}

export interface ArtifactProgress {
  stage: ArtifactStage;
  message: string;
  t: number;
  attempt?: number;
}
