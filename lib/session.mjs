import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

export const SESSION_COOKIE = 'panel_session';
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Huella de las credenciales actuales; invalida sesiones al cambiar la contraseña. */
export function sessionFingerprint(user, pass) {
  if (!user || !pass) return '';
  return createHash('sha256').update(`${user}\u0000${pass}`).digest('base64url');
}

/**
 * Carga el secreto de sesión desde SESSION_SECRET o desde un archivo persistente.
 * Si no existe ninguno, genera uno en /data/.session-secret (o data/ en local).
 */
export function loadSessionSecret({ envSecret = '', file, dataDir } = {}) {
  const configured = String(envSecret ?? '').trim();
  if (configured.length >= 32) return configured;
  if (configured) {
    console.warn('[session] SESSION_SECRET es demasiado corto; se ignora.');
  }

  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Sin permisos POSIX no es fatal.
      }
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[session] No se pudo leer ${file}: ${error.message}`);
    }
  }

  const secret = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    console.log(`[session] Secreto generado en ${file}`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        const existing = readFileSync(file, 'utf8').trim();
        if (existing.length >= 32) return existing;
      } catch {
        // Se usa el secreto efímero de abajo.
      }
    }
    console.warn(
      `[session] No se pudo guardar el secreto en ${file} (${error.message}); ` +
        'las sesiones se cerrarán al reiniciar.',
    );
  }

  if (dataDir) {
    try {
      chmodSync(dataDir, 0o700);
    } catch {
      // No es fatal.
    }
  }

  return secret;
}

function isSecureRequest(req, trustProxy) {
  if (req.socket?.encrypted) return true;
  if (!trustProxy) return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

function sessionCookieAttributes({ secure, maxAge }) {
  const attributes = [
    `Path=/`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes;
}

/**
 * Crea un gestor de sesiones sin estado: el token va firmado con HMAC-SHA256.
 * El payload incluye usuario, vencimiento y huella de la contraseña actual.
 */
export function createSessionManager({
  secret,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  cookieName = SESSION_COOKIE,
  now = () => Date.now(),
} = {}) {
  if (!secret || String(secret).length < 32) {
    throw new Error('El secreto de sesión debe tener al menos 32 caracteres.');
  }

  const signingSecret = String(secret);
  const ttl = Math.max(60, Number(ttlSeconds) || DEFAULT_SESSION_TTL_SECONDS);

  function sign(data) {
    return createHmac('sha256', signingSecret).update(data).digest('base64url');
  }

  function issue({ user, pass }) {
    const payload = {
      v: 1,
      u: String(user ?? ''),
      fp: sessionFingerprint(user, pass),
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + ttl,
      n: randomBytes(12).toString('base64url'),
    };
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${data}.${sign(data)}`;
  }

  function verify(token, expectedFingerprint) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;
    const separator = token.indexOf('.');
    if (separator < 1 || separator === token.length - 1) return null;

    const data = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!safeEqualText(signature, sign(data))) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (!payload || payload.v !== 1) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now() / 1000)) return null;
    if (!expectedFingerprint || !safeEqualText(payload.fp, expectedFingerprint)) return null;
    return payload;
  }

  function read(req) {
    const header = req.headers?.cookie;
    if (typeof header !== 'string') return '';
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 1) continue;
      if (part.slice(0, separator).trim() !== cookieName) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return part.slice(separator + 1).trim();
      }
    }
    return '';
  }

  function setCookie(res, token, { secure = false } = {}) {
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; ${sessionCookieAttributes({ secure, maxAge: ttl }).join('; ')}`,
    );
  }

  function clearCookie(res, { secure = false } = {}) {
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=; ${sessionCookieAttributes({ secure, maxAge: 0 }).join('; ')}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  }

  function secureFor(req, { trustProxy = false } = {}) {
    return isSecureRequest(req, trustProxy);
  }

  return {
    cookieName,
    issue,
    verify,
    read,
    setCookie,
    clearCookie,
    secureFor,
    ttlSeconds: ttl,
  };
}
