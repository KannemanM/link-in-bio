# Guía de despliegue

Esta guía explica cómo alojar el proyecto desde cero. Está pensada para alguien
que clona el repositorio y quiere publicar su propia página de enlaces sin tocar
el código.

Repositorio: <https://github.com/KannemanM/link-in-bio>

## Requisitos

- Docker Engine y Docker Compose v2.
- Un servidor Linux, una Raspberry Pi o una máquina siempre encendida.
- Para el modo público: un dominio con registros DNS `A` y/o `AAAA` apuntando al
  servidor, y los puertos 80 y 443 abiertos.
- Para el modo LAN: una IP fija en la red local y el puerto 80 libre.

No hace falta instalar Node.js ni Caddy en el servidor: todo corre dentro de los
contenedores.

## Opción rápida: imagen publicada en Docker Hub

Si no querés clonar ni construir el proyecto, usá la imagen oficial:

```bash
docker pull kannemanm/link-in-bio:latest
```

### LAN con `docker run`

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

Cambiá `192.168.1.50` por la IP del servidor. La página queda en
`http://192.168.1.50` y el acceso privado en `http://192.168.1.50/login`.

### VPS con dominio y HTTPS usando `compose.hub.yaml`

```bash
cp .env.example .env
chmod 600 .env
# Completar DOMAIN, SITE_URL, ADMIN_USER y ADMIN_PASS
docker compose -f compose.hub.yaml up -d
```

La imagen incluye el perfil y los 14 enlaces de ejemplo. Los datos reales se
guardan en el volumen `link-in-bio_data`; no se pierden al actualizar la imagen.

### Actualizar la imagen

```bash
docker pull kannemanm/link-in-bio:latest
docker compose -f compose.hub.yaml up -d
```

Si usás `docker run`, detené y eliminá el contenedor, y volvé a crearlo con el
mismo volumen:

```bash
docker rm -f link-in-bio
# repetir el docker run con la nueva imagen
```

## 1. Clonar y configurar

```bash
git clone https://github.com/KannemanM/link-in-bio.git
cd link-in-bio

cp .env.example .env
chmod 600 .env
```

Generá una contraseña larga y única:

```bash
openssl rand -base64 32
```

Editá `.env` con tus datos. Como mínimo:

```dotenv
ADMIN_USER=admin
ADMIN_PASS=la-contraseña-que-generaste
```

`ADMIN_USER` y `ADMIN_PASS` son la única cuenta para `/login`, `/admin` y
`/stats`. No hay registro de usuarios.

`SESSION_SECRET` es opcional. Si no lo definís, el servidor genera uno en
`/data/.session-secret` con permisos `600` y lo reutiliza entre reinicios.

## 2. Elegir el modo de despliegue

### Opción A: VPS con dominio y HTTPS

Es el modo recomendado para publicar en internet. Caddy obtiene y renueva el
certificado TLS automáticamente.

En `.env`:

```dotenv
DOMAIN=links.tu-dominio.com
SITE_URL=https://links.tu-dominio.com
ADMIN_USER=admin
ADMIN_PASS=la-contraseña-que-generaste
STATS_TZ=America/Argentina/Buenos_Aires
```

El DNS del dominio debe apuntar al servidor antes de arrancar. Después:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

La página queda en `https://links.tu-dominio.com` y el acceso privado en
`https://links.tu-dominio.com/login`.

### Opción B: LAN sobre HTTP

Para una red local, sin dominio ni certificados. El sitio se sirve por HTTP y
Caddy publica el puerto 80 únicamente en la IP indicada.

En `.env`:

```dotenv
SITE_URL=http://192.168.1.50
BIND_IP=192.168.1.50
ADMIN_USER=admin
ADMIN_PASS=la-contraseña-que-generaste
STATS_TZ=America/Argentina/Buenos_Aires
```

Reemplazá `192.168.1.50` por la IP de tu servidor. `DOMAIN` no se usa en este
modo. Arrancar:

```bash
docker compose -f compose.lan.yaml build
docker compose -f compose.lan.yaml up -d
docker compose -f compose.lan.yaml ps
docker compose -f compose.lan.yaml logs -f app
```

La página queda en `http://192.168.1.50` y el acceso privado en
`http://192.168.1.50/login`.

> En LAN la contraseña viaja sin cifrar. Usá este modo solo en una red de
> confianza y no reenvíes el puerto 80 a internet.

## 3. Primer acceso

Abrí `/login` e ingresá con `ADMIN_USER` y `ADMIN_PASS`. La sesión dura 8 horas y
se puede cerrar desde el botón **Cerrar sesión** de `/admin` o `/stats`.

