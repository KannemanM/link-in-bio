import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { initialsOf } from './config.mjs';

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    }[character];
  });
}

function atomicWrite(file, data, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, data, { mode });
  renameSync(temp, file);
  try {
    chmodSync(file, mode);
  } catch {
    // Sin permisos POSIX no es fatal.
  }
}

let rsvgChecked = false;
let rsvgOk = false;

export function rsvgAvailable() {
  if (rsvgChecked) return rsvgOk;
  const result = spawnSync('rsvg-convert', ['--version'], { encoding: 'utf8' });
  rsvgOk = result.status === 0;
  rsvgChecked = true;
  return rsvgOk;
}

function renderSvg(svg, output, width, height, label) {
  if (!rsvgAvailable()) {
    throw new Error(
      'Falta rsvg-convert para generar imágenes. ' +
        'En Debian/Ubuntu: apt install librsvg2-bin. En macOS: brew install librsvg.',
    );
  }

  const tempSvg = `${output}.${process.pid}.${randomBytes(4).toString('hex')}.svg`;
  const tempPng = `${output}.${process.pid}.${randomBytes(4).toString('hex')}.png`;
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(tempSvg, svg, 'utf8');

  const result = spawnSync(
    'rsvg-convert',
    ['--width', String(width), '--height', String(height), '--output', tempPng, tempSvg],
    { encoding: 'utf8' },
  );

  rmSync(tempSvg, { force: true });

  if (result.status !== 0 || !existsSync(tempPng) || statSync(tempPng).size === 0) {
    rmSync(tempPng, { force: true });
    throw new Error(`rsvg-convert falló al generar ${path.basename(output)}: ${result.stderr || result.error}`);
  }

  renameSync(tempPng, output);
  try {
    chmodSync(output, 0o644);
  } catch {
    // Sin permisos POSIX no es fatal.
  }
  console.log(`Imagen generada: ${output} (${label})`);
  return output;
}

export function monogramSvg(name) {
  const initials = initialsOf(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241d18"/>
      <stop offset="0.55" stop-color="#151210"/>
      <stop offset="1" stop-color="#0c0a09"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.28" cy="0.12" r="0.85">
      <stop offset="0" stop-color="#fbbf24" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#glow)"/>
  <circle cx="256" cy="256" r="226" fill="none" stroke="#fbbf24" stroke-opacity="0.22" stroke-width="2"/>
  <circle cx="256" cy="256" r="214" fill="none" stroke="#faf7f2" stroke-opacity="0.06" stroke-width="1"/>
  <text x="256" y="262" text-anchor="middle" dominant-baseline="middle"
    font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
    font-size="176" font-weight="600" letter-spacing="4" fill="#faf7f2">${escapeXml(initials)}</text>
  <circle cx="380" cy="378" r="7" fill="#fbbf24" fill-opacity="0.9"/>
</svg>`;
}

export function faviconSvg(name) {
  const initials = initialsOf(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241d18"/>
      <stop offset="0.55" stop-color="#151210"/>
      <stop offset="1" stop-color="#0c0a09"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.28" cy="0.12" r="0.85">
      <stop offset="0" stop-color="#fbbf24" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="rounded"><rect width="512" height="512" rx="112"/></clipPath>
  </defs>
  <g clip-path="url(#rounded)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="512" fill="url(#glow)"/>
    <circle cx="256" cy="256" r="208" fill="none" stroke="#fbbf24" stroke-opacity="0.2" stroke-width="2"/>
    <text x="256" y="262" text-anchor="middle" dominant-baseline="middle"
      font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
      font-size="176" font-weight="600" letter-spacing="4" fill="#faf7f2">${escapeXml(initials)}</text>
  </g>
</svg>`;
}

/** Crea el monograma solo si no existe un avatar propio, salvo force. */
export function writeMonogram({ name, file, force = false }) {
  if (existsSync(file) && !force) return false;
  renderSvg(monogramSvg(name), file, 512, 512, 'avatar 512×512');
  return true;
}

export function writeFavicon({ name, file }) {
  atomicWrite(file, faviconSvg(name), 0o644);
  console.log(`Favicon generado: ${file}`);
  return file;
}

async function loadAvatarBuffer(profile, config) {
  const candidates = [];
  if (profile.avatar.startsWith('/') && !profile.avatar.startsWith('//')) {
    if (profile.avatar === '/avatar.png' || profile.avatar === '/avatar') {
      candidates.push(config.avatarFile);
    }
    const local = path.resolve(config.publicDir, profile.avatar.replace(/^\/+/, ''));
    if (local.startsWith(`${config.publicDir}${path.sep}`)) candidates.push(local);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const ext = path.extname(candidate).toLowerCase();
      const type =
        ext === '.webp'
          ? 'image/webp'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'image/png';
      return { buffer: readFileSync(candidate), type };
    }
  }

  if (/^https:\/\//i.test(profile.avatar)) {
    const response = await fetch(profile.avatar, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`No se pudo descargar el avatar (${response.status}).`);
    const rawType = (response.headers.get('content-type') ?? 'image/png').split(';')[0].trim();
    const type = /^image\/(png|jpeg|webp|gif|svg\+xml)$/i.test(rawType) ? rawType : 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('El avatar remoto supera los 10 MB.');
    }
    return { buffer, type };
  }

  const fallback = path.join(config.publicDir, 'avatar.png');
  if (existsSync(fallback)) {
    return { buffer: readFileSync(fallback), type: 'image/png' };
  }

  throw new Error('No se encontró una imagen de avatar para la tarjeta Open Graph.');
}

