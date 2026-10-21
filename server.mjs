import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  createProfileStore,
  loadDotEnv,
  prepareStorage,
  resolveConfig,
} from './lib/config.mjs';
import {
  appendClick,
  createStatsStore,
  ensureData,
  hashIp,
  parseRange,
  statsToCsv,
} from './lib/clicks.mjs';
import { createLoginLimiter, verifyPassword } from './lib/auth.mjs';
import {
  AdminError,
  ADMIN_FLASH,
  createAdminStore,
  issueCsrfToken,
  verifyCsrf,
} from './lib/admin.mjs';
import { createSessionManager, loadSessionSecret, sessionFingerprint } from './lib/session.mjs';
import { HttpError, readForm } from './lib/upload.mjs';
import { fileVersion, writeFavicon, writeMonogram, writeOg } from './lib/assets.mjs';
import {
  loadTemplates,
  renderAdmin,
  renderError,
  renderIndex,
  renderLogin,
  renderStats,
} from './lib/render.mjs';

loadDotEnv();

const config = resolveConfig();
prepareStorage(config);

const templates = loadTemplates(config.templatesDir);
const profileStore = createProfileStore(config.linksFile);
let profile = profileStore.load();
const salt = ensureData(config.clicksLog, config.saltPath);
const statsStore = createStatsStore({ logPath: config.clicksLog });
const adminStore = createAdminStore({ config, profileStore });
const sessionSecret = loadSessionSecret({
  envSecret: config.sessionSecret,
  file: config.sessionSecretFile,
  dataDir: config.dataDir,
});
const sessions = createSessionManager({ secret: sessionSecret });
const sessionFp = sessionFingerprint(config.adminUser, config.adminPass);
const loginLimiter = createLoginLimiter({ max: 12, windowMs: 15 * 60 * 1000 });

try {
  new Intl.DateTimeFormat('es-AR', { timeZone: config.statsTz });
} catch {
  console.warn(`[config] Zona horaria inválida (${config.statsTz}); se usará UTC.`);
  config.statsTz = 'UTC';
}

/**
 * Genera los assets que dependen del perfil. Si rsvg-convert no está
 * disponible se conservan los archivos de public/ y se avisa por consola.
 */
async function regenerateAssets({ favicon = true, og = true } = {}) {
  const current = profileStore.get();

  if (favicon) {
    try {
      writeFavicon({ name: current.name, file: config.faviconFile });
    } catch (error) {
      console.error(`[assets] No se pudo generar el favicon: ${error.message}`);
    }
  }

  if (og) {
    try {
      await writeOg({ profile: current, config });
    } catch (error) {
      console.error(`[assets] No se pudo generar la tarjeta Open Graph: ${error.message}`);
    }
  }
}

try {
  writeMonogram({ name: profile.name, file: config.avatarFile });
} catch (error) {
  console.error(`[assets] No se pudo generar el avatar de respaldo: ${error.message}`);
}
await regenerateAssets();

const publicSiteUrl =
  config.siteUrl ||
  profile.siteUrl ||
  `http://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${config.port}`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const CSP_BASE =
  "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; " +
  "font-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const CSP_PUBLIC = `${CSP_BASE}; script-src 'none'; form-action 'none'`;
const CSP_ADMIN = `${CSP_BASE}; script-src 'none'; form-action 'self'`;

const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};

