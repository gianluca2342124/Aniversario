import type { MediaKind } from "./types";

const MAX_IMAGE_EDGE = 2000;
const MAX_POSTER_EDGE = 1080;
const WEBP_QUALITY = 0.86;
const FINGERPRINT_SAMPLE_SIZE = 64 * 1024;

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
]);

const allowedExtensions = /\.(jpe?g|png|webp|heic|heif|mp4|mov|m4v|webm)$/i;
const videoExtensions = /\.(mp4|mov|m4v|webm)$/i;

export function isAcceptedMedia(file: File): boolean {
  return file.type
    ? allowedMimeTypes.has(file.type.toLowerCase())
    : allowedExtensions.test(file.name);
}

export function mediaKind(file: File): MediaKind {
  return file.type.toLowerCase().startsWith("video/") ||
    videoExtensions.test(file.name)
    ? "video"
    : "image";
}

export function normalizedMimeType(file: File): string {
  const declared = file.type.toLowerCase();
  if (declared === "image/jpg") return "image/jpeg";
  if (declared === "video/x-m4v") return "video/mp4";
  if (allowedMimeTypes.has(declared)) return declared;

  const extension = file.name.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
    webm: "video/webm",
  };
  return extension ? (byExtension[extension] ?? "") : "";
}

export async function fileSignature(file: File): Promise<string> {
  const bytes = new Uint8Array(
    await file.slice(0, Math.min(file.size, 64)).arrayBuffer(),
  );
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export async function fileFingerprint(file: File): Promise<string> {
  const head = new Uint8Array(
    await file
      .slice(0, Math.min(file.size, FINGERPRINT_SAMPLE_SIZE))
      .arrayBuffer(),
  );
  const tailStart = Math.max(0, file.size - FINGERPRINT_SAMPLE_SIZE);
  const tail =
    tailStart === 0
      ? new Uint8Array()
      : new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const metadata = new TextEncoder().encode(
    `${file.size}:${normalizedMimeType(file)}:`,
  );
  const sample = new Uint8Array(metadata.length + head.length + tail.length);
  sample.set(metadata);
  sample.set(head, metadata.length);
  sample.set(tail, metadata.length + head.length);

  const digest = await crypto.subtle.digest("SHA-256", sample);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("El navegador no pudo preparar el archivo."));
      },
      type,
      quality,
    );
  });
}

async function imageElement(file: File): Promise<{
  image: HTMLImageElement;
  width: number;
  height: number;
  release: () => void;
}> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;

  try {
    await image.decode();
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function compressImage(file: File): Promise<File> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let release: () => void = () => {};

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    release = () => bitmap.close();
  } catch {
    try {
      const decoded = await imageElement(file);
      source = decoded.image;
      width = decoded.width;
      height = decoded.height;
      release = decoded.release;
    } catch {
      const isHeic =
        /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      if (isHeic) return file;
      throw new Error("El navegador no ha podido leer esta imagen.");
    }
  }

  try {
    if (!width || !height) {
      throw new Error("La imagen no tiene unas dimensiones válidas.");
    }

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("No se pudo preparar la imagen.");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, outputWidth, outputHeight);

    let blob = await canvasBlob(canvas, "image/webp", WEBP_QUALITY);
    if (blob.type !== "image/webp") {
      blob = await canvasBlob(canvas, "image/jpeg", 0.9);
    }

    const baseName = file.name.replace(/\.[^.]+$/, "") || "foto";
    const extension = blob.type === "image/webp" ? "webp" : "jpg";
    return new File([blob], `${baseName}.${extension}`, {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } finally {
    release();
  }
}

function waitForVideo(
  video: HTMLVideoElement,
  eventName: "loadeddata" | "seeked",
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("No se pudo crear una vista previa del vídeo."));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("El navegador no puede leer este vídeo."));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

export async function createVideoPoster(file: File): Promise<File | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;

  try {
    await waitForVideo(video, "loadeddata", 12_000);
    if (Number.isFinite(video.duration) && video.duration > 0.15) {
      video.currentTime = Math.min(0.2, video.duration / 4);
      await waitForVideo(video, "seeked", 8_000).catch(() => undefined);
    }
    if (!video.videoWidth || !video.videoHeight) return null;

    const scale = Math.min(
      1,
      MAX_POSTER_EDGE / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = await canvasBlob(canvas, "image/webp", 0.82);
    return new File([poster], "poster.webp", { type: "image/webp" });
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
