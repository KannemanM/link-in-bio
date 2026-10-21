# Página de enlaces (link-in-bio)

[![Docker Hub](https://img.shields.io/docker/v/kannemanm/link-in-bio?label=docker%20hub)](https://hub.docker.com/r/kannemanm/link-in-bio)

Página personal de enlaces, mobile-first, con panel de administración, avatar
editable, seguimiento propio de clics y despliegue con Docker Compose. Todo el
contenido vive en un único `links.json`; no hay base de datos, cookies de
terceros ni JavaScript ejecutable en la página pública.

- Página pública con avatar, nombre, bio y enlaces; CSS embebido y modo claro/oscuro.
- Cada enlace pasa por `/go/:slug`, registra el clic y redirige con `302`.
- Login único en `/login` para administración y estadísticas.
- Panel `/admin` para editar perfil, subir avatar y crear, editar, ordenar o borrar enlaces.
- Panel `/stats` con clics por enlace, visitantes únicos, referentes y exportación CSV.
- Sesión con cookie firmada y logout desde ambos paneles.
- Avatar procesado con `sharp` (512 × 512 PNG, sin EXIF/GPS) y formularios multipart con `busboy`.
- Tarjeta Open Graph 1200 × 630 y favicon generados desde el perfil.
- Docker Compose con dos servicios: `app` (Node) y `caddy` (TLS público o HTTP en LAN). Solo Caddy publica puertos.
- Datos persistentes en un volumen Docker, con copias automáticas de `links.json` y del avatar.

## Documentación

- [Guía de despliegue paso a paso](docs/DESPLIEGUE.md): VPS con dominio y HTTPS,
  LAN sobre HTTP, primer acceso, copias de seguridad, actualizaciones y
  resolución de problemas.

## Requisitos

Para desplegar:

- Un VPS con Docker Engine y el plugin Docker Compose (`docker compose version`).
- Un dominio con registros DNS `A` (y `AAAA` si usas IPv6) apuntando al VPS.
- Puertos 80 y 443 abiertos en el firewall.

Para el modo LAN alcanza con un servidor Debian en la red con Docker, una IP
fija y el puerto 80 libre.

No necesitas instalar Node.js ni Caddy en el servidor: todo corre en contenedores.
La imagen incluye `sharp`, `busboy`, `librsvg2-bin` y fuentes para generar las imágenes.

## Inicio rápido con Docker

```bash
cd /opt
git clone https://github.com/KannemanM/link-in-bio.git
cd link-in-bio

cp .env.example .env
chmod 600 .env
nano .env
```

Antes de arrancar, cambia en `.env`:

```dotenv
DOMAIN=links.example.com
SITE_URL=https://links.example.com
ADMIN_USER=admin
ADMIN_PASS=<contraseña larga y única>
```

Puedes generar una contraseña con:

```bash
openssl rand -base64 24
```

Después:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

Caddy obtiene el certificado TLS automáticamente cuando el DNS ya apunta al
servidor. Comprueba:

```bash
curl -I https://TU_DOMINIO/
curl -I https://TU_DOMINIO/go/portafolio
curl -I https://TU_DOMINIO/login
```

El acceso privado queda en:

```text
https://TU_DOMINIO/login
```

Desde ahí se entra a `/admin` y `/stats` con la misma cuenta.

Si `DOMAIN` y `SITE_URL` no coinciden, Caddy puede servir el sitio pero las URL
canónicas y la tarjeta Open Graph apuntarán a otro dominio. Mantenlos alineados.

## Imagen publicada en Docker Hub

La imagen oficial está publicada como
[`kannemanm/link-in-bio`](https://hub.docker.com/r/kannemanm/link-in-bio).

Tags disponibles:

- `latest`: última versión publicada.
- `1.1.0`: versión fija.

Para usar la imagen sin clonar el repositorio:

```bash
docker pull kannemanm/link-in-bio:latest
```

Ejemplo mínimo para una LAN, sirviendo la app directamente en el puerto 80:

```bash
docker run -d --name link-in-bio \
  -p 80:3000 \
  -e SITE_URL=http://192.168.1.50 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS='una-clave-larga-y-unica' \
  -e STATS_TZ=America/Argentina/Buenos_Aires \
  -v link-in-bio_data:/data \
  --read-only \
  --tmpfs /tmp:size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  kannemanm/link-in-bio:latest
```

Después abrí `http://192.168.1.50/login`.

Para un VPS con dominio y HTTPS, usá `compose.hub.yaml`, que agrega Caddy:

```bash
cp .env.example .env
# Completar DOMAIN, SITE_URL, ADMIN_USER y ADMIN_PASS
docker compose -f compose.hub.yaml up -d
```

La imagen contiene el perfil y los enlaces de ejemplo. Los datos reales se
guardan en el volumen `link-in-bio_data`.

## Despliegue en LAN sobre HTTP

Para servir la página dentro de una red local, sin dominio ni certificados, se
incluye `compose.lan.yaml` y `deploy/Caddyfile.local`. El modo público anterior
queda intacto.

El `.env` del servidor debe usar la IP de la LAN y HTTP:

```dotenv
SITE_URL=http://192.168.1.50
BIND_IP=192.168.1.50
ADMIN_USER=admin
ADMIN_PASS=<contraseña larga y única>
STATS_TZ=America/Argentina/Buenos_Aires
```

`DOMAIN` no se usa en este modo. `BIND_IP` publica el puerto 80 solo en esa
interfaz, no en todas las interfaces del servidor.

Arrancar:

```bash
docker compose -f compose.lan.yaml build
docker compose -f compose.lan.yaml up -d
docker compose -f compose.lan.yaml ps
docker compose -f compose.lan.yaml logs -f app
```

Comprobar:

```bash
curl -I http://192.168.1.50/
curl -I http://192.168.1.50/go/portafolio
curl -I http://192.168.1.50/login
```

El acceso privado queda en `http://192.168.1.50/login`. Desde ahí se llega a
`http://192.168.1.50/admin` y `http://192.168.1.50/stats`.

Notas para este modo:

- No hay TLS: la contraseña del login viaja sin cifrar. Es adecuado solo para
  una LAN de confianza; no publiques el puerto 80 en internet.
- Si el puerto 80 ya está ocupado, cambia el mapeo a
  `"192.168.1.50:8080:80"` y usa `SITE_URL=http://192.168.1.50:8080`.
- El volumen `link-in-bio_data` es el mismo que en el modo público. No ejecutes
  `docker compose down -v` salvo que quieras borrar los datos.
- Para volver al modo público, usa `compose.yaml` con un `.env` que tenga
  `DOMAIN` y `SITE_URL=https://...`.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `DOMAIN` | Sí en modo público | Dominio que usa Caddy para TLS. Sin `https://` ni barra final. No se usa en LAN. |
| `SITE_URL` | Sí | URL pública completa, sin barra final. Se usa en canonical, Open Graph y JSON-LD. |
| `BIND_IP` | No | IP del host donde se publica el puerto 80 en `compose.lan.yaml`. |
| `ADMIN_USER` | Sí | Única cuenta para `/login`, `/admin` y `/stats`. |
| `ADMIN_PASS` | Sí | Única contraseña para `/login`, `/admin` y `/stats`. Si conserva el valor de ejemplo, el login responde `503`. |
| `SESSION_SECRET` | No | Secreto para firmar la cookie de sesión. Si falta, se genera en `/data/.session-secret` con permisos `600`. |
| `STATS_TZ` | No | Zona horaria para mostrar fechas. Por defecto `UTC`; ejemplo: `America/Argentina/Buenos_Aires`. |

`compose.yaml` fija internamente `HOST=0.0.0.0`, `PORT=3000`, `TRUST_PROXY=1` y
las rutas `/data/...`. No hace falta definirlas para Docker.

Para desarrollo local sin Docker, el servidor usa por defecto `links.json` y la
carpeta `data/`. Las variables opcionales (`LINKS_FILE`, `CLICKS_LOG`,
`AVATAR_FILE`, `OG_FILE`, `FAVICON_FILE`, `BACKUP_DIR`, `HOST`, `PORT`,
`TRUST_PROXY`) están documentadas en `.env.example`.

## Acceso privado (`/login`)

`/admin` y `/stats` comparten una única cuenta configurada con `ADMIN_USER` y
`ADMIN_PASS`. Al entrar por primera vez, el servidor redirige a `/login` y,
después de autenticarse, vuelve a la ruta solicitada.

- La sesión se guarda en una cookie `panel_session` firmada con HMAC-SHA256.
- La cookie es `HttpOnly`, `SameSite=Lax`, `Path=/` y dura 8 horas. Añade
  `Secure` automáticamente cuando el sitio se sirve por HTTPS.
- El token incluye una huella de la contraseña actual: si cambias `ADMIN_PASS`,
  las sesiones anteriores dejan de ser válidas.
- El secreto se toma de `SESSION_SECRET` o se genera una sola vez en
  `/data/.session-secret`. El volumen debe conservarse para mantener las sesiones
  entre reinicios.
- **Cerrar sesión** hace `POST /logout`, valida CSRF, borra la cookie y vuelve a
  `/login?bye=1`.

Los intentos fallidos se limitan por IP a **12 cada 15 minutos**. Si faltan las
credenciales o se conserva la contraseña de ejemplo, `/login` responde `503` en
vez de permitir el acceso.

## Panel de administración (`/admin`)

`/admin` requiere una sesión válida. Si no la hay, redirige a
`/login?next=/admin`.

Permite:

- Editar nombre, rol, bio, `siteUrl` y la ruta/URL del avatar.
- Subir una imagen JPG, PNG o WebP de hasta **5 MB**. El servidor la recorta al
  centro, la convierte a PNG de **512 × 512** y elimina EXIF/GPS. El archivo queda
  en `/data/avatar.png`.
- Crear enlaces con título, URL, emoji y slug.
- Editar un enlace existente, incluido su slug.
- Reordenar con los botones ↑ y ↓.
- Eliminar enlaces, con pantalla de confirmación.
- Descargar una copia de `links.json` desde **Descargar JSON**.

Los formularios no usan JavaScript. La protección CSRF combina:

- cookie `panel_csrf` `HttpOnly`, `SameSite=Strict` y `Path=/`;
- campo oculto con el mismo token;
- validación de `Origin`/`Sec-Fetch-Site`;
- sesión válida mediante la cookie `panel_session`.

El mismo token CSRF se usa en el login, en los formularios de administración y en
el botón de logout de ambos paneles.

Cada escritura usa un archivo temporal, `fsync` y renombrado atómico. Antes de
guardar se crea una copia en `/data/backups/` y se conservan las últimas 20
copias de `links.json` y las últimas 10 del avatar. También se usa un control de
versión: si dos pestañas intentan guardar a la vez, la segunda recibe un aviso
para recargar en lugar de pisar los cambios.

Los cambios de perfil o `siteUrl` regeneran el favicon y la tarjeta Open Graph.
Subir un avatar regenera la tarjeta; los cambios de enlaces solo afectan a la
página y a `/stats`.

## Panel de estadísticas (`/stats`)

`/stats` comparte la sesión de `/admin`; no tiene credenciales separadas. Muestra,
para 7 días, 30 días o todo el historial:

- total de clics y visitantes únicos estimados por hash de IP;
- clics, porcentaje y último clic por enlace;
- actividad diaria (UTC) y principales referentes;
- enlaces eliminados agrupados como «Enlace eliminado» para conservar su historial.

`/stats.csv?range=7|30|all` descarga el resumen en CSV.

El login se limita por IP a 12 intentos fallidos cada 15 minutos. Si faltan
credenciales o se conserva la contraseña de ejemplo, los paneles no muestran
datos y el login responde `503`.

## Contenido y enlaces de ejemplo

`links.json` contiene un perfil genérico y **14 enlaces de ejemplo** para
Portafolio, CV, LinkedIn, GitHub, email, WhatsApp, Instagram, X, YouTube,
TikTok, Spotify, Behance, Telegram y Bluesky.

Los ejemplos usan dominios y handles como `example.com`, `tu-usuario` o
`https://wa.me/000000000000` y **deben reemplazarse** desde `/admin` antes de
publicar el sitio. La primera vez que se crea el volumen, este archivo se copia
a `/data/links.json`; después los cambios viven en el volumen y no en Git. Los
clics a esos enlaces también aparecerán en `/stats`.

Formato de un enlace:

```json
{
  "title": "GitHub",
  "url": "https://github.com/tu-usuario",
  "emoji": "🐙",
  "slug": "github"
}
```

- `title` y `url` son obligatorios. Se aceptan `http:`, `https:` y `mailto:`.
- `emoji` es opcional; si falta se usa un ícono de enlace.
- `slug` debe ser único y solo admite minúsculas, números y guiones. Si se deja
  vacío al crear, se genera desde el título.
- `siteUrl` del JSON se usa si `SITE_URL` no está definido; `SITE_URL` tiene prioridad.
- El avatar puede ser `/avatar.png` (recomendado, archivo local) o una URL `https`.
  Una URL externa hace que el navegador y la generación de Open Graph consulten
  ese servidor.

Validación local:

```bash
npm run validate
```

En Docker:

```bash
docker compose exec app npm run validate
```

## Datos persistentes y respaldos

El volumen `link-in-bio_data` se monta en `/data` y contiene:

```text
/data/
├─ links.json          # perfil y enlaces editables
├─ clicks.log          # registro NDJSON de clics
├─ .salt               # sal para hashear IP; no borrar si quieres conservar únicos
├─ .session-secret     # secreto que firma las sesiones; no compartir
├─ avatar.png          # avatar subido o monograma generado
├─ og.png              # tarjeta Open Graph
├─ favicon.svg
└─ backups/
   ├─ links-*.json     # últimas 20 copias
   └─ avatar-*.png     # últimas 10 copias
```

`links.json` se siembra desde el archivo incluido en la imagen **solo la primera
vez** que se crea el volumen. Los cambios posteriores se hacen desde `/admin` o
editando `/data/links.json`; reconstruir la imagen no pisa el volumen.

Respaldar todo el volumen:

```bash
docker compose stop app
docker run --rm \
  -v link-in-bio_data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/link-in-bio-$(date +%F).tar.gz -C /data .
docker compose start app
```

Restaurar (con la app detenida):

```bash
docker compose stop app
docker run --rm \
  -v link-in-bio_data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/ARCHIVO.tar.gz -C /data; chown -R 1000:1000 /data"
docker compose start app
```

También puedes descargar `links.json` desde `/admin` y respaldar `clicks.log`
por separado. No borres `.salt` salvo que quieras reiniciar el conteo de
visitantes únicos: los hashes anteriores dejarán de coincidir. Si borras
`.session-secret`, todas las sesiones abiertas quedarán invalidadas.

En el modo LAN, agregá `-f compose.lan.yaml` a los comandos de Docker Compose
(`docker compose -f compose.lan.yaml ...`).

## Operación y actualizaciones

Ver estado y registros:

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f caddy
```

Reiniciar:

```bash
docker compose restart app
```

Actualizar código o plantillas:

```bash
git pull
docker compose build
docker compose up -d
```

El volumen de datos se conserva. Si cambias el `links.json` del repositorio y
quieres aplicar esos cambios sobre un volumen existente, edita los enlaces desde
`/admin` o copia el archivo manualmente dentro del contenedor. No ejecutes
`docker compose down -v` salvo que quieras borrar todos los datos.

Regenerar imágenes manualmente:

```bash
# Conserva un avatar ya subido; solo crea el monograma si no existe.
docker compose exec app node tools/generate-assets.mjs

# Reemplaza el avatar por el monograma (¡perderás la foto subida!).
docker compose exec app node tools/generate-assets.mjs --force
```

El servidor también regenera `og.png` y el favicon al arrancar y después de
guardar el perfil o subir un avatar. Si una red social ya cacheó la tarjeta,
usa su depurador de Open Graph para forzar la actualización.

Abrir una shell en el contenedor:

```bash
docker compose exec app sh
```

## Seguridad

- El modo público publica solo los puertos 80/443 de Caddy. El modo LAN publica
  solo el puerto 80 en `BIND_IP`. El servicio `app` nunca expone puertos al host.
- En el modo público, usa HTTPS siempre: aunque el login solo envía la
  contraseña al iniciar sesión, la cookie de sesión viaja en cada solicitud. En
  LAN, HTTP solo es aceptable en una red de confianza y sin reenviar el puerto a
  internet.
- Mantén `.env` con permisos `600`, fuera de git y con una contraseña larga y
  única. No reutilices la de otros servicios.
- La app corre como usuario `node` (UID 1000), con sistema de archivos de solo
  lectura, `cap_drop: ALL`, `no-new-privileges` y `/data` como único volumen escribible.
- La página pública no ejecuta JavaScript: la CSP solo permite el hash del JSON-LD.
- `/admin`, `/stats`, `/stats.csv` y `/go/` están marcados `noindex, nofollow`.
- Los formularios del panel están protegidos con CSRF y validación de origen.
- El registro de clics guarda un hash HMAC de la IP con sal local, no la IP completa.

## Estructura del proyecto

```text
link-in-bio/
├─ server.mjs                 # HTTP, rutas, /go, /admin, /stats, /healthz
├─ links.json                 # perfil y enlaces (semilla del volumen)
├─ Dockerfile
├─ compose.yaml               # app + Caddy con TLS público (build local)
├─ compose.lan.yaml           # app + Caddy para LAN sobre HTTP (build local)
├─ compose.hub.yaml           # app + Caddy usando la imagen de Docker Hub
├─ .dockerignore
├─ .env.example
├─ LICENSE                    # licencia MIT
├─ docs/
│  ├─ DESPLIEGUE.md           # guía para alojar el proyecto
│  └─ ci.yml.example          # workflow opcional de GitHub Actions
├─ lib/
│  ├─ config.mjs              # .env, rutas, validación, perfil con caché
│  ├─ admin.mjs               # CRUD, CSRF, versiones, backups, escritura atómica
│  ├─ upload.mjs              # multipart y procesamiento con sharp
│  ├─ assets.mjs              # monograma, favicon y tarjeta Open Graph
│  ├─ clicks.mjs              # registro NDJSON, agregación, CSV
│  ├─ auth.mjs                # verificación de contraseña y límite de intentos
│  ├─ session.mjs             # cookie firmada, expiración y secreto persistente
│  └─ render.mjs              # plantillas, metadatos y paneles
├─ templates/
│  ├─ index.html              # página pública
│  ├─ login.html              # formulario de acceso privado
│  ├─ admin.html              # panel de administración
│  ├─ stats.html              # panel de estadísticas
│  └─ error.html
├─ public/                    # respaldo estático de avatar/favicon/OG/robots
├─ deploy/
│  ├─ Caddyfile              # proxy inverso y TLS público
│  └─ Caddyfile.local        # proxy inverso HTTP para LAN
├─ tools/
│  ├─ generate-assets.mjs
│  └─ validate.mjs
└─ test/                      # pruebas con node:test
```

## Desarrollo local y pruebas

Requisitos: Node.js 20.11 o superior (probado con Node 24) y, para regenerar
imágenes, `rsvg-convert` (`brew install librsvg` en macOS,
`apt install librsvg2-bin` en Debian/Ubuntu).

```bash
npm ci
cp .env.example .env
# Ajusta credenciales y datos locales.
npm test
npm run check
npm start
```

La app queda en <http://127.0.0.1:3000>. Entra primero por `/login`; después
podrás abrir `/admin` y `/stats`. Para recarga del servidor: `npm run dev`. En
local, los datos se guardan en `data/` (ignorada por git) y el secreto de sesión
se crea en `data/.session-secret`.

Pruebas incluidas:

```bash
npm test        # validación, slugs, sesión, auth, clics, CRUD del panel y avatar
npm run check   # sintaxis de todos los módulos
npm run validate
```

## Solución de problemas

**`/admin` o `/stats` responden 503.** Falta el usuario/contraseña o todavía está
el valor de ejemplo. Edita `.env`, reinicia con `docker compose up -d` y vuelve a
entrar.

**Caddy no obtiene el certificado.** Revisa que `DOMAIN` no incluya `https://`,
que el DNS apunte al VPS y que 80/443 estén abiertos. Consulta
`docker compose logs caddy`.

**Error 502 desde Caddy.** La app no está sana. Revisa `docker compose ps` y
`docker compose logs app`; el contenedor `caddy` espera el healthcheck de `app`.

**Permisos en `/data`.** El volumen debe ser propiedad del UID 1000 (`node`). Si
restauraste archivos como root, corrige con:

```bash
docker compose stop app
docker run --rm -v link-in-bio_data:/data alpine chown -R 1000:1000 /data
docker compose start app
```

**La imagen Open Graph no se actualiza.** Revisa los logs de `app` por errores de
`rsvg-convert`, fuerza la regeneración con `docker compose exec app node
tools/generate-assets.mjs` y usa el depurador de la red social.

**No aparecen los cambios en `links.json`.** En Docker, el archivo editable es
`/data/links.json`, no el `links.json` de la imagen. Edita desde `/admin` o usa
`docker compose exec app sh`.

## Licencia

MIT. Podés usar, modificar y redistribuir el proyecto conservando el aviso de
licencia.