function respond(req, res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Length': buffer.length,
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

function sendHtml(req, res, status, html, { csp = CSP_PUBLIC, headers = {} } = {}) {
  respond(req, res, status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function sendError(req, res, status, title, message, headers = {}) {
  sendHtml(req, res, status, renderError(templates, { status, title, message }), { headers });
}

function redirect(res, location) {
  res.writeHead(303, {
    ...SECURITY_HEADERS,
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  res.end();
}

function isFresh(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').map((value) => value.trim()).includes(etag);
}

function clientIp(req) {
  let ip = req.socket.remoteAddress ?? '';
  if (config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string') {
    ip = req.headers['x-forwarded-for'].split(',')[0].trim() || ip;
  }
  return ip.replace(/^::ffff:/, '') || 'desconocida';
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function avatarUrlFor(current) {
  const fallback = path.join(config.publicDir, 'avatar.png');

  if (current.avatar === '/avatar.png') {
    return `/avatar.png?v=${fileVersion(config.avatarFile, fallback)}`;
  }

  if (current.avatar.startsWith('/') && !current.avatar.startsWith('//')) {
    const relative = current.avatar.replace(/^\/+/, '');
    const file = path.resolve(config.publicDir, relative);
    if (file.startsWith(`${config.publicDir}${path.sep}`)) {
      return `${current.avatar}?v=${fileVersion(file)}`;
    }
  }

  return current.avatar;
}

function ogUrlFor(siteUrl) {
  const version = fileVersion(config.ogFile, path.join(config.publicDir, 'og.png'));
  return `${siteUrl}/og.png?v=${version}`;
}

function renderPage(req, res) {
  const current = profileStore.get();
  const siteUrl = config.siteUrl || current.siteUrl || publicSiteUrl;
  const { html, scriptHash } = renderIndex(current, {
    templates,
    siteUrl,
    publicDir: config.publicDir,
    avatarUrl: avatarUrlFor(current),
    ogUrl: ogUrlFor(siteUrl),
  });

  const body = Buffer.from(html);
  const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${CSP_BASE}; script-src ${scriptHash}; form-action 'none'`,
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ETag: etag,
  };

  if (isFresh(req, etag)) {
    res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag, 'Cache-Control': headers['Cache-Control'] });
    res.end();
    return;
  }

  respond(req, res, 200, body, headers);
}

async function serveFile(req, res, filePath, { type, cache = 'public, max-age=86400' }) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;

    const etag = `W/"${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`;
    if (isFresh(req, etag)) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        ETag: etag,
        'Cache-Control': cache,
      });
      res.end();
      return true;
    }

    const body = await readFile(filePath);
    respond(req, res, 200, body, {
      'Content-Type': type,
      'Cache-Control': cache,
      ETag: etag,
    });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function servePreferred(req, res, primary, fallback, options) {
  if (await serveFile(req, res, primary, options)) return true;
  return serveFile(req, res, fallback, options);
}

async function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return false;
  }
  if (!relative || relative.includes('\0')) return false;

  const filePath = path.resolve(config.publicDir, relative);
  if (!filePath.startsWith(`${config.publicDir}${path.sep}`)) return false;

  const extension = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[extension];
  if (!type) return false;

  return serveFile(req, res, filePath, {
    type,
    cache: extension === '.txt' ? 'public, max-age=300' : 'public, max-age=86400',
  });
}

async function handleRedirect(req, res, rawSlug) {
  let slug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    return sendError(req, res, 404, 'Enlace no encontrado', 'La dirección no es válida.');
  }

  const current = profileStore.get();
  const link = current.links.find((item) => item.slug === slug);

  if (!link) {
    return sendError(
      req,
      res,
      404,
      'Enlace no encontrado',
      'Este enlace no existe o fue eliminado. Vuelve a la página principal para ver los disponibles.',
    );
  }

  if (req.method === 'GET') {
    const event = {
      t: new Date().toISOString(),
      s: link.slug,
      u: link.url,
      r: truncate(req.headers.referer, 500),
      h: hashIp(salt, clientIp(req)),
      ua: truncate(req.headers['user-agent'], 300),
    };

    try {
      await appendClick(config.clicksLog, event);
    } catch (error) {
      // Un fallo de analítica nunca debe romper la redirección.
      console.error(`[clics] No se pudo registrar el clic en "${link.slug}": ${error.message}`);
    }
  }

  res.writeHead(302, {
    ...SECURITY_HEADERS,
    Location: link.url,
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Length': 0,
  });
  res.end();
}

const PANEL_PASSWORD_EXAMPLE = 'cambia-esta-clave-de-admin';

function panelConfigError() {
  if (!config.adminUser || !config.adminPass) {
    return 'Faltan ADMIN_USER y ADMIN_PASS en el archivo .env. Configúralos y reinicia el servicio.';
  }
  if (config.adminPass === PANEL_PASSWORD_EXAMPLE) {
    return 'ADMIN_PASS sigue con la contraseña de ejemplo. Define una contraseña propia en .env y reinicia el servicio.';
  }
  return '';
}

/** Solo permite volver a rutas internas de los paneles. */
function safeNext(raw, fallback = '/admin') {
  const value = String(raw ?? '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) return fallback;
  const pathname = value.split('?')[0];
  const allowed =
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/stats' ||
    pathname === '/stats/' ||
    pathname === '/stats.csv';
  return allowed ? value : fallback;
}

function currentSession(req) {
  const token = sessions.read(req);
  if (!token) return null;
  return sessions.verify(token, sessionFp);
}

function requireSession(req, res, url) {
  const configError = panelConfigError();
  if (configError) {
    sendError(req, res, 503, 'Panel sin configurar', configError);
    return null;
  }

  const session = currentSession(req);
  if (session) return session;

  const next = safeNext(`${url.pathname}${url.search}`);
  res.writeHead(303, {
    ...SECURITY_HEADERS,
    Location: `/login?next=${encodeURIComponent(next)}`,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  res.end();
  return null;
}

function sendLoginPage(req, res, status, { next = '/admin', error = '', notice = '', user = '', headers = {} } = {}) {
  const csrf = issueCsrfToken(req, res, { trustProxy: config.trustProxy });
  const { html } = renderLogin(templates, {
    csrf,
    next: safeNext(next),
    user,
    error,
    notice,
  });

  sendHtml(req, res, status, html, {
    csp: CSP_ADMIN,
    headers: { ...ADMIN_HEADERS, ...headers },
  });
}

async function handleLogin(req, res, url) {
  const queryNext = safeNext(url.searchParams.get('next'));
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead) {
    const configError = panelConfigError();
    if (configError) {
      return sendLoginPage(req, res, 503, { next: queryNext, error: configError });
    }
    if (currentSession(req)) return redirect(res, queryNext);
    return sendLoginPage(req, res, 200, {
      next: queryNext,
      notice: url.searchParams.get('bye') ? 'Sesión cerrada.' : '',
    });
  }

  if (req.method !== 'POST') {
    return sendError(req, res, 405, 'Método no permitido', 'Esta dirección no acepta ese método.', {
      Allow: 'GET, HEAD, POST',
    });
  }

  const configError = panelConfigError();
  if (configError) {
    return sendLoginPage(req, res, 503, { next: queryNext, error: configError });
  }

  const ip = clientIp(req);
  const limit = loginLimiter.check(ip);
  if (!limit.allowed) {
    return sendLoginPage(req, res, 429, {
      next: queryNext,
      error: 'Se hicieron demasiados intentos fallidos. Espera unos minutos antes de volver a probar.',
      headers: { 'Retry-After': String(limit.retryAfter) },
    });
  }

  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (error instanceof HttpError) {
      return sendLoginPage(req, res, error.status, { next: queryNext, error: error.message });
    }
    throw error;
  }

  const user = String(form.fields.user ?? '').trim();
  const target = safeNext(form.fields.next || queryNext);

  try {
    verifyCsrf(req, form.fields, { trustProxy: config.trustProxy });
  } catch (error) {
    if (error instanceof AdminError) {
      return sendLoginPage(req, res, 403, { next: target, user, error: error.message });
    }
    throw error;
  }

  const result = verifyPassword(user, form.fields.pass, config.adminUser, config.adminPass);
  if (!result.ok) {
    loginLimiter.fail(ip);
    return sendLoginPage(req, res, 401, {
      next: target,
      user,
      error: 'Usuario o contraseña incorrectos.',
    });
  }

  loginLimiter.reset(ip);
  const token = sessions.issue({ user: config.adminUser, pass: config.adminPass });
  sessions.setCookie(res, token, {
    secure: sessions.secureFor(req, { trustProxy: config.trustProxy }),
  });
  return redirect(res, target);
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') {
    return sendError(req, res, 405, 'Método no permitido', 'Esta dirección solo acepta POST.', {
      Allow: 'POST',
    });
  }

  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    if (error instanceof HttpError) {
      return sendError(req, res, error.status, 'No se pudo cerrar sesión', error.message);
    }
    throw error;
  }

  try {
    verifyCsrf(req, form.fields, { trustProxy: config.trustProxy });
  } catch (error) {
    if (error instanceof AdminError) {
      return sendError(req, res, 403, 'No se pudo cerrar sesión', error.message);
    }
    throw error;
  }

  sessions.clearCookie(res, {
    secure: sessions.secureFor(req, { trustProxy: config.trustProxy }),
  });
  return redirect(res, '/login?bye=1');
}

