import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  createUploadSession,
  deleteMedia,
  getMedia,
  uploadPart,
  uploadPoster,
} from "./api";
import {
  compressImage,
  createVideoPoster,
  fileFingerprint,
  fileSignature,
  isAcceptedMedia,
  mediaKind,
  normalizedMimeType,
} from "./image-processing";
import type {
  MediaItem,
  MultipartUploadDetails,
  UploadedPart,
} from "./types";

const FILE_CONCURRENCY = 2;
const PART_RETRIES = 3;

type UploadStatus =
  | "pending"
  | "preparing"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled";

interface UploadJob {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  error?: string;
}

interface ActiveUpload extends MultipartUploadDetails {
  token: string;
}

const statusLabels: Record<UploadStatus, string> = {
  pending: "Pendiente",
  preparing: "Preparando",
  uploading: "Subiendo",
  completed: "Completado",
  failed: "Fallido",
  cancelled: "Cancelado",
};

function mergeMedia(current: MediaItem[], incoming: MediaItem[]): MediaItem[] {
  const media = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => media.set(item.id, item));
  return Array.from(media.values()).sort(
    (left, right) =>
      new Date(right.uploadedAt).getTime() - new Date(left.uploadedAt).getTime(),
  );
}

function Header({ admin = false }: { admin?: boolean }) {
  return (
    <header className="hero">
      <span className="hero-kicker" aria-hidden="true">
        S · C
      </span>
      <h1>
        Santi <span aria-hidden="true">&amp;</span>
        <span className="sr-only">y</span> Claudia
      </h1>
      {admin ? (
        <p className="hero-subtitle">Administración de recuerdos</p>
      ) : (
        <div className="hero-subtitle">
          <p>Un día para recordar</p>
          <p lang="it">Un giorno da ricordare</p>
        </div>
      )}
      <span className="hero-rule" aria-hidden="true" />
    </header>
  );
}

interface UploadZoneProps {
  onUploaded: (media: MediaItem[]) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatProgress(progress: number): string {
  return `${Math.round(Math.min(100, Math.max(0, progress)))}%`;
}

function UploadZone({ onUploaded }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const activeUploadsRef = useRef(new Map<string, ActiveUpload>());
  const cancelledRef = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [message, setMessage] = useState("");

  const updateJob = useCallback(
    (id: string, patch: Partial<Omit<UploadJob, "id" | "file">>) => {
      setJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      );
    },
    [],
  );

  const chooseFiles = () => {
    if (!busy) inputRef.current?.click();
  };

