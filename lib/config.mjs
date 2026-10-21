import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del proyecto (un nivel por encima de lib/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Carga un archivo .env sin dependencias.
 * No sobrescribe variables que ya existan en process.env.
 */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Convierte un texto en un slug estable y seguro para URLs. */
export function slugify(value, fallback = 'enlace') {
  const base = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return base || fallback;
}

/** Valida y normaliza una URL pública (solo origen, sin barra final). */
export function normalizeSiteUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`siteUrl no es una URL válida: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('siteUrl debe empezar con http:// o https://');
  }
  return url.origin;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Toma los primeros grafemas de un emoji sin partir secuencias Unicode. */
export function firstGraphemes(value, count = 2) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const segmenter = new Intl.Segmenter('es', { granularity: 'grapheme' });
    return [...segmenter.segment(text)]
      .slice(0, count)
      .map((part) => part.segment)
      .join('');
  } catch {
    return [...text].slice(0, count).join('');
  }
}

/**
 * Valida el contenido de links.json y devuelve un perfil normalizado.
 * Lanza un error con un mensaje claro en español si algo no está bien.
 */
export function validateProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('links.json debe contener un objeto JSON.');
  }

  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('links.json: falta el campo "name".');

  const bio = String(raw.bio ?? '').trim();
  const role = String(raw.role ?? '').trim();

  let avatar = String(raw.avatar ?? '/avatar.png').trim() || '/avatar.png';
  if (avatar.length > 2048) {
    throw new Error('links.json: "avatar" es demasiado largo.');
  }
  if (avatar.startsWith('//')) {
    throw new Error('links.json: "avatar" debe ser una ruta local o una URL https, no una URL relativa al protocolo.');
  }
  if (!avatar.startsWith('/') && !/^https:\/\//i.test(avatar)) {
    throw new Error('links.json: "avatar" debe ser una ruta local (/avatar.png) o una URL https.');
  }
  if (/^https:\/\//i.test(avatar)) {
    try {
      new URL(avatar);
    } catch {
      throw new Error('links.json: la URL de "avatar" no es válida.');
    }
  }
  if (avatar.startsWith('/') && avatar.split('/').includes('..')) {
    throw new Error('links.json: "avatar" no puede contener "..".');
  }

  if (raw.siteUrl && String(raw.siteUrl).length > 2048) {
    throw new Error('links.json: "siteUrl" es demasiado largo.');
  }
  const siteUrl = raw.siteUrl ? normalizeSiteUrl(raw.siteUrl) : '';

  if (!Array.isArray(raw.links) || raw.links.length === 0) {
    throw new Error('links.json: "links" debe ser una lista con al menos un enlace.');
  }

  const seen = new Set();
  const links = raw.links.map((item, index) => {
    const position = index + 1;
    if (!item || typeof item !== 'object') {
      throw new Error(`links.json: el enlace #${position} no es un objeto.`);
    }

    const title = String(item.title ?? '').trim();
    if (!title) throw new Error(`links.json: el enlace #${position} no tiene "title".`);

    let parsed;
    const rawUrl = String(item.url ?? '').trim();
    if (rawUrl.length > 2048) {
      throw new Error(`links.json: la URL de "${title}" es demasiado larga.`);
    }
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`links.json: el enlace "${title}" tiene una URL inválida.`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`links.json: "${title}" usa un protocolo no permitido (${parsed.protocol}).`);
    }

    const slug = slugify(item.slug || title, `enlace-${position}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw new Error(`links.json: el slug "${slug}" no es válido.`);
    }
    if (seen.has(slug)) {
      throw new Error(`links.json: el slug "${slug}" está duplicado.`);
    }
    seen.add(slug);

    const emoji = firstGraphemes(item.emoji, 2);

    return {
      title: title.slice(0, 120),
      url: parsed.href,
      slug,
      emoji,
    };
  });

  return {
    name: name.slice(0, 120),
    role: role.slice(0, 160),
    bio: bio.slice(0, 320),
    avatar,
    siteUrl,
    links,
  };
}

/** Lee y valida links.json una sola vez (sin caché). */
export function readProfile(file = path.join(ROOT, 'links.json')) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No se encontró ${file}. Crea links.json antes de iniciar el servidor.`);
    }
    throw error;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`links.json no es JSON válido: ${error.message}`);
  }

  return validateProfile(json);
}

