const MAX_FILE_SIZE = 20 * 1024 * 1024;
const PHOTO_PREFIX = "photos/";
const HASH_PREFIX = "hashes/";
const MAX_TIMESTAMP = 9_999_999_999_999;

type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

interface R2HttpMetadata {
  contentType?: string;
}

interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: {
      httpMetadata?: R2HttpMetadata;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object>;
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
    include?: Array<"httpMetadata" | "customMetadata">;
  }): Promise<R2Objects>;
  delete(keys: string | string[]): Promise<void>;
}

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  PHOTOS: R2Bucket;
  ASSETS: AssetsBinding;
  UPLOAD_RATE_LIMITER: RateLimitBinding;
  ADMIN_PASSWORD: string;
}

interface HtmlElement {
  setAttribute(name: string, value: string): void;
}

declare class HTMLRewriter {
  on(
    selector: string,
    handlers: { element(element: HtmlElement): void },
  ): HTMLRewriter;
  transform(response: Response): Response;
}

interface PhotoRecord {
  id: string;
  key: string;
  uploadedAt: string;
  size: number;
  type: string;
  url: string;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { ...init, headers });
}

function photoRecord(object: R2Object): PhotoRecord {
  return {
    id: object.customMetadata?.id ?? object.key,
    key: object.key,
    uploadedAt: object.uploaded.toISOString(),
    size: object.size,
    type: object.httpMetadata?.contentType ?? "image/jpeg",
    url: `/api/photo?key=${encodeURIComponent(object.key)}`,
  };
}

function bytesEqual(
  bytes: Uint8Array,
  offset: number,
  expected: number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function detectImageType(buffer: ArrayBuffer): ImageType | null {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 24));

  if (bytes.length >= 3 && bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (
      ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(
        brand,
      )
    ) {
      return "image/heic";
    }
  }

  return null;
}

function extensionFor(type: ImageType): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "heic";
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function uploadKey(id: string, extension: string): string {
  const reverseTimestamp = String(MAX_TIMESTAMP - Date.now()).padStart(13, "0");
  return `${PHOTO_PREFIX}${reverseTimestamp}-${id}.${extension}`;
}

async function listPhotos(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 60)
    : 24;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const result = await env.PHOTOS.list({
    prefix: PHOTO_PREFIX,
    limit,
    cursor,
    include: ["httpMetadata", "customMetadata"],
  });

  return json({
    photos: result.objects.map(photoRecord),
    cursor: result.truncated ? result.cursor : null,
  });
}

async function existingPhotoForHash(
  hash: string,
  env: Env,
): Promise<PhotoRecord | null> {
  const marker = await env.PHOTOS.get(`${HASH_PREFIX}${hash}`);
  if (!marker) return null;

  const key = await new Response(marker.body).text();
  if (!key.startsWith(PHOTO_PREFIX)) return null;

  const photo = await env.PHOTOS.head(key);
  return photo ? photoRecord(photo) : null;
}