  const uploadChunkWithRetries = async (
    job: UploadJob,
    upload: ActiveUpload,
    partNumber: number,
    chunk: Blob,
    uploadedBytes: number,
    totalBytes: number,
    controller: AbortController,
  ): Promise<UploadedPart> => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
      try {
        return await uploadPart(
          upload,
          partNumber,
          chunk,
          upload.token,
          controller.signal,
          (loaded) => {
            updateJob(job.id, {
              progress: ((uploadedBytes + loaded) / totalBytes) * 100,
            });
          },
        );
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) throw error;
        lastError = error;
        if (attempt < PART_RETRIES) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, 450 * 2 ** (attempt - 1)),
          );
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("No se pudo subir una parte del archivo.");
  };

  const uploadOne = useCallback(
    async (job: UploadJob, token: string) => {
      if (cancelledRef.current.has(job.id)) return;

      const controller = new AbortController();
      controllersRef.current.set(job.id, controller);
      updateJob(job.id, {
        status: "preparing",
        progress: 0,
        error: undefined,
      });

      let activeUpload: ActiveUpload | undefined;

      try {
        const kind = mediaKind(job.file);
        const preparedFile =
          kind === "image" ? await compressImage(job.file) : job.file;
        if (controller.signal.aborted) {
          throw new DOMException("La subida se canceló.", "AbortError");
        }

        const posterPromise =
          kind === "video"
            ? createVideoPoster(job.file)
            : Promise.resolve<File | null>(null);
        const [fingerprint, signature, poster] = await Promise.all([
          fileFingerprint(preparedFile),
          fileSignature(preparedFile),
          posterPromise,
        ]);

        const created = await createMultipartUpload(
          {
            name: job.file.name,
            type: normalizedMimeType(preparedFile),
            size: preparedFile.size,
            kind,
            signature,
            fingerprint,
          },
          token,
        );

        if (created.duplicate && created.media) {
          updateJob(job.id, { status: "completed", progress: 100 });
          onUploaded([created.media]);
          return;
        }
        if (!created.upload) {
          throw new Error("No se pudo iniciar la subida.");
        }

        activeUpload = { ...created.upload, token };
        activeUploadsRef.current.set(job.id, activeUpload);
        updateJob(job.id, { status: "uploading", progress: 0 });

        const uploadedParts: UploadedPart[] = [];
        let uploadedBytes = 0;
        let partNumber = 1;

        for (
          let offset = 0;
          offset < preparedFile.size;
          offset += activeUpload.partSize
        ) {
          if (controller.signal.aborted) {
            throw new DOMException("La subida se canceló.", "AbortError");
          }
          const chunk = preparedFile.slice(
            offset,
            Math.min(offset + activeUpload.partSize, preparedFile.size),
          );
          const part = await uploadChunkWithRetries(
            job,
            activeUpload,
            partNumber,
            chunk,
            uploadedBytes,
            preparedFile.size,
            controller,
          );
          uploadedParts.push(part);
          uploadedBytes += chunk.size;
          updateJob(job.id, {
            progress: (uploadedBytes / preparedFile.size) * 100,
          });
          partNumber += 1;
        }

        const completed = await completeMultipartUpload(
          {
            key: activeUpload.key,
            uploadId: activeUpload.uploadId,
            parts: uploadedParts,
          },
          token,
        );
        activeUploadsRef.current.delete(job.id);

        if (poster && completed.media.kind === "video") {
          await uploadPoster(completed.media.key, poster, token).catch(() => {
            // The video remains usable with the elegant fallback thumbnail.
          });
        }

        updateJob(job.id, { status: "completed", progress: 100 });
        onUploaded([completed.media]);
      } catch (error) {
        if (activeUpload) {
          await abortMultipartUpload(
            activeUpload.key,
            activeUpload.uploadId,
            activeUpload.token,
          ).catch(() => {
            // R2 also aborts abandoned multipart uploads automatically.
          });
          activeUploadsRef.current.delete(job.id);
        }

        if (isAbortError(error) || controller.signal.aborted) {
          updateJob(job.id, {
            status: "cancelled",
            error: "Subida cancelada.",
          });
        } else {
          updateJob(job.id, {
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "No se pudo subir el archivo.",
          });
        }
      } finally {
        controllersRef.current.delete(job.id);
      }
    },
    [onUploaded, updateJob],
  );

  const runQueue = useCallback(
    async (queue: UploadJob[], token: string) => {
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(FILE_CONCURRENCY, queue.length) },
        async () => {
          while (nextIndex < queue.length) {
            const job = queue[nextIndex];
            nextIndex += 1;
            if (job && !cancelledRef.current.has(job.id)) {
              await uploadOne(job, token);
            }
          }
        },
      );
      await Promise.all(workers);
    },
    [uploadOne],
  );

  const processFiles = async (selection: File[]) => {
    if (selection.length === 0) return;

    setMessage("");
    cancelledRef.current.clear();
    const nextJobs = selection.map<UploadJob>((file) => ({
      id: crypto.randomUUID(),
      file,
      status:
        file.size > 0 && isAcceptedMedia(file) ? "pending" : "failed",
      progress: 0,
      error:
        file.size === 0
          ? "El archivo está vacío."
          : isAcceptedMedia(file)
            ? undefined
            : "El formato no es una imagen o un vídeo compatible.",
    }));
    setJobs(nextJobs);

    const queue = nextJobs.filter((job) => job.status === "pending");
    if (queue.length === 0) return;

    setBusy(true);
    setMessage("Preparando tus recuerdos…");
    try {
      const session = await createUploadSession();
      await runQueue(queue, session.token);
      setMessage("Proceso terminado. Tus recuerdos ya están en la galería.");
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : "No se pudo iniciar la subida.";
      queue.forEach((job) => {
        updateJob(job.id, { status: "failed", error: description });
      });
      setMessage("No se ha podido iniciar la subida.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const retryJob = async (job: UploadJob) => {
    cancelledRef.current.delete(job.id);
    setBusy(true);
    setMessage("Reintentando el archivo…");
    try {
      const session = await createUploadSession();
      await uploadOne(job, session.token);
      setMessage("Reintento terminado.");
    } catch (error) {
      updateJob(job.id, {
        status: "failed",
        error:
          error instanceof Error ? error.message : "No se pudo reintentar.",
      });
    } finally {
      setBusy(false);
    }
  };

  const cancelJob = (job: UploadJob) => {
    cancelledRef.current.add(job.id);
    const controller = controllersRef.current.get(job.id);
    controller?.abort();
    if (!controller) {
      updateJob(job.id, {
        status: "cancelled",
        error: "Subida cancelada.",
      });
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    void processFiles(Array.from(event.target.files ?? []));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) void processFiles(Array.from(event.dataTransfer.files));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseFiles();
    }
  };

  const globalProgress = useMemo(() => {
    if (jobs.length === 0) return 0;
    const total = jobs.reduce((sum, job) => {
      if (job.status === "completed") return sum + 100;
      if (job.status === "failed" || job.status === "cancelled") {
        return sum + job.progress;
      }
      return sum + job.progress;
    }, 0);
    return total / jobs.length;
  }, [jobs]);

  return (
    <section className="upload-section" aria-labelledby="share-title">
      <div className="section-heading">
        <p className="section-eyebrow">Comparte tus recuerdos de este día</p>
        <h2 id="share-title">Sube tus fotos y vídeos</h2>
        <p lang="it">Carica le tue foto e i tuoi video</p>
      </div>

      <div
        className={`drop-zone${dragging ? " is-dragging" : ""}${
          busy ? " is-busy" : ""
        }`}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        onClick={chooseFiles}
        onKeyDown={onKeyDown}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/x-m4v,video/webm,.heic,.heif,.mov,.m4v"
          multiple
          onChange={onInputChange}
          disabled={busy}
          tabIndex={-1}
        />
        <span className="upload-mark" aria-hidden="true">
          <span />
        </span>
        <span className="upload-button-text">
          Sube tus fotos y vídeos <span aria-hidden="true">·</span>{" "}
          <span lang="it">Carica le tue foto e i tuoi video</span>
        </span>
        <span className="upload-hint">
          Pulsa para elegir o arrastra tus archivos aquí
        </span>
      </div>

      {jobs.length > 0 && (
        <div className="upload-queue" aria-live="polite">
          <div className="queue-summary">
            <span>Progreso de la selección</span>
            <strong>{formatProgress(globalProgress)}</strong>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Progreso total de la selección"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(globalProgress)}
          >
            <span style={{ width: formatProgress(globalProgress) }} />
          </div>

          <div className="queue-list">
            {jobs.map((job) => (
              <article className={`queue-item is-${job.status}`} key={job.id}>
                <div className="queue-item-main">
                  <span className="queue-kind" aria-hidden="true">
                    {mediaKind(job.file) === "video" ? "▶" : "◇"}
                  </span>
                  <div className="queue-copy">
                    <strong>{job.file.name}</strong>
                    <span>
                      {statusLabels[job.status]} · {formatProgress(job.progress)}
                    </span>
                    {job.error && <small>{job.error}</small>}
                  </div>
                </div>
                <div className="queue-actions">
                  {(job.status === "pending" ||
                    job.status === "preparing" ||
                    job.status === "uploading") && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        cancelJob(job);
                      }}
                    >
                      Cancelar
                    </button>
                  )}
                  {(job.status === "failed" ||
                    job.status === "cancelled") && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void retryJob(job);
                      }}
                      disabled={busy}
                    >
                      Reintentar
                    </button>
                  )}
                </div>
                <span
                  className="queue-item-progress"
                  style={{ width: formatProgress(job.progress) }}
                  aria-hidden="true"
                />
              </article>
            ))}
          </div>
          {message && <p className="queue-message">{message}</p>}
        </div>
      )}
    </section>
  );
}

