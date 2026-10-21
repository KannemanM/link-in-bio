import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionManager,
  loadSessionSecret,
  sessionFingerprint,
} from '../lib/session.mjs';

const SECRET = 's'.repeat(64);

test('sessionFingerprint cambia al cambiar usuario o contraseña', () => {
  const base = sessionFingerprint('martin', 'secreta');
  assert.equal(base, sessionFingerprint('martin', 'secreta'));
  assert.notEqual(base, sessionFingerprint('martin', 'otra'));
  assert.notEqual(base, sessionFingerprint('otro', 'secreta'));
  assert.equal(sessionFingerprint('', ''), '');
});

test('la sesión firmada se valida, vence y rechaza manipulaciones', () => {
  let now = 1_700_000_000_000;
  const manager = createSessionManager({
    secret: SECRET,
    ttlSeconds: 60,
    now: () => now,
  });
  const fingerprint = sessionFingerprint('martin', 'secreta');
  const token = manager.issue({ user: 'martin', pass: 'secreta' });

  assert.equal(manager.verify(token, fingerprint)?.u, 'martin');
  assert.equal(manager.verify(token, sessionFingerprint('martin', 'otra')), null);
  assert.equal(manager.verify(`${token}x`, fingerprint), null);
  assert.equal(manager.verify('', fingerprint), null);

  now += 61_000;
  assert.equal(manager.verify(token, fingerprint), null);
});

test('la cookie de sesión usa HttpOnly, SameSite=Lax y Secure cuando corresponde', () => {
  const manager = createSessionManager({ secret: SECRET, ttlSeconds: 120 });
  const token = manager.issue({ user: 'martin', pass: 'secreta' });
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
  };

  manager.setCookie(res, token, { secure: true });
  assert.match(headers['Set-Cookie'], /^panel_session=/);
  assert.match(headers['Set-Cookie'], /HttpOnly/);
  assert.match(headers['Set-Cookie'], /SameSite=Lax/);
  assert.match(headers['Set-Cookie'], /Max-Age=120/);
  assert.match(headers['Set-Cookie'], /Secure/);

  manager.clearCookie(res, { secure: false });
  assert.match(headers['Set-Cookie'], /^panel_session=;/);
  assert.match(headers['Set-Cookie'], /Max-Age=0/);
  assert.doesNotMatch(headers['Set-Cookie'], /Secure/);
});

test('read extrae la cookie de sesión entre otras cookies', () => {
  const manager = createSessionManager({ secret: SECRET });
  const token = manager.issue({ user: 'martin', pass: 'secreta' });
  const req = { headers: { cookie: `otra=1; panel_session=${token}; ultima=2` } };
  assert.equal(manager.read(req), token);
  assert.equal(manager.read({ headers: {} }), '');
});

test('loadSessionSecret usa SESSION_SECRET o genera y reutiliza el archivo', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'linkinbio-session-'));
  const file = path.join(dir, '.session-secret');

  try {
    assert.equal(
      loadSessionSecret({ envSecret: 'x'.repeat(40), file, dataDir: dir }),
      'x'.repeat(40),
    );

    const generated = loadSessionSecret({ file, dataDir: dir });
    assert.ok(generated.length >= 32);
    assert.equal(loadSessionSecret({ file, dataDir: dir }), generated);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
