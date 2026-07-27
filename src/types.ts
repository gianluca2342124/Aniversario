export type MediaKind = "image" | "video";

export interface MediaItem {
  id: string;
  key: string;
  uploadedAt: string;
  size: number;
  type: string;
  kind: MediaKind;
  url: string;
  posterKey?: string;
  posterUrl?: string;
}

export interface MediaResponse {
  media: MediaItem[];
  cursor: string | null;
}

export interface UploadSessionResponse {
  token: string;
  expiresAt: string;
}

export interface MultipartUploadDetails {
  key: string;
  uploadId: string;
  id: string;
  partSize: number;
}

export interface CreateUploadResponse {
  duplicate: boolean;
  media?: MediaItem;
  upload?: MultipartUploadDetails;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface CompleteUploadResponse {
  duplicate: boolean;
  media: MediaItem;
}
