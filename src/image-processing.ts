const MAX_EDGE = 2000;
const WEBP_QUALITY = 0.86;

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const allowedExtensions = /\.(jpe?g|png|webp|heic|heif)$/i;

export function isAcceptedImage(file: File): boolean {
  return file.type
    ? allowedMimeTypes.has(file.type.toLowerCase())
    : allowedExtensions.test(file.name);
}

export async function fileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
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
        else reject(new Error("El navegador no pudo comprimir la imagen."));
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
      const isHeic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      throw new Error(
        isHeic
          ? "Este navegador no puede convertir esta fotografía HEIC. Prueba desde la galería de otro dispositivo o conviértela a JPG."
          : "El navegador no ha podido leer esta imagen.",
      );
    }
  }

  try {
    if (!width || !height) {
      throw new Error("La imagen no tiene unas dimensiones válidas.");
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("No se pudo preparar la compresión.");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, outputWidth, outputHeight);

    let blob = await canvasBlob(canvas, "image/webp", WEBP_QUALITY);
    if (blob.type !== "image/webp") {
      blob = await canvasBlob(canvas, "image/jpeg", 0.88);
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
