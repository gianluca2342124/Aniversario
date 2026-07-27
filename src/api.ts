import type {
  CompleteUploadResponse,
  CreateUploadResponse,
  MediaResponse,
  UploadedPart,
  UploadSessionResponse,
} from "./types";

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The status message below is enough when the body is not JSON.
  }
  return `No se pudo completar la solicitud (${response.status}).`;
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

export async function getMedia(
  cursor?: string,
  admin = false,
): Promise<MediaResponse> {
  const params = new URLSearchParams({ limit: "24" });
  if (cursor) params.set("cursor", cursor);
  const endpoint = admin ? "/api/admin/media" : "/api/media";
  const response = await fetch(`${endpoint}?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<MediaResponse>;
}

export function createUploadSession(): Promise<UploadSessionResponse> {
  return jsonRequest("/api/uploads/session", { method: "POST", body: "{}" });
}

export function createMultipartUpload(
  payload: {
    name: string;
    type: string;
    size: number;
    kind: "image" | "video";
    signature: string;
    fingerprint: string;
  },
  token: string,
): Promise<CreateUploadResponse> {
  return jsonRequest("/api/uploads/create", {
    method: "POST",
    headers: { "x-upload-token": token },
    body: JSON.stringify(payload),
  });
}

export function uploadPart(
  upload: { key: string; uploadId: string },
  partNumber: number,
  chunk: Blob,
  token: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<UploadedPart> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      key: upload.key,
      uploadId: upload.uploadId,
      partNumber: String(partNumber),
    });
    const request = new XMLHttpRequest();
    request.open("PUT", `/api/uploads/part?${params}`);
    request.responseType = "json";
    request.setRequestHeader("x-upload-token", token);
    request.setRequestHeader("content-type", "application/octet-stream");

    const removeAbortListener = () =>
      signal.removeEventListener("abort", abortRequest);
    const abortRequest = () => request.abort();

    request.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      removeAbortListener();
      const body = request.response as
        | UploadedPart
        | { error?: string }
        | null;
      if (
        request.status >= 200 &&
        request.status < 300 &&
        body &&
        "etag" in body
      ) {
        resolve(body);
        return;
      }
      reject(
        new Error(
          body && "error" in body && body.error
            ? body.error
            : `No se pudo subir una parte (${request.status}).`,
        ),
      );
    });
    request.addEventListener("error", () => {
      removeAbortListener();
      reject(new Error("Se perdió la conexión durante la subida."));
    });
    request.addEventListener("abort", () => {
      removeAbortListener();
      reject(new DOMException("La subida se canceló.", "AbortError"));
    });

    signal.addEventListener("abort", abortRequest, { once: true });
    if (signal.aborted) {
      request.abort();
      return;
    }
    request.send(chunk);
  });
}

export function completeMultipartUpload(
  payload: {
    key: string;
    uploadId: string;
    parts: UploadedPart[];
  },
  token: string,
): Promise<CompleteUploadResponse> {
  return jsonRequest("/api/uploads/complete", {
    method: "POST",
    headers: { "x-upload-token": token },
    body: JSON.stringify(payload),
  });
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
  token: string,
): Promise<void> {
  const response = await fetch("/api/uploads/abort", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-upload-token": token,
    },
    body: JSON.stringify({ key, uploadId }),
  });
  if (!response.ok) throw new Error(await responseError(response));
}

export async function uploadPoster(
  mediaKey: string,
  poster: Blob,
  token: string,
): Promise<void> {
  const response = await fetch("/api/uploads/poster", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": poster.type || "image/webp",
      "x-media-key": mediaKey,
      "x-upload-token": token,
    },
    body: poster,
  });
  if (!response.ok) throw new Error(await responseError(response));
}

export async function deleteMedia(key: string): Promise<void> {
  const params = new URLSearchParams({ key });
  const response = await fetch(`/api/admin/media?${params}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(await responseError(response));
}
