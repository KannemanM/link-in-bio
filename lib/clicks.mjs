import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';

export const RANGES = {
  7: { days: 7, label: 'Últimos 7 días' },
  30: { days: 30, label: 'Últimos 30 días' },
  all: { days: null, label: 'Todo el tiempo' },
};

/** Normaliza el parámetro ?range=. Por defecto: todo el tiempo. */
export function parseRange(value) {
  return value === '7' || value === '30' ? value : 'all';
}

/**
 * Prepara el directorio de datos, el registro de clics y la sal del hash de IP.
 * Devuelve la sal en hexadecimal.
 */
export function ensureData(logPath, saltPath) {
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });

  let salt = '';
  if (existsSync(saltPath)) {
    salt = readFileSync(saltPath, 'utf8').trim();
  }
  if (!/^[a-f0-9]{64}$/i.test(salt)) {
    salt = randomBytes(32).toString('hex');
    writeFileSync(saltPath, `${salt}\n`, { mode: 0o600 });
  }
  try {
    chmodSync(saltPath, 0o600);
  } catch {
    // En sistemas de archivos sin permisos POSIX no es un error fatal.
  }

  const fd = openSync(logPath, 'a', 0o600);
  closeSync(fd);
  try {
    chmodSync(logPath, 0o600);
  } catch {
    // Igual que con la sal: no es fatal en sistemas sin permisos POSIX.
  }

  return salt;
}

/** Hash con sal de la IP: permite contar visitantes sin guardar la IP. */
export function hashIp(salt, ip) {
  const key = /^[a-f0-9]{64}$/i.test(salt) ? Buffer.from(salt, 'hex') : Buffer.from(salt || 'sal');
  return createHmac('sha256', key).update(String(ip || 'desconocida')).digest('hex').slice(0, 12);
}

/** Agrega una línea NDJSON al registro. */
export async function appendClick(logPath, event) {
  await appendFile(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function emptyDaily(dayCount, now) {
  const start = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  ) - (dayCount - 1) * 86_400_000;

  return {
    start,
    days: Array.from({ length: dayCount }, (_, index) => {
      const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      return { date, clicks: 0 };
    }),
  };
}

function referrerHost(value) {
  if (typeof value !== 'string' || !value) return 'Directo';
  try {
    return new URL(value).hostname.replace(/^www\./, '') || 'Directo';
  } catch {
    return 'Directo';
  }
}

/**
 * Recorre clicks.log y arma el resumen para /stats.
 * Las líneas corruptas se ignoran en silencio (se cuentan aparte).
 */
export async function summarizeLog({ logPath, range = 'all', now = Date.now(), links = [] }) {
  const definition = RANGES[range] ?? RANGES.all;
  const since = definition.days ? now - definition.days * 86_400_000 : null;
  const bars = range === '7' ? 7 : 30;
  const daily = emptyDaily(bars, now);
  const dailyByDate = new Map(daily.days.map((day) => [day.date, day]));

  const perLink = new Map();
  for (const link of links) {
    perLink.set(link.slug, {
      slug: link.slug,
      title: link.title,
      url: link.url,
      emoji: link.emoji,
      clicks: 0,
      unique: new Set(),
      lastTs: null,
      removed: false,
    });
  }

  const visitors = new Set();
  const referrers = new Map();
  let total = 0;
  let lastTs = null;
  let corruptLines = 0;

  if (existsSync(logPath)) {
    const stream = createReadStream(logPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        corruptLines += 1;
        continue;
      }

      if (!event || typeof event.t !== 'string' || typeof event.s !== 'string') continue;

      const timestamp = Date.parse(event.t);
      if (!Number.isFinite(timestamp)) continue;
      if (since !== null && timestamp < since) continue;

      total += 1;
      if (event.h) visitors.add(event.h);
      if (lastTs === null || timestamp > lastTs) lastTs = timestamp;

      if (!perLink.has(event.s)) {
        perLink.set(event.s, {
          slug: event.s,
          title: `Enlace eliminado (${event.s})`,
          url: '',
          emoji: '',
          clicks: 0,
          unique: new Set(),
          lastTs: null,
          removed: true,
        });
      }

      const entry = perLink.get(event.s);
      entry.clicks += 1;
      if (event.h) entry.unique.add(event.h);
      if (entry.lastTs === null || timestamp > entry.lastTs) entry.lastTs = timestamp;

      const day = dailyByDate.get(new Date(timestamp).toISOString().slice(0, 10));
      if (day) day.clicks += 1;

      const host = referrerHost(event.r);
      referrers.set(host, (referrers.get(host) ?? 0) + 1);
    }
  }

  const sortedLinks = [...perLink.values()]
    .map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      url: entry.url,
      emoji: entry.emoji,
      clicks: entry.clicks,
      unique: entry.unique.size,
      lastClickAt: entry.lastTs === null ? null : new Date(entry.lastTs).toISOString(),
      share: total === 0 ? 0 : entry.clicks / total,
      removed: entry.removed,
    }))
    .sort((a, b) => b.clicks - a.clicks || a.title.localeCompare(b.title, 'es'));

  return {
    range,
    rangeLabel: definition.label,
    since: since === null ? null : new Date(since).toISOString(),
    total,
    uniqueVisitors: visitors.size,
    lastClickAt: lastTs === null ? null : new Date(lastTs).toISOString(),
    links: sortedLinks,
    referrers: [...referrers.entries()]
      .map(([host, clicks]) => ({ host, clicks }))
      .sort((a, b) => b.clicks - a.clicks || a.host.localeCompare(b.host, 'es'))
      .slice(0, 8),
    days: daily.days,
    activeLinks: links.length,
    corruptLines,
  };
}

function logStamp(logPath) {
  try {
    const stat = statSync(logPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/**
 * Caché de estadísticas: 10 segundos o hasta que cambie el registro/perfil.
 */
export function createStatsStore({ logPath }) {
  const cache = new Map();

  return {
    async get(range, profile) {
      const stamp = `${logStamp(logPath)}|${profile.updatedAt}|${range}`;
      const cached = cache.get(range);
      const now = Date.now();

      if (cached && cached.stamp === stamp && now - cached.at < 10_000) {
        return cached.value;
      }

      const value = await summarizeLog({
        logPath,
        range,
        now,
        links: profile.links,
      });

      cache.set(range, { stamp, at: now, value });
      return value;
    },
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  // Evita que una hoja de cálculo interprete el texto como fórmula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Exporta el resumen como CSV compatible con Excel. */
export function statsToCsv(stats) {
  const rows = [
    ['enlace', 'slug', 'url', 'clics', 'visitantes_unicos', 'ultimo_clic'],
    ...stats.links.map((link) => [
      link.title,
      link.slug,
      link.url,
      link.clicks,
      link.unique,
      link.lastClickAt ?? '',
    ]),
    ['TOTAL', '', '', stats.total, stats.uniqueVisitors, stats.lastClickAt ?? ''],
  ];

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
