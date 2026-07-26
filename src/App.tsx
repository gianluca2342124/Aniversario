import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { deletePhoto, getPhotos, uploadPhoto } from "./api";
import { compressImage, fileHash, isAcceptedImage } from "./image-processing";
import type { Photo } from "./types";

const MAX_SELECTION = 20;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

function mergePhotos(current: Photo[], incoming: Photo[]): Photo[] {
  const photos = new Map(current.map((photo) => [photo.id, photo]));
  incoming.forEach((photo) => photos.set(photo.id, photo));
  return Array.from(photos.values()).sort(
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
      <h1>Santi <span aria-hidden="true">&amp;</span><span className="sr-only">y</span> Claudia</h1>
      {admin ? (
        <p className="hero-subtitle">Administración de fotografías</p>
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
  onUploaded: (photos: Photo[]) => void;
}

function UploadZone({ onUploaded }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const chooseFiles = () => {
    if (!busy) inputRef.current?.click();
  };

  const processFiles = async (selection: File[]) => {
    setErrors([]);
    setStatus("");
    setProgress(0);

    if (selection.length === 0) return;
    if (selection.length > MAX_SELECTION) {
      setErrors([
        `Puedes seleccionar un máximo de ${MAX_SELECTION} fotografías cada vez.`,
      ]);
      return;
    }

    const validationErrors: string[] = [];
    const validFiles = selection.filter((file) => {
      if (!isAcceptedImage(file)) {
        validationErrors.push(`${file.name}: formato no permitido.`);
        return false;
      }
      if (file.size === 0 || file.size > MAX_FILE_SIZE) {
        validationErrors.push(`${file.name}: supera el límite de 20 MB.`);
        return false;
      }
      return true;
    });

    setErrors(validationErrors);
    if (validFiles.length === 0) return;

    setBusy(true);
    setStatus("Preparando tus fotografías…");
    const uploaded: Photo[] = [];
    const uploadErrors = [...validationErrors];
    const selectionHashes = new Set<string>();
    let duplicates = 0;
    let newUploads = 0;

    for (let index = 0; index < validFiles.length; index += 1) {
      const original = validFiles[index];
      setStatus(`Preparando ${index + 1} de ${validFiles.length}…`);
      setProgress((index / validFiles.length) * 100);

      try {
        const hash = await fileHash(original);
        if (selectionHashes.has(hash)) {
          duplicates += 1;
          continue;
        }
        selectionHashes.add(hash);

        const compressed = await compressImage(original);
        setStatus(`Subiendo ${index + 1} de ${validFiles.length}…`);
        const result = await uploadPhoto(compressed, (fraction) => {
          setProgress(((index + fraction) / validFiles.length) * 100);
        });

        if (result.duplicate) duplicates += 1;
        else newUploads += 1;
        uploaded.push(result.photo);
      } catch (error) {
        uploadErrors.push(
          `${original.name}: ${
            error instanceof Error ? error.message : "no se pudo subir."
          }`,
        );
      } finally {
        setProgress(((index + 1) / validFiles.length) * 100);
      }
    }

    if (uploaded.length > 0) onUploaded(uploaded);
    setErrors(uploadErrors);

    if (uploadErrors.length === 0 && newUploads > 0) {
      setStatus(
        `¡Listo! ${newUploads} ${
          newUploads === 1 ? "foto compartida" : "fotos compartidas"
        }.${
          duplicates > 0
            ? ` ${duplicates} ya ${
                duplicates === 1 ? "estaba" : "estaban"
              } en la galería.`
            : ""
        }`,
      );
    } else if (uploadErrors.length === 0 && duplicates > 0) {
      setStatus(
        `¡Listo! ${duplicates === 1 ? "Esa foto ya estaba" : "Esas fotos ya estaban"} en la galería.`,
      );
    } else if (uploaded.length > 0 || duplicates > 0) {
      setStatus(
        `Proceso terminado${
          newUploads > 0
            ? `: ${newUploads} ${
                newUploads === 1 ? "foto se ha subido" : "fotos se han subido"
              }`
            : ""
        }. Revisa los avisos de abajo.`,
      );
    } else {
      setStatus("No se ha podido subir ninguna fotografía.");
    }

    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
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

  return (
    <section className="upload-section" aria-labelledby="share-title">
      <div className="section-heading">
        <h2 id="share-title">Comparte tus fotos de este día</h2>
        <p lang="it">Condividi le foto di questa giornata</p>
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
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          multiple
          onChange={onInputChange}
          disabled={busy}
          tabIndex={-1}
        />
        <span className="upload-mark" aria-hidden="true">
          <span />
        </span>
        <span className="upload-button-text">
          Sube tus fotos <span aria-hidden="true">·</span>{" "}
          <span lang="it">Carica le tue foto</span>
        </span>
        <span className="upload-hint">
          Pulsa para elegir o arrastra aquí
        </span>
        <span className="upload-limits">Hasta 20 fotos · 20 MB por foto</span>
      </div>

      {(busy || status) && (
        <div className="upload-feedback" aria-live="polite">
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Progreso de subida"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <p className={busy ? "" : "success-message"}>{status}</p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="error-list" role="alert">
          {errors.map((error, index) => (
            <p key={`${error}-${index}`}>{error}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function PhotoTile({
  photo,
  admin,
  onOpen,
  onDelete,
}: {
  photo: Photo;
  admin: boolean;
  onOpen: (photo: Photo) => void;
  onDelete?: (photo: Photo) => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <article className={`photo-card${loaded ? " is-loaded" : ""}`}>
      <button
        type="button"
        className="photo-open"
        onClick={() => onOpen(photo)}
        aria-label="Abrir fotografía en grande"
      >
        <img
          src={photo.url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
        />
      </button>
      {admin && onDelete && (
        <button
          type="button"
          className="delete-photo"
          onClick={() => onDelete(photo)}
        >
          Eliminar
        </button>
      )}
    </article>
  );
}

function Lightbox({
  photo,
  onClose,
}: {
  photo: Photo | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!photo) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("no-scroll");
    };
  }, [photo, onClose]);

  if (!photo) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Fotografía ampliada"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="Cerrar fotografía"
        autoFocus
      >
        ×
      </button>
      <img src={photo.url} alt="" />
    </div>
  );
}

function Gallery({
  incomingPhotos,
  admin = false,
}: {
  incomingPhotos: Photo[];
  admin?: boolean;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Photo | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getPhotos(undefined, admin)
      .then((result) => {
        if (!active) return;
        setPhotos(result.photos);
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
    if (incomingPhotos.length > 0) {
      setPhotos((current) => mergePhotos(current, incomingPhotos));
    }
  }, [incomingPhotos]);

  useEffect(() => {
    if (admin) return;
    const interval = window.setInterval(() => {
      getPhotos()
        .then((result) => {
          setPhotos((current) => mergePhotos(current, result.photos));
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
      const result = await getPhotos(cursor, admin);
      setPhotos((current) => mergePhotos(current, result.photos));
      setCursor(result.cursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudieron cargar más fotografías.",
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

  const removePhoto = async (photo: Photo) => {
    if (!window.confirm("¿Eliminar esta fotografía definitivamente?")) return;
    try {
      await deletePhoto(photo.key);
      setPhotos((current) => current.filter((item) => item.id !== photo.id));
      if (selected?.id === photo.id) setSelected(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar la fotografía.",
      );
    }
  };

  return (
    <section className="gallery-section" aria-labelledby="gallery-title">
      <div className="gallery-heading">
        <span aria-hidden="true" />
        <h2 id="gallery-title">{admin ? "Fotografías subidas" : "Recuerdos compartidos"}</h2>
        <span aria-hidden="true" />
      </div>

      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="gallery-loading" aria-label="Cargando fotografías">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : photos.length === 0 ? (
        <div className="empty-gallery">
          <span aria-hidden="true">◇</span>
          <p>
            {admin
              ? "Todavía no se ha subido ninguna fotografía."
              : "Sé la primera persona en compartir un recuerdo."}
          </p>
        </div>
      ) : (
        <div className="photo-grid">
          {photos.map((photo) => (
            <PhotoTile
              key={photo.id}
              photo={photo}
              admin={admin}
              onOpen={setSelected}
              onDelete={admin ? removePhoto : undefined}
            />
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="gallery-sentinel" aria-hidden="true" />
      {loadingMore && <p className="loading-more">Cargando más…</p>}
      <Lightbox photo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function PublicPage() {
  const [incomingPhotos, setIncomingPhotos] = useState<Photo[]>([]);

  return (
    <main>
      <div className="page-shell">
        <Header />
        <UploadZone
          onUploaded={(photos) => {
            setIncomingPhotos((current) => mergePhotos(current, photos));
          }}
        />
        <Gallery incomingPhotos={incomingPhotos} />
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
        <Gallery incomingPhotos={[]} admin />
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
