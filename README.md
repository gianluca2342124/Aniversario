# Santi & Claudia

Una galería colaborativa, mínima y bilingüe para que los invitados compartan las fotografías del día. La aplicación usa React, TypeScript y Vite en el navegador, y un único Cloudflare Worker con un bucket R2 privado para la API y las imágenes.

## Qué incluye

- Selección múltiple, arrastrar y soltar, cámara o galería del móvil.
- Compresión en el navegador, máximo de 20 fotos por selección y 20 MB por original.
- Galería progresiva con las fotos más recientes primero y actualización automática.
- Visor de fotografías a pantalla completa.
- Detección de duplicados por contenido.
- Ruta `/admin` protegida por una única contraseña para ver y eliminar fotos.
- Validación real del formato de imagen, límite de tamaño y rate limiting en el Worker.
- Sin base de datos: R2 guarda la imagen y sus metadatos mínimos.

## Requisitos

- Una cuenta gratuita de [Cloudflare](https://dash.cloudflare.com/sign-up).
- Node.js 22 o posterior.

No necesitas comprar un dominio. El despliegue usa una dirección gratuita con el formato:

```text
https://santi-claudia-fotos.<tu-subdominio>.workers.dev
```

## Desarrollo local

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Crea el archivo local de secretos:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Cambia el valor de `ADMIN_PASSWORD` dentro de `.dev.vars`.

4. Inicia la aplicación:

   ```bash
   npm run dev
   ```

La aplicación se abre en la dirección que muestra Vite. El almacenamiento R2 se simula localmente y persiste dentro de `.wrangler/`.

## Despliegue gratuito en Cloudflare

Los siguientes pasos solo hay que hacerlos una vez:

1. Inicia sesión desde la terminal:

   ```bash
   npx wrangler login
   ```

2. Crea el bucket R2 privado:

   ```bash
   npm run r2:create
   ```

   No actives el acceso público del bucket. La aplicación sirve las imágenes únicamente a través del Worker.

3. Configura la contraseña de administración como secreto cifrado:

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

   Wrangler te pedirá que escribas la contraseña. No se guarda en el código ni se envía al navegador.

4. Compila y despliega:

   ```bash
   npm run deploy
   ```

Wrangler mostrará la dirección gratuita `workers.dev`. La galería pública estará en `/` y la administración en `/admin`. El navegador pedirá:

- Usuario: `admin`
- Contraseña: la que guardaste en `ADMIN_PASSWORD`

Para futuras actualizaciones basta con ejecutar:

```bash
npm run deploy
```

## Comprobaciones

```bash
npm run typecheck
npm run build
```

`npm run build` genera tanto los archivos estáticos como el Worker listo para desplegar.

## Límites gratuitos

La configuración utiliza únicamente productos con plan gratuito: Workers Static Assets, Workers y R2 Standard. A julio de 2026, Cloudflare incluye 100.000 peticiones diarias de Worker y, en R2 Standard, 10 GB-mes de almacenamiento, un millón de operaciones de escritura y diez millones de lectura al mes. Si el uso supera esas cuotas, Cloudflare puede requerir un plan de pago; el proyecto no activa por sí mismo ningún producto de pago.

Documentación oficial:

- [React + Vite en Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [R2: precios y cuota gratuita](https://developers.cloudflare.com/r2/pricing/)
- [Secretos de Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Direcciones gratuitas `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

## Arquitectura

```text
React SPA
   │
   ├── POST /api/photos ── validación + límite ── R2 privado
   ├── GET  /api/photos ── listado paginado  ─── R2 privado
   └── GET  /api/photo  ── imagen             ─── R2 privado

/admin + /api/admin/* ── HTTP Basic + ADMIN_PASSWORD
```

Cada imagen se guarda con un nombre formado por un prefijo ordenable y un UUID aleatorio. R2 conserva la fecha, el tamaño y el tipo MIME; los metadatos personalizados guardan únicamente el identificador y el hash necesario para detectar duplicados. No se necesita D1 ni otra base de datos.
