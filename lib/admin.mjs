import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { validateProfile } from './config.mjs';
import { processAvatar } from './upload.mjs';

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

export const ADMIN_FLASH = {
  perfil: 'Perfil actualizado.',
  avatar: 'Avatar actualizado: 512 × 512 PNG, sin metadatos.',
  creado: 'Enlace creado.',
  guardado: 'Enlace actualizado.',
  borrado: 'Enlace eliminado.',
  movido: 'Orden actualizado.',
  'sin-cambios': 'No había cambios para aplicar.',
};

const CSRF_COOKIE = 'panel_csrf';
const MAX_BACKUPS = 20;
const MAX_AVATAR_BACKUPS = 10;

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Lee cookies sin dependencias externas. */
export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }

  return cookies;
}

/** Origen esperado de la petición, respetando el proxy inverso. */
export function requestOrigin(req, trustProxy = false) {
  let protocol = req.socket?.encrypted ? 'https' : 'http';
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    if (forwarded === 'https' || forwarded === 'http') protocol = forwarded;
  }
  const host = String(req.headers.host ?? '');
  return `${protocol}://${host}`;
}

/**
 * Emite o reutiliza el token CSRF en una cookie HttpOnly y SameSite=Strict.
 * Devuelve el token que debe incluirse en cada formulario.
 */
export function issueCsrfToken(req, res, { trustProxy = false, maxAge = 8 * 60 * 60 } = {}) {
  const existing = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  const token = /^[A-Za-z0-9_-]{43}$/.test(existing ?? '')
    ? existing
    : randomBytes(32).toString('base64url');
  const https = requestOrigin(req, trustProxy).startsWith('https://');
  const attributes = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (https) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
  return token;
}

/** Comprueba token oculto + cookie + Origin/Sec-Fetch-Site. */
export function verifyCsrf(req, fields, { trustProxy = false } = {}) {
  const cookieToken = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  const fieldToken = fields?.csrf;

  if (!safeEqualText(cookieToken, fieldToken)) {
    throw new AdminError(
      403,
      'La sesión del formulario expiró o no es válida. Recarga el panel e inténtalo de nuevo.',
    );
  }

  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    let expected;
    try {
      parsed = new URL(origin).origin;
      expected = new URL(requestOrigin(req, trustProxy)).origin;
    } catch {
      throw new AdminError(403, 'El origen del formulario no es válido.');
    }
    if (parsed !== expected) {
      throw new AdminError(403, 'El formulario se envió desde otro sitio y fue rechazado.');
    }
  }

  const fetchSite = String(req.headers['sec-fetch-site'] ?? '');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AdminError(403, 'El formulario se envió desde otro sitio y fue rechazado.');
  }
}

/** Hash del contenido actual de links.json, usado como control de versión. */
export async function profileVersion(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex').slice(0, 24);
}

function serializeProfile(profile) {
  return {
    name: profile.name,
    role: profile.role,
    bio: profile.bio,
    avatar: profile.avatar,
    siteUrl: profile.siteUrl,
    links: profile.links.map((link) => ({
      title: link.title,
      url: link.url,
      emoji: link.emoji,
      slug: link.slug,
    })),
  };
}

async function syncDirectory(dir) {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // No todos los sistemas permiten fsync de directorios; no es fatal.
  }
}