function wrapText(text, maxChars, maxLines) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === 0) return [];

  const joined = lines.join(' ');
  if (joined.length < words.join(' ').length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:]$/, '')}…`;
  }

  return lines.slice(0, maxLines);
}

/** Genera la tarjeta Open Graph 1200×630 a partir del perfil actual. */
export async function writeOg({ profile, config }) {
  const avatar = await loadAvatarBuffer(profile, config);
  const avatarBase64 = avatar.buffer.toString('base64');
  const siteUrl = config.siteUrl || profile.siteUrl || '';
  const domain = siteUrl.replace(/^https?:\/\//, '') || 'links.example.com';
  const nameSize =
    profile.name.length > 30 ? 46 : profile.name.length > 24 ? 52 : profile.name.length > 19 ? 60 : 68;
  const displayName =
    profile.name.length > 34 ? `${profile.name.slice(0, 33).trimEnd()}…` : profile.name;
  const role = profile.role || 'Enlaces';
  const bioLines = wrapText(profile.bio, 64, 2);

  const bioSvg = bioLines
    .map(
      (line, index) =>
        `<text x="600" y="${447 + index * 36}" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="25" fill="#c9beb4">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141110"/>
      <stop offset="0.5" stop-color="#0c0a09"/>
      <stop offset="1" stop-color="#100d0b"/>
    </linearGradient>
    <radialGradient id="glowA" cx="50%" cy="0%" r="70%">
      <stop offset="0" stop-color="#fbbf24" stop-opacity="0.2"/>
      <stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="96%" cy="100%" r="55%">
      <stop offset="0" stop-color="#b45309" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#b45309" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#faf7f2" stroke-opacity="0.035" stroke-width="1"/>
    </pattern>
    <clipPath id="avatarClip"><circle cx="600" cy="130" r="64"/></clipPath>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glowA)"/>
  <rect width="1200" height="630" fill="url(#glowB)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <rect x="28" y="28" width="1144" height="574" rx="28" fill="none" stroke="#faf7f2" stroke-opacity="0.08" stroke-width="1"/>

  <circle cx="600" cy="130" r="70" fill="#fbbf24" fill-opacity="0.12"/>
  <circle cx="600" cy="130" r="64" fill="#0c0a09"/>
  <image x="536" y="66" width="128" height="128" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" xlink:href="data:${avatar.type};base64,${avatarBase64}"/>

  <text x="600" y="246" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="19" font-weight="600" letter-spacing="7" fill="#fbbf24">ENLACES</text>
  <text x="600" y="315" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="${nameSize}" font-weight="600" letter-spacing="-1.5" fill="#faf7f2">${escapeXml(displayName)}</text>
  <text x="600" y="361" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="28" fill="#a89d94">${escapeXml(role)}</text>
  <line x1="564" y1="392" x2="636" y2="392" stroke="#fbbf24" stroke-opacity="0.55" stroke-width="2" stroke-linecap="round"/>
  ${bioSvg}
  <text x="600" y="548" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="23" fill="#d8cec4">${escapeXml(domain)}</text>
  <text x="600" y="590" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="16" letter-spacing="2" fill="#7d736b">SIN COOKIES · SIN TERCEROS</text>
</svg>`;

  return renderSvg(svg, config.ogFile, 1200, 630, 'Open Graph 1200×630');
}

/** Relee un archivo de imagen para calcular su versión de caché. */
export function fileVersion(file, fallbackFile = '') {
  for (const candidate of [file, fallbackFile]) {
    if (!candidate) continue;
    try {
      return Math.round(statSync(candidate).mtimeMs).toString(36);
    } catch {
      // Sigue con el siguiente candidato.
    }
  }
  return '0';
}
