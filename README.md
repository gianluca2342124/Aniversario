# Santi & Claudia

Una galería colaborativa bilingüe para compartir las fotografías y los vídeos del día. La aplicación usa React, TypeScript y Vite en el navegador, un único Cloudflare Worker y un bucket R2 privado.

## Qué incluye

- Selección conjunta de cualquier cantidad de fotografías y vídeos, arrastrar y soltar y selector móvil.
- Imágenes JPEG, PNG, WebP, HEIC y HEIF compatibles.
- Vídeos MP4, MOV, M4V y WebM compatibles con el navegador.
- Compresión suave de imágenes en el navegador, conservando HEIC/HEIF original cuando el navegador no puede convertirlo.
- Cola estable con dos archivos simultáneos, progreso individual y global, cancelación, reintento de partes y continuación tras errores.
- Subida multipart a R2: los archivos grandes se envían por partes y nunca como un vídeo completo en una sola petición.
- Galería progresiva de fotos y vídeos con vista ampliada, controles de vídeo y soporte para peticiones `Range`.
- Posters de vídeo generados en el navegador cuando el formato lo permite; fallback visual cuando no es posible.
- Detección de duplicados mediante una huella calculada con el tamaño y muestras del contenido.
- Ruta `/admin` con la contraseña existente para ver y eliminar fotos, vídeos y sus posters asociados.
- Compatibilidad con las fotografías que ya existen bajo el prefijo `photos/`.
- Fondo botánico original de flores blancas, centros dorados y verdes profundos para móvil y escritorio, con WebP optimizado y PNG de respaldo.
- Sin usuarios, perfiles, likes, comentarios ni base de datos.

## Requisitos

- Una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up).
- Node.js 22 o posterior.

No necesitas comprar un dominio. El despliegue usa la dirección gratuita:

```text
https://fotos.<tu-subdominio>.workers.dev
```

## Desarrollo local

1. Instala las dependencias:

   ```bash
   pnpm install
   ```

2. Crea el archivo local de secretos:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Cambia el valor de `ADMIN_PASSWORD` dentro de `.dev.vars`.

4. Inicia la aplicación:

   ```bash
   pnpm dev
   ```

El almacenamiento R2 local persiste dentro de `.wrangler/`.

## Despliegue gratuito en Cloudflare

Estos pasos solo son necesarios la primera vez:

1. Inicia sesión:

   ```bash
   pnpm exec wrangler login
   ```

2. Crea el bucket R2 privado:

   ```bash
   pnpm run r2:create
   ```

   No actives su acceso público. Las fotos y los vídeos se sirven únicamente a través del Worker.

3. Guarda la contraseña administrativa como secreto:

   ```bash
   pnpm exec wrangler secret put ADMIN_PASSWORD
   ```

4. Compila y despliega:

   ```bash
   pnpm run deploy
   ```

La galería pública estará en `/` y la administración en `/admin`. El navegador pedirá:

- Usuario: `admin`
- Contraseña: la almacenada en `ADMIN_PASSWORD`

Para futuras actualizaciones basta con ejecutar `pnpm run deploy`.

## Comprobaciones

```bash
pnpm run typecheck
pnpm run build
```

## Cómo funciona la subida grande

1. El frontend obtiene una sesión temporal firmada. El rate limiter se aplica una vez a la selección, no a cada archivo.
2. El Worker valida el MIME declarado y la firma inicial del archivo.
3. R2 inicia una subida multipart con una clave aleatoria.
4. El navegador envía partes uniformes de al menos 8 MiB. El tamaño de parte aumenta automáticamente para respetar el máximo de 10.000 partes de R2.
5. Cada parte tiene hasta tres intentos y puede cancelarse.
6. El Worker completa el objeto solo si el tamaño final coincide con el esperado; los abandonados se abortan al cancelar y R2 limpia automáticamente los multipart incompletos tras siete días.

La aplicación no establece máximos propios de cantidad ni de tamaño. Persisten los límites externos de la plataforma: una petición a un Worker de una cuenta Free admite hasta 100 MB, por lo que este proyecto usa partes de hasta 90 MiB; R2 admite hasta 10.000 partes y objetos de casi 5 TiB. La combinación Worker Free + 10.000 partes limita en la práctica este flujo web a un tamaño menor que el máximo absoluto de R2. En teléfonos, la memoria disponible, el espacio local y el soporte de códecs del navegador pueden ser límites anteriores.

## Arquitectura

```text
React SPA
   │
   ├── POST /api/uploads/session  ── sesión temporal + rate limiting
   ├── POST /api/uploads/create   ── validación + multipart R2
   ├── PUT  /api/uploads/part     ── parte reintentable
   ├── POST /api/uploads/complete ── verificación + finalización
   ├── GET  /api/media            ── listado paginado
   └── GET  /api/media/file       ── imagen, poster o vídeo con Range

/admin + /api/admin/* ── HTTP Basic + ADMIN_PASSWORD
```

Los objetos antiguos y nuevos permanecen bajo `photos/`. Los metadatos personalizados guardan solo el identificador, tipo, huella, tamaño esperado, nombre original interno y clave del poster cuando corresponde. No se necesita D1.

Documentación oficial:

- [R2 multipart desde Workers](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
- [Subida de objetos y límites de multipart](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Límites de Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [R2: precios y cuota gratuita](https://developers.cloudflare.com/r2/pricing/)
- [Secretos de Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