async function writeJsonAtomic(file, profile) {
  const raw = `${JSON.stringify(serializeProfile(profile), null, 2)}\n`;
  const temp = path.join(
    path.dirname(file),
    `.links-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );

  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // Sin permisos POSIX no es fatal.
  }
  await syncDirectory(path.dirname(file));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function prune(dir, prefix, keep) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  const matching = files
    .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
    .sort()
    .reverse();

  await Promise.all(
    matching.slice(keep).map((file) => rm(path.join(dir, file), { force: true })),
  );
}

async function backupProfile(config) {
  await mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(
    config.backupDir,
    `links-${stamp()}-${randomBytes(2).toString('hex')}.json`,
  );
  try {
    await copyFile(config.linksFile, target);
    await chmod(target, 0o600);
    await prune(config.backupDir, 'links-', MAX_BACKUPS);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function backupAvatar(config, buffer) {
  if (!buffer) return;
  await mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(
    config.backupDir,
    `avatar-${stamp()}-${randomBytes(2).toString('hex')}.png`,
  );
  await writeFile(target, buffer, { mode: 0o600 });
  const files = await readdir(config.backupDir).catch(() => []);
  const avatars = files
    .filter((file) => file.startsWith('avatar-') && file.endsWith('.png'))
    .sort()
    .reverse();
  await Promise.all(
    avatars.slice(MAX_AVATAR_BACKUPS).map((file) => rm(path.join(config.backupDir, file), { force: true })),
  );
}

async function writeAvatarAtomic(file, buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(
    path.dirname(file),
    `.avatar-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  try {
    await chmod(file, 0o644);
  } catch {
    // Sin permisos POSIX no es fatal.
  }
}

function normalizeLink(fields) {
  const parsed = validateProfile({
    name: 'temporal',
    avatar: '/avatar.png',
    links: [
      {
        title: fields.title,
        url: fields.url,
        emoji: fields.emoji,
        slug: fields.slug,
      },
    ],
  });
  return parsed.links[0];
}

/** Reordena una lista sin mutarla. Devuelve null si el movimiento no aplica. */
export function reorderLinks(links, slug, direction) {
  if (direction !== 'up' && direction !== 'down') {
    throw new AdminError(400, 'La dirección del movimiento no es válida.');
  }

  const index = links.findIndex((link) => link.slug === slug);
  if (index < 0) throw new AdminError(404, 'El enlace no existe.');

  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= links.length) return null;

  const next = links.map((link) => ({ ...link }));
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Operaciones del panel. Serializa las escrituras para que dos pestañas
 * no puedan pisarse y usa la versión del archivo como control optimista.
 */
export function createAdminStore({ config, profileStore }) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function mutate(expectedVersion, task) {
    if (!expectedVersion) {
      throw new AdminError(409, 'Falta el control de versión. Recarga el panel.');
    }

    const currentVersion = await profileVersion(config.linksFile);
    if (currentVersion !== expectedVersion) {
      throw new AdminError(
        409,
        'Otra edición cambió la página mientras la tenías abierta. Recarga el panel para ver los datos actuales.',
      );
    }

    const current = profileStore.load();
    const candidate = await task(current);
    if (!candidate) return { profile: current, changed: false };

    const clean = validateProfile(candidate);
    await backupProfile(config);
    await writeJsonAtomic(config.linksFile, clean);
    profileStore.invalidate?.();
    return { profile: profileStore.load(), changed: true };
  }

  return {
    version: () => profileVersion(config.linksFile),

    updateProfile(fields, expectedVersion) {
      return enqueue(async () =>
        mutate(expectedVersion, async (current) => ({
          ...current,
          name: fields.name,
          role: fields.role,
          bio: fields.bio,
          avatar: fields.avatar,
          siteUrl: fields.siteUrl,
        })),
      );
    },

    createLink(fields, expectedVersion) {
      return enqueue(async () =>
        mutate(expectedVersion, async (current) => {
          const link = normalizeLink(fields);
          if (current.links.some((item) => item.slug === link.slug)) {
            throw new AdminError(400, `Ya existe un enlace con el slug "${link.slug}".`);
          }
          return { ...current, links: [...current.links, link] };
        }),
      );
    },

    updateLink(slug, fields, expectedVersion) {
      return enqueue(async () =>
        mutate(expectedVersion, async (current) => {
          const index = current.links.findIndex((link) => link.slug === slug);
          if (index < 0) throw new AdminError(404, 'El enlace no existe.');

          const old = current.links[index];
          const link = normalizeLink({
            title: fields.title ?? old.title,
            url: fields.url ?? old.url,
            emoji: fields.emoji ?? old.emoji,
            slug: fields.slug || old.slug,
          });

          if (link.slug !== slug && current.links.some((item) => item.slug === link.slug)) {
            throw new AdminError(400, `Ya existe un enlace con el slug "${link.slug}".`);
          }

          const links = current.links.map((item, position) => (position === index ? link : item));
          return { ...current, links };
        }),
      );
    },

    moveLink(slug, direction, expectedVersion) {
      return enqueue(async () =>
        mutate(expectedVersion, async (current) => {
          const links = reorderLinks(current.links, slug, direction);
          if (!links) return null;
          return { ...current, links };
        }),
      );
    },

    deleteLink(slug, expectedVersion) {
      return enqueue(async () =>
        mutate(expectedVersion, async (current) => {
          if (!current.links.some((link) => link.slug === slug)) {
            throw new AdminError(404, 'El enlace no existe.');
          }
          if (current.links.length <= 1) {
            throw new AdminError(400, 'Debe quedar al menos un enlace en la página.');
          }
          return { ...current, links: current.links.filter((link) => link.slug !== slug) };
        }),
      );
    },

    async saveAvatar(buffer, expectedVersion) {
      const png = await processAvatar(buffer);

      return enqueue(async () => {
        const currentVersion = await profileVersion(config.linksFile);
        if (currentVersion !== expectedVersion) {
          throw new AdminError(
            409,
            'Otra edición cambió la página mientras subías la imagen. Recarga el panel e inténtalo de nuevo.',
          );
        }

        const previous = existsSync(config.avatarFile)
          ? await readFile(config.avatarFile)
          : null;

        await writeAvatarAtomic(config.avatarFile, png);

        try {
          await backupAvatar(config, previous);
          const current = profileStore.load();
          const clean = validateProfile({ ...current, avatar: '/avatar.png' });
          await backupProfile(config);
          await writeJsonAtomic(config.linksFile, clean);
          profileStore.invalidate?.();
          return { profile: profileStore.load(), changed: true };
        } catch (error) {
          if (previous) await writeAvatarAtomic(config.avatarFile, previous);
          else await rm(config.avatarFile, { force: true });
          throw error;
        }
      });
    },
  };
}
