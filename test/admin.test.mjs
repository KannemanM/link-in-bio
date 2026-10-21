import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AdminError, createAdminStore, profileVersion, reorderLinks } from '../lib/admin.mjs';
import { parseCookies, verifyCsrf } from '../lib/admin.mjs';
import { createProfileStore, validateProfile } from '../lib/config.mjs';
import { processAvatar } from '../lib/upload.mjs';

const BASE_PROFILE = {
  name: 'Prueba',
  role: 'Rol',
  bio: 'Bio',
  avatar: '/avatar.png',
  siteUrl: 'https://links.example.com',
  links: [
    { title: 'Uno', url: 'https://example.com/uno', emoji: '1️⃣', slug: 'uno' },
    { title: 'Dos', url: 'https://example.com/dos', emoji: '2️⃣', slug: 'dos' },
    { title: 'Tres', url: 'https://example.com/tres', emoji: '3️⃣', slug: 'tres' },
  ],
};

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linkinbio-admin-'));
  const linksFile = path.join(dir, 'links.json');
  writeFileSync(linksFile, `${JSON.stringify(BASE_PROFILE, null, 2)}\n`, 'utf8');
  const config = {
    linksFile,
    backupDir: path.join(dir, 'backups'),
    avatarFile: path.join(dir, 'avatar.png'),
  };
  const profileStore = createProfileStore(linksFile);
  const store = createAdminStore({ config, profileStore });
  return { dir, linksFile, store, profileStore };
}

test('reorderLinks mueve sin mutar y respeta los extremos', () => {
  const links = BASE_PROFILE.links;
  const moved = reorderLinks(links, 'dos', 'up');

  assert.deepEqual(moved.map((link) => link.slug), ['dos', 'uno', 'tres']);
  assert.deepEqual(links.map((link) => link.slug), ['uno', 'dos', 'tres']);
  assert.equal(reorderLinks(links, 'uno', 'up'), null);
  assert.equal(reorderLinks(links, 'tres', 'down'), null);
  assert.throws(() => reorderLinks(links, 'uno', 'left'), AdminError);
});

test('el store crea, edita, reordena y borra enlaces con copias de seguridad', async () => {
  const { dir, linksFile, store, profileStore } = fixture();

  try {
    let version = await store.version();
    const created = await store.createLink(
      {
        title: 'GitHub',
        url: 'https://github.com/ejemplo',
        emoji: '🐙',
        slug: 'github',
      },
      version,
    );
    assert.equal(created.profile.links.length, 4);
    assert.equal(created.profile.links.at(-1).slug, 'github');

    version = await store.version();
    const updated = await store.updateLink(
      'github',
      {
        title: 'GitHub editado',
        url: 'https://github.com/ejemplo',
        emoji: '🐙',
        slug: 'github-nuevo',
      },
      version,
    );
    assert.equal(updated.profile.links.at(-1).slug, 'github-nuevo');

    version = await store.version();
    const moved = await store.moveLink('github-nuevo', 'up', version);
    assert.deepEqual(
      moved.profile.links.map((link) => link.slug),
      ['uno', 'dos', 'github-nuevo', 'tres'],
    );

    version = await store.version();
    const deleted = await store.deleteLink('github-nuevo', version);
    assert.equal(deleted.profile.links.length, 3);

    const saved = JSON.parse(readFileSync(linksFile, 'utf8'));
    assert.equal(saved.links.length, 3);
    assert.equal(existsSync(path.join(dir, 'backups')), true);
    assert.ok(readdirSync(path.join(dir, 'backups')).length >= 1);
    assert.deepEqual(
      profileStore.get().links.map((link) => link.slug),
      ['uno', 'dos', 'tres'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el store rechaza versiones viejas y slugs duplicados', async () => {
  const { dir, store } = fixture();

  try {
    const oldVersion = await store.version();
    await store.createLink(
      { title: 'Cuatro', url: 'https://example.com/cuatro', emoji: '', slug: 'cuatro' },
      oldVersion,
    );

    await assert.rejects(
      store.createLink(
        { title: 'Cinco', url: 'https://example.com/cinco', emoji: '', slug: 'cinco' },
        oldVersion,
      ),
      (error) => error instanceof AdminError && error.status === 409,
    );

    const version = await store.version();
    await assert.rejects(
      store.createLink(
        { title: 'Otro uno', url: 'https://example.com/otro', emoji: '', slug: 'uno' },
        version,
      ),
      /Ya existe/,
    );

    await assert.rejects(
      store.createLink(
        { title: 'Malo', url: 'javascript:alert(1)', emoji: '', slug: 'malo' },
        version,
      ),
      /protocolo no permitido/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no se puede borrar el último enlace', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linkinbio-last-'));
  const linksFile = path.join(dir, 'links.json');
  writeFileSync(
    linksFile,
    `${JSON.stringify({ ...BASE_PROFILE, links: [BASE_PROFILE.links[0]] }, null, 2)}\n`,
    'utf8',
  );
  const config = {
    linksFile,
    backupDir: path.join(dir, 'backups'),
    avatarFile: path.join(dir, 'avatar.png'),
  };
  const store = createAdminStore({ config, profileStore: createProfileStore(linksFile) });

  try {
    const version = await store.version();
    await assert.rejects(store.deleteLink('uno', version), /al menos un enlace/);
    assert.equal(validateProfile(JSON.parse(readFileSync(linksFile, 'utf8'))).links.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el CSRF exige cookie, campo y origen correctos', () => {
  assert.deepEqual(parseCookies('a=1; panel_csrf=token'), { a: '1', panel_csrf: 'token' });

  const req = {
    headers: {
      cookie: 'panel_csrf=token',
      host: 'links.example.com',
      origin: 'https://links.example.com',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
    },
    socket: { encrypted: false },
  };

  assert.doesNotThrow(() => verifyCsrf(req, { csrf: 'token' }, { trustProxy: true }));
  assert.throws(() => verifyCsrf(req, { csrf: 'otro' }, { trustProxy: true }), AdminError);
  assert.throws(
    () =>
      verifyCsrf(
        { ...req, headers: { ...req.headers, origin: 'https://evil.example' } },
        { csrf: 'token' },
        { trustProxy: true },
      ),
    /otro sitio/,
  );
  assert.throws(
    () =>
      verifyCsrf(
        { ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } },
        { csrf: 'token' },
        { trustProxy: true },
      ),
    /otro sitio/,
  );
});

test('profileVersion cambia al escribir y el avatar se normaliza sin EXIF', async () => {
  const { dir, linksFile, store } = fixture();

  try {
    const before = await profileVersion(linksFile);
    const version = await store.version();
    await store.updateProfile(
      {
        name: 'Prueba editada',
        role: 'Rol',
        bio: 'Bio nueva',
        avatar: '/avatar.png',
        siteUrl: 'https://links.example.com',
      },
      version,
    );
    assert.notEqual(await profileVersion(linksFile), before);

    const input = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'prueba' } } })
      .toBuffer();

    const png = await processAvatar(input);
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
    assert.equal(metadata.exif, undefined);

    const avatarVersion = await store.version();
    const result = await store.saveAvatar(input, avatarVersion);
    assert.equal(result.profile.avatar, '/avatar.png');
    assert.equal(existsSync(path.join(dir, 'avatar.png')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processAvatar rechaza archivos que no son imágenes raster', async () => {
  await assert.rejects(
    processAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    (error) => error.status === 415,
  );
  await assert.rejects(processAvatar(Buffer.from('no soy una imagen')), (error) => error.status === 415);
});