async function handleStats(req, res, url) {
  if (!requireSession(req, res, url)) return;

  const range = parseRange(url.searchParams.get('range'));
  const current = profileStore.get();
  const stats = await statsStore.get(range, current);
  const csrf = issueCsrfToken(req, res, { trustProxy: config.trustProxy });
  const { html } = renderStats(current, stats, {
    templates,
    tz: config.statsTz,
    csrf,
  });

  sendHtml(req, res, 200, html, {
    headers: {
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

async function handleCsv(req, res, url) {
  if (!requireSession(req, res, url)) return;

  const range = parseRange(url.searchParams.get('range'));
  const current = profileStore.get();
  const stats = await statsStore.get(range, current);
  const date = new Date().toISOString().slice(0, 10);

  respond(req, res, 200, statsToCsv(stats), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="clics-${date}.csv"`,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

async function sendAdminPage(req, res, status, options = {}) {
  const current = profileStore.get();
  const stats = await statsStore.get('all', current);
  const csrf = issueCsrfToken(req, res, { trustProxy: config.trustProxy });
  const version = await adminStore.version();
  const { html } = renderAdmin(current, stats, {
    templates,
    csrf,
    version,
    avatarUrl: avatarUrlFor(current),
    ...options,
  });

  sendHtml(req, res, status, html, {
    csp: CSP_ADMIN,
    headers: ADMIN_HEADERS,
  });
}

function adminSlug(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AdminError(400, 'El slug del enlace no es válido.');
  }
}

async function handleAdmin(req, res, url) {
  if (!requireSession(req, res, url)) return;

  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead) {
    if (pathname === '/admin' || pathname === '/admin/') {
      const code = url.searchParams.get('ok') ?? '';
      return sendAdminPage(req, res, 200, { notice: ADMIN_FLASH[code] ?? null });
    }

    if (pathname === '/admin/export') {
      const body = await readFile(config.linksFile);
      const date = new Date().toISOString().slice(0, 10);
      return respond(req, res, 200, body, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="links-${date}.json"`,
        ...ADMIN_HEADERS,
      });
    }

    const deletion = /^\/admin\/delete\/([^/]+)$/.exec(pathname);
    if (deletion) {
      const slug = adminSlug(deletion[1]);
      const current = profileStore.get();
      const link = current.links.find((item) => item.slug === slug);
      if (!link) {
        return sendError(req, res, 404, 'Enlace no encontrado', 'El enlace ya no existe. Vuelve al panel.');
      }
      return sendAdminPage(req, res, 200, { confirm: { link } });
    }

    return sendError(req, res, 404, 'Página no encontrada', 'Esta sección del panel no existe.');
  }

  if (req.method !== 'POST') {
    return sendError(req, res, 405, 'Método no permitido', 'Esta dirección no acepta ese método.', {
      Allow: 'GET, HEAD, POST',
    });
  }

  let form;
  try {
    form = await readForm(req, { maxFileBytes: 5 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendAdminPage(req, res, error.status, { error: error.message });
    }
    throw error;
  }

  try {
    verifyCsrf(req, form.fields, { trustProxy: config.trustProxy });

    if (pathname === '/admin/profile') {
      await adminStore.updateProfile(form.fields, form.fields.version);
      await regenerateAssets();
      return redirect(res, '/admin?ok=perfil');
    }

    if (pathname === '/admin/avatar') {
      if (!form.file?.buffer?.length) {
        throw new AdminError(400, 'Selecciona una imagen JPG, PNG o WebP.');
      }
      await adminStore.saveAvatar(form.file.buffer, form.fields.version);
      await regenerateAssets({ favicon: false });
      return redirect(res, '/admin?ok=avatar');
    }

    if (pathname === '/admin/links') {
      await adminStore.createLink(form.fields, form.fields.version);
      return redirect(res, '/admin?ok=creado');
    }

    const move = /^\/admin\/links\/([^/]+)\/move$/.exec(pathname);
    if (move) {
      const result = await adminStore.moveLink(
        adminSlug(move[1]),
        form.fields.direction,
        form.fields.version,
      );
      return redirect(res, result.changed ? '/admin?ok=movido' : '/admin?ok=sin-cambios');
    }

    const deletion = /^\/admin\/links\/([^/]+)\/delete$/.exec(pathname);
    if (deletion) {
      await adminStore.deleteLink(adminSlug(deletion[1]), form.fields.version);
      return redirect(res, '/admin?ok=borrado');
    }

    const edit = /^\/admin\/links\/([^/]+)$/.exec(pathname);
    if (edit) {
      await adminStore.updateLink(adminSlug(edit[1]), form.fields, form.fields.version);
      return redirect(res, '/admin?ok=guardado');
    }

    return sendError(req, res, 404, 'Página no encontrada', 'Esta acción del panel no existe.');
  } catch (error) {
    if (error instanceof AdminError) {
      return sendAdminPage(req, res, error.status, { error: error.message });
    }
    throw error;
  }
}

async function route(req, res) {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    if (req.url === '/healthz') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms.toFixed(1)} ms)`);
  });

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendError(req, res, 400, 'Solicitud inválida', 'No se pudo interpretar la dirección solicitada.');
  }

  const pathname = url.pathname;

  if (pathname === '/login') {
    return handleLogin(req, res, url);
  }

  if (pathname === '/logout') {
    return handleLogout(req, res);
  }

  if (pathname === '/admin/login') {
    return redirect(res, '/login?next=%2Fadmin');
  }

  if (pathname === '/stats/login') {
    return redirect(res, '/login?next=%2Fstats');
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return handleAdmin(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(req, res, 405, 'Método no permitido', 'Esta dirección solo acepta solicitudes GET.', {
      Allow: 'GET, HEAD',
    });
  }

  if (pathname === '/') return renderPage(req, res);

  if (pathname === '/healthz') {
    return respond(req, res, 200, 'ok\n', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  if (pathname.startsWith('/go/')) {
    return handleRedirect(req, res, pathname.slice('/go/'.length).replace(/\/+$/, ''));
  }

  if (pathname === '/stats' || pathname === '/stats/') {
    return handleStats(req, res, url);
  }

  if (pathname === '/stats.csv') {
    return handleCsv(req, res, url);
  }

  if (pathname === '/avatar.png') {
    if (
      await servePreferred(req, res, config.avatarFile, path.join(config.publicDir, 'avatar.png'), {
        type: 'image/png',
        cache: 'public, max-age=86400',
      })
    ) {
      return;
    }
  }

  if (pathname === '/og.png') {
    if (
      await servePreferred(req, res, config.ogFile, path.join(config.publicDir, 'og.png'), {
        type: 'image/png',
        cache: 'public, max-age=86400',
      })
    ) {
      return;
    }
  }

  if (pathname === '/favicon.svg') {
    if (
      await servePreferred(req, res, config.faviconFile, path.join(config.publicDir, 'favicon.svg'), {
        type: 'image/svg+xml',
        cache: 'public, max-age=300',
      })
    ) {
      return;
    }
  }

  if (await serveStatic(req, res, pathname)) return;

  return sendError(
    req,
    res,
    404,
    'Página no encontrada',
    'La dirección que buscas no existe. Revisa el enlace o vuelve al inicio.',
  );
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[servidor] Error no controlado:', error);
    if (!res.headersSent) {
      sendError(req, res, 500, 'Algo salió mal', 'Ocurrió un error inesperado. Intenta nuevamente en unos segundos.');
    } else {
      res.end();
    }
  });
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, config.host, () => {
  profile = profileStore.get();
  console.log(`Servidor escuchando en http://${config.host}:${config.port}`);
  console.log(`Sitio público: ${publicSiteUrl}`);
  console.log(`Perfil editable: ${config.linksFile}`);
  console.log(`Registro de clics: ${config.clicksLog}`);
  console.log(`Acceso privado: ${publicSiteUrl}/login`);
  console.log(`Panel de estadísticas: ${publicSiteUrl}/stats`);
  console.log(`Panel de administración: ${publicSiteUrl}/admin`);

  if (!config.siteUrl && !profile.siteUrl) {
    console.warn('[config] Define SITE_URL o siteUrl en links.json para que Open Graph use una URL absoluta.');
  }
  if (!config.adminUser || !config.adminPass) {
    console.warn('[config] Faltan ADMIN_USER/ADMIN_PASS: /login responderá 503.');
  } else if (config.adminPass === PANEL_PASSWORD_EXAMPLE) {
    console.warn('[config] ADMIN_PASS sigue con el valor de ejemplo; cámbialo antes de publicar.');
  }
  if (!config.trustProxy) {
    console.warn('[config] TRUST_PROXY está desactivado: detrás de Caddy todos los visitantes compartirán IP.');
  }
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} recibido: cerrando el servidor…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
