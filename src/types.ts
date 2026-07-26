export interface Photo {
  id: string;
  key: string;
  uploadedAt: string;
  size: number;
  type: string;
  url: string;
}

export interface PhotosResponse {
  photos: Photo[];
  cursor: string | null;
}

export interface UploadResponse {
  photo: Photo;
  duplicate: boolean;
}
