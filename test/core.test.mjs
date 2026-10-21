import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initialsOf,
  normalizeSiteUrl,
  slugify,
  validateProfile,
} from '../lib/config.mjs';
import {
  parseRange,
  statsToCsv,
  summarizeLog,
} from '../lib/clicks.mjs';
import {
  createLoginLimiter,
  verifyPassword,
} from '../lib/auth.mjs';

test('slugify quita acentos y normaliza separadores', () => {
  assert.equal(slugify('Mi CV'), 'mi-cv');
  assert.equal(slugify('  Diseño & Desarrollo  '), 'diseno-desarrollo');
  assert.equal(slugify('¿Escríbeme?'), 'escribeme');
  assert.equal(slugify('***', 'enlace-1'), 'enlace-1');
});

test('initialsOf arma las iniciales del nombre', () => {
  assert.equal(initialsOf('Martín Kanneman'), 'MK');
  assert.equal(initialsOf('martin'), 'MA');
  assert.equal(initialsOf('  '), '·');
});

test('normalizeSiteUrl exige http(s) y quita la barra final', () => {
  assert.equal(normalizeSiteUrl('https://links.example.com/'), 'https://links.example.com');
  assert.throws(() => normalizeSiteUrl('ftp://example.com'), /http/);
});

test('validateProfile normaliza enlaces, slugs y protocolos', () => {
  const profile = validateProfile({
    name: 'Martín Kanneman',
    bio: 'Bio breve',
    siteUrl: 'https://links.example.com/',
    links: [
      { title: 'Portafolio', url: 'https://example.com' },
      { title: 'Mi CV', url: 'https://example.com/cv' },
      { title: 'Correo', url: 'mailto:martin@example.com', emoji: '✉️' },
    ],
  });

  assert.equal(profile.siteUrl, 'https://links.example.com');
  assert.deepEqual(
    profile.links.map((link) => link.slug),
    ['portafolio', 'mi-cv', 'correo'],
  );
  assert.equal(profile.links[2].emoji, '✉️');
});

test('los emojis conservan secuencias Unicode completas', () => {
  const profile = validateProfile({
    name: 'Prueba',
    links: [
      { title: 'Familia', url: 'https://example.com', emoji: '👨‍👩‍👧‍👦' },
    ],
  });

  assert.equal(profile.links[0].emoji, '👨‍👩‍👧‍👦');
});

test('validateProfile rechaza slugs duplicados y protocolos peligrosos', () => {
  assert.throws(
    () =>
      validateProfile({
        name: 'Prueba',
        links: [
          { title: 'Uno', url: 'https://example.com', slug: 'igual' },
          { title: 'Dos', url: 'https://example.com', slug: 'igual' },
        ],
      }),
    /duplicado/,
  );

  assert.throws(
    () =>
      validateProfile({
        name: 'Prueba',
        links: [{ title: 'Malo', url: 'javascript:alert(1)' }],
      }),
    /protocolo no permitido/,
  );
});

test('verifyPassword compara usuario y contraseña y detecta configuración ausente', () => {
  assert.equal(verifyPassword('martin', 'secreta', 'martin', 'secreta').ok, true);
  assert.equal(verifyPassword('martin', 'otra', 'martin', 'secreta').ok, false);
  assert.equal(verifyPassword('otro', 'secreta', 'martin', 'secreta').ok, false);
  assert.equal(verifyPassword('', '', '', '').missing, true);
  assert.equal(verifyPassword(undefined, undefined, 'martin', 'secreta').ok, false);
});

test('el limitador bloquea tras el máximo de intentos', () => {
  const limiter = createLoginLimiter({ max: 2, windowMs: 60_000 });
  const now = Date.now();

  assert.equal(limiter.check('ip', now).allowed, true);
  limiter.fail('ip', now);
  limiter.fail('ip', now);
  assert.equal(limiter.check('ip', now).allowed, false);
  assert.equal(limiter.check('ip', now + 61_000).allowed, true);
});

test('parseRange acepta solo 7, 30 o todo', () => {
  assert.equal(parseRange('7'), '7');
  assert.equal(parseRange('30'), '30');
  assert.equal(parseRange('90'), 'all');
  assert.equal(parseRange(null), 'all');
});

test('summarizeLog cuenta clics, únicos, referentes y enlaces eliminados', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linkinbio-test-'));
  const logPath = path.join(dir, 'clicks.log');
  const now = Date.now();
  const recent = new Date(now - 86_400_000).toISOString();
  const old = new Date(now - 10 * 86_400_000).toISOString();

  const lines = [
    { t: recent, s: 'portafolio', r: 'https://www.instagram.com/', h: 'aaa', ua: 'test' },
    { t: recent, s: 'portafolio', r: '', h: 'bbb', ua: 'test' },
    { t: recent, s: 'cv', r: 'https://twitter.com/alguien', h: 'aaa', ua: 'test' },
    { t: old, s: 'cv', r: '', h: 'ccc', ua: 'test' },
    { t: recent, s: 'viejo', r: '', h: 'ddd', ua: 'test' },
  ];

  writeFileSync(
    logPath,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\nesto no es json\n`,
    'utf8',
  );

  try {
    const links = [
      { slug: 'portafolio', title: 'Portafolio', url: 'https://example.com', emoji: '🌐' },
      { slug: 'cv', title: 'Mi CV', url: 'https://example.com/cv', emoji: '📄' },
    ];

    const week = await summarizeLog({ logPath, range: '7', now, links });
    assert.equal(week.total, 4);
    assert.equal(week.uniqueVisitors, 3);
    assert.equal(week.links.find((link) => link.slug === 'portafolio').clicks, 2);
    assert.equal(week.links.find((link) => link.slug === 'cv').clicks, 1);
    assert.equal(week.links.find((link) => link.slug === 'viejo').removed, true);
    assert.equal(
      week.referrers.find((referrer) => referrer.host === 'instagram.com').clicks,
      1,
    );
    assert.equal(week.corruptLines, 1);
    assert.equal(week.days.length, 7);

    const all = await summarizeLog({ logPath, range: 'all', now, links });
    assert.equal(all.total, 5);
    assert.equal(all.days.length, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeLog funciona si el registro todavía no existe', async () => {
  const stats = await summarizeLog({
    logPath: '/ruta/que/no/existe/clicks.log',
    range: 'all',
    links: [{ slug: 'uno', title: 'Uno', url: 'https://example.com', emoji: '' }],
  });

  assert.equal(stats.total, 0);
  assert.equal(stats.links.length, 1);
  assert.equal(stats.links[0].clicks, 0);
});

test('statsToCsv exporta con BOM, encabezado y total', async () => {
  const stats = await summarizeLog({
    logPath: '/ruta/inexistente/clicks.log',
    links: [{ slug: 'uno', title: 'Uno', url: 'https://example.com', emoji: '' }],
  });
  const csv = statsToCsv(stats);

  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.match(csv, /"enlace","slug","url","clics","visitantes_unicos","ultimo_clic"/);
  assert.match(csv, /"TOTAL"/);
  assert.equal(existsSync('/ruta/inexistente/clicks.log'), false);
});
