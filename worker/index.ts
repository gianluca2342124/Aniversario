const MEDIA_PREFIX = "photos/";
const POSTER_PREFIX = "posters/";
const HASH_PREFIX = "hashes/";
const MAX_TIMESTAMP = 9_999_999_999_999;
const MIN_PART_SIZE = 8 * 1024 * 1024;
const MAX_PART_SIZE_FOR_FREE_WORKER = 90 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 10_000;
const UPLOAD_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

type MediaKind = "image" | "video";
type AllowedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm";

interface R2HttpMetadata {
  contentType?: string;
}

interface R2Range {
  offset: number;
  length: number;
}

interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  httpEtag?: string;
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

interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Blob,
  ): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
  abort(): Promise<void>;
}

interface R2Bucket {
  get(
    key: string,
    options?: { range?: R2Range },
  ): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | string | Blob,
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
  createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: R2HttpMetadata;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
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

interface MediaRecord {
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

interface CreateUploadBody {
  name?: unknown;
  type?: unknown;
  size?: unknown;
  kind?: unknown;
  signature?: unknown;
  fingerprint?: unknown;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { ...init, headers });
}

function mediaKindFor(object: R2Object): MediaKind {
  const storedKind = object.customMetadata?.kind;
  if (storedKind === "video") return "video";
  if (storedKind === "image") return "image";
  return object.httpMetadata?.contentType?.startsWith("video/")
    ? "video"
    : "image";
}

function mediaRecord(object: R2Object): MediaRecord {
  const kind = mediaKindFor(object);
  const posterKey =
    kind === "video" ? object.customMetadata?.posterKey : undefined;

  return {
    id: object.customMetadata?.id ?? object.key,
    key: object.key,
    uploadedAt: object.uploaded.toISOString(),
    size: object.size,
    type:
      object.httpMetadata?.contentType ??
      (kind === "video" ? "video/mp4" : "image/jpeg"),
    kind,
    url: `/api/media/file?key=${encodeURIComponent(object.key)}`,
    ...(posterKey
      ? {
          posterKey,
          posterUrl: `/api/media/file?key=${encodeURIComponent(posterKey)}`,
        }
      : {}),
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

function detectMediaType(bytes: Uint8Array): AllowedMediaType | null {
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
  if (
    bytes.length >= 4 &&
    bytesEqual(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])
  ) {
    return "video/webm";
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brands: string[] = [];
    for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
      brands.push(ascii(bytes, offset, offset + 4));
    }
    if (
      brands.some((brand) =>
        [
          "heic",
          "heix",
          "hevc",
          "hevx",
          "heim",
          "heis",
          "mif1",
          "msf1",
        ].includes(brand),
      )
    ) {
      return brands.includes("mif1") || brands.includes("msf1")
        ? "image/heif"
        : "image/heic";
    }
    if (brands.includes("qt  ")) return "video/quicktime";
    if (
      brands.some(
        (brand) =>
          /^(iso|mp4|M4V|avc)/.test(brand) ||
          ["MSNV", "3gp4", "3gp5"].includes(brand),
      )
    ) {
      return "video/mp4";
    }
  }
  return null;
}

function normalizeDeclaredType(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "video/x-m4v") return "video/mp4";
  return normalized;
}

function typesAreCompatible(
  declaredType: string,
  detectedType: AllowedMediaType,
  kind: MediaKind,
): boolean {
  if (kind === "image" && !detectedType.startsWith("image/")) return false;
  if (kind === "video" && !detectedType.startsWith("video/")) return false;
  if (declaredType === detectedType) return true;
  if (
    [declaredType, detectedType].every((type) =>
      ["image/heic", "image/heif"].includes(type),
    )
  ) {
    return true;
  }
  return (
    kind === "video" &&
    ["video/mp4", "video/quicktime"].includes(declaredType) &&
    ["video/mp4", "video/quicktime"].includes(detectedType)
  );
}

function extensionFor(type: AllowedMediaType): string {
  const extensions: Record<AllowedMediaType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return extensions[type];
}

function uploadKey(id: string, extension: string): string {
  const reverseTimestamp = String(MAX_TIMESTAMP - Date.now()).padStart(13, "0");
  return `${MEDIA_PREFIX}${reverseTimestamp}-${id}.${extension}`;
}

function isMediaKey(key: string | null): key is string {
  return Boolean(key?.startsWith(MEDIA_PREFIX) && !key.includes(".."));
}

function isReadableKey(key: string | null): key is string {
  return Boolean(
    key &&
      !key.includes("..") &&
      (key.startsWith(MEDIA_PREFIX) || key.startsWith(POSTER_PREFIX)),
  );
}

