import type { PhotosResponse, UploadResponse } from "./types";

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The status message below is enough when the body is not JSON.
  }
  return `No se pudo completar la solicitud (${response.status}).`;
}

export async function getPhotos(
  cursor?: string,
  admin = false,
): Promise<PhotosResponse> {
  const params = new URLSearchParams({ limit: "24" });
  if (cursor) params.set("cursor", cursor);
  const endpoint = admin ? "/api/admin/photos" : "/api/photos";
  const response = await fetch(`${endpoint}?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<PhotosResponse>;
}

export function uploadPhoto(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/photos");
    request.responseType = "json";

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });

    request.addEventListener("load", () => {
      const body = request.response as
        | UploadResponse
        | { error?: string }
        | null;
      if (request.status >= 200 && request.status < 300 && body && "photo" in body) {
        resolve(body);
        return;
      }
      reject(
        new Error(
          body && "error" in body && body.error
            ? body.error
            : `No se pudo subir la fotografía (${request.status}).`,
        ),
      );
    });

    request.addEventListener("error", () => {
      reject(new Error("Se perdió la conexión durante la subida."));
    });

    request.addEventListener("abort", () => {
      reject(new Error("La subida se canceló."));
    });

    const formData = new FormData();
    formData.append("photo", file, file.name);
    request.send(formData);
  });
}

export async function deletePhoto(key: string): Promise<void> {
  const params = new URLSearchParams({ key });
  const response = await fetch(`/api/admin/photos?${params}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(await responseError(response));
}
