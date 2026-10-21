import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compara usuario y contraseña en tiempo constante.
 * Devuelve { ok, missing } para distinguir configuración ausente de credenciales incorrectas.
 */
export function verifyPassword(user, pass, expectedUser, expectedPass) {
  if (!expectedUser || !expectedPass) return { ok: false, missing: true };

  const provided = createHash('sha256')
    .update(`${String(user ?? '')}\u0000${String(pass ?? '')}`)
    .digest();
  const expected = createHash('sha256')
    .update(`${expectedUser}\u0000${expectedPass}`)
    .digest();

  return { ok: timingSafeEqual(provided, expected), missing: false };
}

/** Limitador simple en memoria para frenar intentos de fuerza bruta. */
export function createLoginLimiter({ max = 20, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();

  function active(key, now) {
    const entry = attempts.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now) {
      attempts.delete(key);
      return null;
    }
    return entry;
  }

  return {
    check(key, now = Date.now()) {
      const entry = active(key, now);
      if (!entry) return { allowed: true, retryAfter: 0 };
      return {
        allowed: entry.count < max,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
    fail(key, now = Date.now()) {
      const entry = active(key, now);
      if (entry) {
        entry.count += 1;
        return entry.count;
      }
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    },
    reset(key) {
      attempts.delete(key);
    },
    get size() {
      return attempts.size;
    },
  };
}