function choosePartSize(size: number): number | null {
  const required = Math.ceil(size / (MAX_MULTIPART_PARTS - 1));
  const mebibyte = 1024 * 1024;
  const partSize =
    Math.ceil(Math.max(MIN_PART_SIZE, required) / mebibyte) * mebibyte;
  return partSize <= MAX_PART_SIZE_FOR_FREE_WORKER ? partSize : null;
}

function decodeBase64(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return decodeBase64(padded);
  } catch {
    return null;
  }
}

async function uploadTokenKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createUploadToken(env: Env): Promise<{
  token: string;
  expiresAt: string;
}> {
  const expiresAt = Date.now() + UPLOAD_TOKEN_LIFETIME_MS;
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ id: crypto.randomUUID(), exp: expiresAt }),
    ),
  );
  const key = await uploadTokenKey(env.ADMIN_PASSWORD);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return {
    token: `${payload}.${toBase64Url(signature)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function validUploadToken(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("x-upload-token");
  if (!token || !env.ADMIN_PASSWORD) return false;
  const [payload, encodedSignature, ...extra] = token.split(".");
  if (!payload || !encodedSignature || extra.length > 0) return false;
  const payloadBytes = fromBase64Url(payload);
  const signature = fromBase64Url(encodedSignature);
  if (!payloadBytes || !signature) return false;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      exp?: unknown;
    };
    if (
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp) ||
      parsed.exp < Date.now()
    ) {
      return false;
    }
    const key = await uploadTokenKey(env.ADMIN_PASSWORD);
    const signatureBuffer = Uint8Array.from(signature).buffer;
    return crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuffer,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

async function requireUploadToken(
  request: Request,
  env: Env,
): Promise<Response | null> {
  return (await validUploadToken(request, env))
    ? null
    : json({ error: "La sesión de subida no es válida o ha caducado." }, { status: 401 });
}

async function listMedia(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 60)
    : 24;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const result = await env.PHOTOS.list({
    prefix: MEDIA_PREFIX,
    limit,
    cursor,
    include: ["httpMetadata", "customMetadata"],
  });
  const media = result.objects.map(mediaRecord);

  return json({
    media,
    photos: media,
    cursor: result.truncated ? result.cursor : null,
  });
}

async function existingMediaForFingerprint(
  fingerprint: string,
  env: Env,
): Promise<MediaRecord | null> {
  const marker = await env.PHOTOS.get(`${HASH_PREFIX}${fingerprint}`);
  if (!marker) return null;

  const key = await new Response(marker.body).text();
  if (!isMediaKey(key)) return null;

  const object = await env.PHOTOS.head(key);
  return object ? mediaRecord(object) : null;
}

async function startUploadSession(request: Request, env: Env): Promise<Response> {
  const rateKey =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "anonymous";
  const rate = await env.UPLOAD_RATE_LIMITER.limit({ key: rateKey });
  if (!rate.success) {
    return json(
      {
        error:
          "Se han iniciado demasiadas subidas seguidas. Espera un minuto e inténtalo de nuevo.",
      },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "Falta configurar el secreto del Worker." }, { status: 500 });
  }
  return json(await createUploadToken(env), { status: 201 });
}

async function createUpload(request: Request, env: Env): Promise<Response> {
  const authError = await requireUploadToken(request, env);
  if (authError) return authError;

  let body: CreateUploadBody;
  try {
    body = (await request.json()) as CreateUploadBody;
  } catch {
    return json({ error: "No se pudo leer la información del archivo." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : "";
  const declaredType =
    typeof body.type === "string" ? normalizeDeclaredType(body.type) : "";
  const size = typeof body.size === "number" ? body.size : Number.NaN;
  const kind =
    body.kind === "image" || body.kind === "video" ? body.kind : null;
  const fingerprint =
    typeof body.fingerprint === "string" ? body.fingerprint.toLowerCase() : "";
  const signature =
    typeof body.signature === "string" ? decodeBase64(body.signature) : null;

  if (
    !kind ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    !signature
  ) {
    return json({ error: "La información del archivo no es válida." }, { status: 400 });
  }

  const allowedDeclaredTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ]);
  if (!allowedDeclaredTypes.has(declaredType)) {
    return json(
      { error: "El tipo de imagen o vídeo no está permitido." },
      { status: 415 },
    );
  }

  const detectedType = detectMediaType(signature);
  if (!detectedType || !typesAreCompatible(declaredType, detectedType, kind)) {
    return json(
      { error: "El contenido no coincide con un formato multimedia permitido." },
      { status: 415 },
    );
  }

  const partSize = choosePartSize(size);
  if (!partSize) {
    return json(
      {
        error:
          "El archivo supera el alcance técnico de las subidas multipart a través de un Worker gratuito.",
      },
      { status: 413 },
    );
  }

  const duplicate = await existingMediaForFingerprint(fingerprint, env);
  if (duplicate) {
    return json({ duplicate: true, media: duplicate });
  }

  const id = crypto.randomUUID();
  const key = uploadKey(id, extensionFor(detectedType));
  const posterKey = kind === "video" ? `${POSTER_PREFIX}${id}.webp` : undefined;
  const multipart = await env.PHOTOS.createMultipartUpload(key, {
    httpMetadata: { contentType: detectedType },
    customMetadata: {
      id,
      kind,
      fingerprint,
      expectedSize: String(size),
      originalName: encodeURIComponent(name.slice(0, 180)),
      ...(posterKey ? { posterKey } : {}),
    },
  });

  return json(
    {
      duplicate: false,
      upload: {
        key,
        uploadId: multipart.uploadId,
        id,
        partSize,
      },
    },
    { status: 201 },
  );
}

async function uploadPart(request: Request, env: Env): Promise<Response> {
  const authError = await requireUploadToken(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number.parseInt(url.searchParams.get("partNumber") ?? "", 10);

  if (
    !isMediaKey(key) ||
    !uploadId ||
    uploadId.length > 1024 ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > MAX_MULTIPART_PARTS ||
    !request.body
  ) {
    return json({ error: "La parte de subida no es válida." }, { status: 400 });
  }

  try {
    const multipart = env.PHOTOS.resumeMultipartUpload(key, uploadId);
    const part = await multipart.uploadPart(partNumber, request.body);
    return json(part);
  } catch {
    return json(
      { error: "No se pudo guardar esta parte. Se puede reintentar." },
      { status: 409 },
    );
  }
}

async function completeUpload(request: Request, env: Env): Promise<Response> {
  const authError = await requireUploadToken(request, env);
  if (authError) return authError;

  let body: {
    key?: unknown;
    uploadId?: unknown;
    parts?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "No se pudo finalizar la subida." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key : null;
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const parts = Array.isArray(body.parts)
    ? body.parts.filter(
        (part): part is R2UploadedPart =>
          typeof part === "object" &&
          part !== null &&
          Number.isInteger((part as R2UploadedPart).partNumber) &&
          (part as R2UploadedPart).partNumber > 0 &&
          typeof (part as R2UploadedPart).etag === "string",
      )
    : [];

  if (
    !isMediaKey(key) ||
    !uploadId ||
    parts.length === 0 ||
    parts.length !== (Array.isArray(body.parts) ? body.parts.length : 0)
  ) {
    return json({ error: "Los datos para completar la subida no son válidos." }, { status: 400 });
  }
  parts.sort((left, right) => left.partNumber - right.partNumber);
  if (parts.some((part, index) => part.partNumber !== index + 1)) {
    return json({ error: "Faltan partes del archivo." }, { status: 400 });
  }

  try {
    const multipart = env.PHOTOS.resumeMultipartUpload(key, uploadId);
    await multipart.complete(parts);
    const object = await env.PHOTOS.head(key);
    if (!object) throw new Error("missing-object");

    const expectedSize = Number(object.customMetadata?.expectedSize);
    if (!Number.isSafeInteger(expectedSize) || expectedSize !== object.size) {
      await env.PHOTOS.delete(key);
      return json(
        { error: "El archivo recibido está incompleto y se ha descartado." },
        { status: 422 },
      );
    }

    const fingerprint = object.customMetadata?.fingerprint;
    if (fingerprint) {
      const existing = await existingMediaForFingerprint(fingerprint, env);
      if (existing && existing.key !== key) {
        await env.PHOTOS.delete(key);
        return json({ duplicate: true, media: existing });
      }
      await env.PHOTOS.put(`${HASH_PREFIX}${fingerprint}`, key, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    }

    return json(
      { duplicate: false, media: mediaRecord(object) },
      { status: 201 },
    );
  } catch {
    return json(
      { error: "No se pudo completar la subida. Intenta reanudarla." },
      { status: 409 },
    );
  }
}

async function abortUpload(request: Request, env: Env): Promise<Response> {
  const authError = await requireUploadToken(request, env);
  if (authError) return authError;

  let body: { key?: unknown; uploadId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "No se pudo cancelar la subida." }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : null;
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  if (!isMediaKey(key) || !uploadId) {
    return json({ error: "La subida no es válida." }, { status: 400 });
  }

  try {
    await env.PHOTOS.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    // It may already be completed, aborted, or expired.
  }
  return json({ aborted: true });
}

async function savePoster(request: Request, env: Env): Promise<Response> {
  const authError = await requireUploadToken(request, env);
  if (authError) return authError;

  const mediaKey = request.headers.get("x-media-key");
  if (!isMediaKey(mediaKey)) {
    return json({ error: "El vídeo asociado no es válido." }, { status: 400 });
  }
  const media = await env.PHOTOS.head(mediaKey);
  if (!media || mediaKindFor(media) !== "video") {
    return json({ error: "No se ha encontrado el vídeo asociado." }, { status: 404 });
  }

  const buffer = await request.arrayBuffer();
  const detectedType = detectMediaType(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64)),
  );
  if (
    !detectedType ||
    !["image/jpeg", "image/png", "image/webp"].includes(detectedType)
  ) {
    return json({ error: "La vista previa no es una imagen válida." }, { status: 415 });
  }

  const posterKey =
    media.customMetadata?.posterKey ??
    `${POSTER_PREFIX}${media.customMetadata?.id ?? crypto.randomUUID()}.webp`;
  await env.PHOTOS.put(posterKey, buffer, {
    httpMetadata: { contentType: detectedType },
    customMetadata: { parentKey: mediaKey },
  });
  return json({ saved: true }, { status: 201 });
}

function parseRange(
  rangeHeader: string,
  size: number,
): R2Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";

  if (!startText) {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number.parseInt(startText, 10);
  const requestedEnd = endText ? Number.parseInt(endText, 10) : size - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

async function serveMediaFile(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!isReadableKey(key)) {
    return json({ error: "Archivo multimedia no válido." }, { status: 400 });
  }

  const head = await env.PHOTOS.head(key);
  if (!head) {
    return json({ error: "Archivo multimedia no encontrado." }, { status: 404 });
  }

  const headers = new Headers({
    "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(head.size),
    "cache-control": "public, max-age=31536000, immutable",
    etag: head.httpEtag ?? `"${head.etag}"`,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") return new Response(null, { headers });

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, head.size);
    if (!range) {
      headers.set("content-range", `bytes */${head.size}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    const object = await env.PHOTOS.get(key, { range });
    if (!object) {
      return json({ error: "Archivo multimedia no encontrado." }, { status: 404 });
    }
    headers.set("content-length", String(range.length));
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
    return new Response(object.body, { status: 206, headers });
  }

  const object = await env.PHOTOS.get(key);
  if (!object) {
    return json({ error: "Archivo multimedia no encontrado." }, { status: 404 });
  }
  return new Response(object.body, { headers });
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