async function uploadPhoto(request: Request, env: Env): Promise<Response> {
  const requestLength = Number(request.headers.get("content-length") ?? "0");
  if (requestLength > MAX_FILE_SIZE + 1024 * 1024) {
    return json(
      { error: "La fotografía supera el límite de 20 MB." },
      { status: 413 },
    );
  }

  const rateKey =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "anonymous";
  const rate = await env.UPLOAD_RATE_LIMITER.limit({ key: rateKey });
  if (!rate.success) {
    return json(
      {
        error:
          "Se han enviado demasiadas fotografías seguidas. Espera un minuto e inténtalo de nuevo.",
      },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "La solicitud de subida no es válida." }, { status: 415 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "No se pudo leer la fotografía." }, { status: 400 });
  }

  const files = formData
    .getAll("photo")
    .filter((entry): entry is File => entry instanceof File);

  if (files.length !== 1) {
    return json(
      { error: "Envía una fotografía cada vez." },
      { status: 400 },
    );
  }

  const file = files[0];
  if (file.size === 0 || file.size > MAX_FILE_SIZE) {
    return json(
      { error: "Cada fotografía debe ocupar entre 1 byte y 20 MB." },
      { status: 413 },
    );
  }

  const allowedDeclaredTypes = new Set([
    "",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]);
  if (!allowedDeclaredTypes.has(file.type.toLowerCase())) {
    return json(
      { error: "Solo se aceptan imágenes JPG, PNG, WebP o HEIC compatibles." },
      { status: 415 },
    );
  }

  const buffer = await file.arrayBuffer();
  const detectedType = detectImageType(buffer);
  if (!detectedType) {
    return json(
      { error: "El contenido del archivo no es una imagen permitida." },
      { status: 415 },
    );
  }

  const hash = await sha256Hex(buffer);
  const duplicate = await existingPhotoForHash(hash, env);
  if (duplicate) {
    return json({ photo: duplicate, duplicate: true });
  }

  const id = crypto.randomUUID();
  const key = uploadKey(id, extensionFor(detectedType));
  const stored = await env.PHOTOS.put(key, buffer, {
    httpMetadata: { contentType: detectedType },
    customMetadata: { id, sha256: hash },
  });

  await env.PHOTOS.put(`${HASH_PREFIX}${hash}`, key, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  return json(
    {
      photo: photoRecord({
        ...stored,
        key,
        size: file.size,
        uploaded: stored.uploaded ?? new Date(),
        httpMetadata: { contentType: detectedType },
        customMetadata: { id, sha256: hash },
      }),
      duplicate: false,
    },
    { status: 201 },
  );
}

async function servePhoto(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!key?.startsWith(PHOTO_PREFIX) || key.includes("..")) {
    return json({ error: "Fotografía no válida." }, { status: 400 });
  }

  const object = await env.PHOTOS.get(key);
  if (!object) {
    return json({ error: "Fotografía no encontrada." }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.etag,
      "x-content-type-options": "nosniff",
    },
  });
}

function decodeBasicCredentials(header: string | null): {
  username: string;
  password: string;
} | null {
  if (!header?.startsWith("Basic ")) return null;

  try {
    const binary = atob(header.slice(6));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function isAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  const credentials = decodeBasicCredentials(request.headers.get("authorization"));
  return Boolean(
    credentials &&
      constantTimeEqual(credentials.username, "admin") &&
      constantTimeEqual(credentials.password, env.ADMIN_PASSWORD),
  );
}

function adminChallenge(): Response {
  return new Response("Se necesita la contraseña de administración.", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="Santi & Claudia", charset="UTF-8"',
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function deletePhoto(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!key?.startsWith(PHOTO_PREFIX) || key.includes("..")) {
    return json({ error: "Fotografía no válida." }, { status: 400 });
  }

  const object = await env.PHOTOS.head(key);
  if (!object) {
    return json({ error: "Fotografía no encontrada." }, { status: 404 });
  }

  const keysToDelete = [key];
  const hash = object.customMetadata?.sha256;
  if (hash) keysToDelete.push(`${HASH_PREFIX}${hash}`);

  await env.PHOTOS.delete(keysToDelete);
  return json({ deleted: true });
}

async function serveHome(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const origin = new URL(request.url).origin;

  return new HTMLRewriter()
    .on('meta[property="og:image"]', {
      element(element) {
        element.setAttribute("content", `${origin}/og.png`);
      },
    })
    .on('meta[name="twitter:image"]', {
      element(element) {
        element.setAttribute("content", `${origin}/og.png`);
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        element.setAttribute("content", `${origin}/`);
      },
    })
    .transform(response);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/photos") {
        return listPhotos(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/photos") {
        return uploadPhoto(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/photo") {
        return servePhoto(request, env);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAdmin(request, env)) return adminChallenge();

        if (request.method === "GET" && url.pathname === "/api/admin/photos") {
          return listPhotos(request, env);
        }

        if (request.method === "DELETE" && url.pathname === "/api/admin/photos") {
          return deletePhoto(request, env);
        }

        return json({ error: "Ruta no encontrada." }, { status: 404 });
      }

      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (!isAdmin(request, env)) return adminChallenge();
        return env.ASSETS.fetch(request);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return serveHome(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Unhandled request error", error);
      return json(
        { error: "Ha ocurrido un error inesperado. Inténtalo de nuevo." },
        { status: 500 },
      );
    }
  },
};