/**
 * Caché de perfil invalidada por mtime y tamaño.
 * Si una edición deja el JSON inválido, se sigue usando la última versión buena.
 */
export function createProfileStore(file = path.join(ROOT, 'links.json')) {
  let cache = null;
  let stamp = '';

  function load() {
    const stat = statSync(file);
    const current = `${stat.mtimeMs}:${stat.size}`;
    if (cache && current === stamp) return cache;

    const profile = readProfile(file);
    cache = { ...profile, updatedAt: stat.mtimeMs, file };
    stamp = current;
    return cache;
  }

  return {
    /** Lectura tolerante: conserva la última versión válida si el archivo se rompe. */
    get() {
      try {
        return load();
      } catch (error) {
        if (cache) {
          console.error(`[links] ${error.message} — se mantiene la última versión válida.`);
          return cache;
        }
        throw error;
      }
    },
    /** Lectura estricta, para el arranque del servidor. */
    load,
    /** Fuerza a releer el archivo tras una escritura del panel. */
    invalidate() {
      cache = null;
      stamp = '';
    },
  };
}

/** Iniciales para el avatar/OG generados: "Martín Kanneman" → "MK". */
export function initialsOf(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) {
    return words[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 2).toUpperCase();
  }
  const clean = (word) => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
  return clean(words[0]) + clean(words[words.length - 1]);
}

/** Lee variables de entorno y resuelve rutas del proyecto. */
export function resolveConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválido: ${env.PORT}`);
  }

  const host = env.HOST?.trim() || '127.0.0.1';
  const logPath = path.resolve(ROOT, env.CLICKS_LOG?.trim() || 'data/clicks.log');
  const dataDir = path.dirname(logPath);
  const linksFile = path.resolve(ROOT, env.LINKS_FILE?.trim() || 'links.json');
  const saltPath = path.join(dataDir, '.salt');
  const trustProxy = ['1', 'true', 'yes', 'si', 'sí'].includes(
    String(env.TRUST_PROXY ?? '').toLowerCase(),
  );

  return {
    port,
    host,
    trustProxy,
    siteUrl: env.SITE_URL?.trim() ? normalizeSiteUrl(env.SITE_URL.trim()) : '',
    domain: env.DOMAIN?.trim() || '',
    adminUser: env.ADMIN_USER ?? '',
    adminPass: env.ADMIN_PASS ?? '',
    sessionSecret: env.SESSION_SECRET?.trim() || '',
    sessionSecretFile: path.join(dataDir, '.session-secret'),
    clicksLog: logPath,
    saltPath,
    dataDir,
    linksFile,
    seedFile: path.join(ROOT, 'links.json'),
    avatarFile: path.resolve(ROOT, env.AVATAR_FILE?.trim() || path.join(dataDir, 'avatar.png')),
    ogFile: path.resolve(ROOT, env.OG_FILE?.trim() || path.join(dataDir, 'og.png')),
    faviconFile: path.resolve(ROOT, env.FAVICON_FILE?.trim() || path.join(dataDir, 'favicon.svg')),
    backupDir: path.resolve(ROOT, env.BACKUP_DIR?.trim() || path.join(dataDir, 'backups')),
    statsTz: env.STATS_TZ?.trim() || 'UTC',
    profileFile: linksFile,
    publicDir: path.join(ROOT, 'public'),
    templatesDir: path.join(ROOT, 'templates'),
  };
}

/**
 * Prepara los directorios persistentes y siembra links.json la primera vez.
 * En Docker, /data nace vacío y el perfil se copia desde la imagen.
 */
export function prepareStorage(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.linksFile), { recursive: true, mode: 0o700 });
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });

  if (!existsSync(config.linksFile)) {
    if (!existsSync(config.seedFile)) {
      throw new Error(`No se encontró ${config.linksFile} ni la semilla ${config.seedFile}.`);
    }
    copyFileSync(config.seedFile, config.linksFile);
    try {
      chmodSync(config.linksFile, 0o600);
    } catch {
      // Sin permisos POSIX no es fatal.
    }
  }
}