async function deleteMedia(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!isMediaKey(key)) {
    return json({ error: "Recuerdo no válido." }, { status: 400 });
  }

  const object = await env.PHOTOS.head(key);
  if (!object) {
    return json({ error: "Recuerdo no encontrado." }, { status: 404 });
  }

  const keysToDelete = [key];
  const fingerprint =
    object.customMetadata?.fingerprint ?? object.customMetadata?.sha256;
  if (fingerprint) keysToDelete.push(`${HASH_PREFIX}${fingerprint}`);
  const posterKey = object.customMetadata?.posterKey;
  if (posterKey?.startsWith(POSTER_PREFIX)) keysToDelete.push(posterKey);

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
      if (
        request.method === "GET" &&
        (url.pathname === "/api/media" || url.pathname === "/api/photos")
      ) {
        return listMedia(request, env);
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/api/media/file" || url.pathname === "/api/photo")
      ) {
        return serveMediaFile(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/uploads/session") {
        return startUploadSession(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/uploads/create") {
        return createUpload(request, env);
      }
      if (request.method === "PUT" && url.pathname === "/api/uploads/part") {
        return uploadPart(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/uploads/complete") {
        return completeUpload(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/uploads/abort") {
        return abortUpload(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/uploads/poster") {
        return savePoster(request, env);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAdmin(request, env)) return adminChallenge();

        if (
          request.method === "GET" &&
          (url.pathname === "/api/admin/media" ||
            url.pathname === "/api/admin/photos")
        ) {
          return listMedia(request, env);
        }
        if (
          request.method === "DELETE" &&
          (url.pathname === "/api/admin/media" ||
            url.pathname === "/api/admin/photos")
        ) {
          return deleteMedia(request, env);
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