El repositorio incluye un perfil y 14 enlaces de ejemplo en `links.json`. La
primera vez que se crea el volumen, ese archivo se copia a `/data/links.json`.
Después, los cambios se hacen desde `/admin` y quedan guardados en el volumen.

Pasos recomendados:

1. Entrá a `/admin`.
2. Editá nombre, rol, bio, `siteUrl` y avatar.
3. Reemplazá los enlaces de ejemplo por los tuyos.
4. Abrí `/stats` para comprobar el seguimiento de clics.

Los enlaces de ejemplo usan `example.com`, `tu-usuario` y
`000000000000`; no apuntan a cuentas reales.

## 4. Datos persistentes

El volumen `link-in-bio_data` se monta en `/data` y contiene:

```text
/data/
├─ links.json          # perfil y enlaces
├─ clicks.log          # registro de clics
├─ .salt               # sal para hashear IP
├─ .session-secret     # secreto de las sesiones
├─ avatar.png
├─ og.png
├─ favicon.svg
└─ backups/
```

No ejecutes `docker compose down -v` salvo que quieras borrar todos los datos.
Reconstruir la imagen no pisa el volumen existente.

### Copia de seguridad

```bash
docker compose stop app
docker run --rm \
  -v link-in-bio_data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/link-in-bio-$(date +%F).tar.gz -C /data .
docker compose start app
```

En modo LAN agregá `-f compose.lan.yaml` a los comandos de Compose.

### Restaurar una copia

```bash
docker compose stop app
docker run --rm \
  -v link-in-bio_data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/ARCHIVO.tar.gz -C /data; chown -R 1000:1000 /data"
docker compose start app
```

## 5. Actualizar el proyecto

```bash
git pull
docker compose build
docker compose up -d
```

En LAN:

```bash
git pull
docker compose -f compose.lan.yaml build
docker compose -f compose.lan.yaml up -d
```

Las sesiones abiertas se mantienen si conservás `/data/.session-secret`. Si
cambiás `ADMIN_PASS`, las sesiones anteriores se invalidan automáticamente.

## 6. Comprobar que funciona

```bash
curl -I https://links.tu-dominio.com/
curl -I https://links.tu-dominio.com/go/portafolio
curl -I https://links.tu-dominio.com/login
```

En LAN, cambiá `https://links.tu-dominio.com` por `http://192.168.1.50`.

También podés validar los datos dentro del contenedor:

```bash
docker compose exec app npm run validate
```

## 7. Seguridad

- Mantené `.env` con permisos `600` y fuera de Git. El repositorio ya ignora
  `.env` y sus variantes.
- Usá una contraseña larga y única. No reutilices la de otros servicios.
- En el modo público, usá HTTPS siempre. La cookie de sesión viaja en cada
  solicitud.
- No publiques el puerto 80 de la LAN en internet.
- El contenedor `app` corre como usuario `node`, con sistema de archivos de solo
  lectura, `cap_drop: ALL` y `/data` como único volumen escribible.
- `/data/.session-secret` firma las cookies. No lo compartas ni lo subas a Git.

## 8. Problemas comunes

### El login responde 503

Faltan `ADMIN_USER`/`ADMIN_PASS` o `ADMIN_PASS` conserva el valor de ejemplo.
Edita `.env`, define una contraseña real y reinicia:

```bash
docker compose up -d --force-recreate
```

### El login vuelve a pedir la contraseña en cada visita

Revisá que `SITE_URL` coincida con la URL real. Si estás detrás de un proxy,
mantené `TRUST_PROXY=1` para que la cookie se marque `Secure` correctamente en
HTTPS.

### El puerto 80 está ocupado

Cambiá el mapeo en `compose.lan.yaml`, por ejemplo a
`"192.168.1.50:8080:80"`, y actualizá `SITE_URL=http://192.168.1.50:8080`.

### Caddy no obtiene el certificado

Comprobá que el DNS ya apunta al servidor, que los puertos 80/443 están abiertos
y que `DOMAIN` y `SITE_URL` usan el mismo dominio. Mirá los logs:

```bash
docker compose logs -f caddy
```

### La app no arranca o está unhealthy

```bash
docker compose ps
docker compose logs --tail=100 app
```

## Integración continua (opcional)

El archivo `docs/ci.yml.example` contiene un workflow de GitHub Actions que
ejecuta `npm ci`, `npm run check`, `npm test` y `npm run validate`.

Para activarlo, copialo a `.github/workflows/ci.yml` y hacé commit. Si usás un
token de GitHub para pushear, ese token necesita el permiso `workflow`; sin ese
permiso GitHub rechaza los archivos dentro de `.github/workflows/`.

## Licencia

MIT. Podés usar, modificar y redistribuir el proyecto conservando el aviso de
licencia.