function MediaTile({
  item,
  admin,
  onOpen,
  onDelete,
}: {
  item: MediaItem;
  admin: boolean;
  onOpen: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [posterAvailable, setPosterAvailable] = useState(Boolean(item.posterUrl));
  const isVideo = item.kind === "video";

  return (
    <article
      className={`media-card${loaded ? " is-loaded" : ""}${
        isVideo ? " is-video" : ""
      }`}
    >
      <button
        type="button"
        className="media-open"
        onClick={() => onOpen(item)}
        aria-label={isVideo ? "Abrir vídeo" : "Abrir fotografía en grande"}
      >
        {isVideo ? (
          posterAvailable && item.posterUrl ? (
            <img
              src={item.posterUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => {
                setPosterAvailable(false);
                setLoaded(true);
              }}
            />
          ) : (
            <span className="video-fallback" aria-hidden="true">
              <span>▶</span>
            </span>
          )
        ) : (
          <img
            src={item.url}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
          />
        )}
        {isVideo && (
          <span className="play-badge" aria-hidden="true">
            ▶
          </span>
        )}
      </button>
      {admin && onDelete && (
        <button
          type="button"
          className="delete-media"
          onClick={() => onDelete(item)}
        >
          Eliminar
        </button>
      )}
    </article>
  );
}

function Lightbox({
  item,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onClose,
}: {
  item: MediaItem | null;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!item) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onPrevious();
      if (event.key === "ArrowRight" && hasNext) onNext();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [hasNext, hasPrevious, item, onClose, onNext, onPrevious]);

  if (!item) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={item.kind === "video" ? "Vídeo ampliado" : "Fotografía ampliada"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="Cerrar visor"
        autoFocus
      >
        ×
      </button>
      {hasPrevious && (
        <button
          type="button"
          className="lightbox-nav is-previous"
          onClick={onPrevious}
          aria-label="Recuerdo anterior"
        >
          ‹
        </button>
      )}
      {item.kind === "video" ? (
        <video
          key={item.id}
          src={item.url}
          poster={item.posterUrl}
          controls
          playsInline
          preload="metadata"
        />
      ) : (
        <img key={item.id} src={item.url} alt="" />
      )}
      {hasNext && (
        <button
          type="button"
          className="lightbox-nav is-next"
          onClick={onNext}
          aria-label="Recuerdo siguiente"
        >
          ›
        </button>
      )}
    </div>
  );
}

function Gallery({
  incomingMedia,
  admin = false,
}: {
  incomingMedia: MediaItem[];
  admin?: boolean;
}) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const selectedIndex = media.findIndex((item) => item.id === selectedId);
  const selected = selectedIndex >= 0 ? media[selectedIndex] : null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    getMedia(undefined, admin)
      .then((result) => {
        if (!active) return;
        setMedia(result.media);
        setCursor(result.cursor);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "No se pudo cargar la galería.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [admin]);

  useEffect(() => {
    if (incomingMedia.length > 0) {
      setMedia((current) => mergeMedia(current, incomingMedia));
    }
  }, [incomingMedia]);

  useEffect(() => {
    if (admin) return;
    const interval = window.setInterval(() => {
      getMedia()
        .then((result) => {
          setMedia((current) => mergeMedia(current, result.media));
        })
        .catch(() => {
          // A temporary polling error should not replace the visible gallery.
        });
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [admin]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await getMedia(cursor, admin);
      setMedia((current) => mergeMedia(current, result.media));
      setCursor(result.cursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudieron cargar más recuerdos.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [admin, cursor, loadingMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !cursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  const removeItem = async (item: MediaItem) => {
    const label = item.kind === "video" ? "este vídeo" : "esta fotografía";
    if (!window.confirm(`¿Eliminar ${label} definitivamente?`)) return;
    try {
      await deleteMedia(item.key);
      setMedia((current) => current.filter((entry) => entry.id !== item.id));
      if (selectedId === item.id) setSelectedId(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar el recuerdo.",
      );
    }
  };

  const showPrevious = useCallback(() => {
    if (selectedIndex > 0) setSelectedId(media[selectedIndex - 1]?.id ?? null);
  }, [media, selectedIndex]);

  const showNext = useCallback(() => {
    if (selectedIndex >= 0 && selectedIndex < media.length - 1) {
      setSelectedId(media[selectedIndex + 1]?.id ?? null);
    }
  }, [media, selectedIndex]);

  return (
    <section className="gallery-section" aria-labelledby="gallery-title">
      <div className="gallery-heading">
        <span aria-hidden="true" />
        <h2 id="gallery-title">
          {admin ? "Recuerdos subidos" : "Recuerdos compartidos"}
        </h2>
        <span aria-hidden="true" />
      </div>

      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="gallery-loading" aria-label="Cargando recuerdos">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : media.length === 0 ? (
        <div className="empty-gallery">
          <span aria-hidden="true">❧</span>
          <p>
            {admin
              ? "Todavía no se ha compartido ningún recuerdo."
              : "Sé la primera persona en compartir un recuerdo."}
          </p>
        </div>
      ) : (
        <div className="media-grid">
          {media.map((item) => (
            <MediaTile
              key={item.id}
              item={item}
              admin={admin}
              onOpen={(entry) => setSelectedId(entry.id)}
              onDelete={admin ? removeItem : undefined}
            />
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="gallery-sentinel" aria-hidden="true" />
      {loadingMore && <p className="loading-more">Cargando más…</p>}
      <Lightbox
        item={selected}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < media.length - 1}
        onPrevious={showPrevious}
        onNext={showNext}
        onClose={() => setSelectedId(null)}
      />
    </section>
  );
}

function PublicPage() {
  const [incomingMedia, setIncomingMedia] = useState<MediaItem[]>([]);

  return (
    <main>
      <div className="page-shell">
        <Header />
        <UploadZone
          onUploaded={(media) => {
            setIncomingMedia((current) => mergeMedia(current, media));
          }}
        />
        <Gallery incomingMedia={incomingMedia} />
      </div>
    </main>
  );
}

function AdminPage() {
  return (
    <main>
      <div className="page-shell admin-shell">
        <Header admin />
        <a className="back-link" href="/">
          Volver a la galería
        </a>
        <Gallery incomingMedia={[]} admin />
      </div>
    </main>
  );
}

export default function App() {
  return window.location.pathname.startsWith("/admin") ? (
    <AdminPage />
  ) : (
    <PublicPage />
  );
}
