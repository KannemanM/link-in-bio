import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const MONTHS_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

/** Escapa texto para insertarlo en HTML o en atributos. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Carga las plantillas una vez al arrancar (los cambios requieren reinicio). */
export function loadTemplates(dir) {
  return {
    index: readFileSync(path.join(dir, 'index.html'), 'utf8'),
    stats: readFileSync(path.join(dir, 'stats.html'), 'utf8'),
    admin: readFileSync(path.join(dir, 'admin.html'), 'utf8'),
    login: readFileSync(path.join(dir, 'login.html'), 'utf8'),
    error: readFileSync(path.join(dir, 'error.html'), 'utf8'),
  };
}

function fill(template, tokens) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => tokens[key] ?? '');
}

function absoluteUrl(siteUrl, value) {
  if (/^https?:\/\//i.test(value)) return value;
  return `${siteUrl}${value.startsWith('/') ? '' : '/'}${value}`;
}

function assetVersion(file) {
  try {
    return Math.round(statSync(file).mtimeMs).toString(36);
  } catch {
    return '0';
  }
}

function pageTitle(profile) {
  return profile.role ? `${profile.name} · ${profile.role}` : `${profile.name} · Enlaces`;
}

function jsonLdFor(profile, siteUrl, avatarUrl) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.name,
    jobTitle: profile.role || undefined,
    description: profile.bio || undefined,
    url: `${siteUrl}/`,
    image: absoluteUrl(siteUrl, avatarUrl),
    sameAs: profile.links
      .map((link) => link.url)
      .filter((url) => /^https?:\/\//i.test(url)),
  };

  // Evita cerrar el <script> si el texto del perfil contiene "<".
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const LINK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.07 0l-2 2a5 5 0 0 0 7.07 7.07l1.1-1.1"/></svg>`;

const ARROW_ICON = `<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>`;

/**
 * Renderiza la página pública.
 * Devuelve también el hash CSP del JSON-LD (el único <script> del documento).
 */
export function renderIndex(
  profile,
  { templates, siteUrl, publicDir, avatarUrl = profile.avatar, ogUrl = '' },
) {
  const title = pageTitle(profile);
  const canonical = `${siteUrl}/`;
  const ogImage =
    ogUrl || `${siteUrl}/og.png?v=${assetVersion(path.join(publicDir, 'og.png'))}`;
  const ogAlt = profile.role
    ? `${profile.name} — ${profile.role}. Página de enlaces.`
    : `${profile.name}. Página de enlaces.`;

  const links = profile.links
    .map((link) => {
      const emoji = link.emoji
        ? escapeHtml(link.emoji)
        : LINK_ICON;
      return `      <a class="link" href="/go/${encodeURIComponent(link.slug)}" data-slug="${escapeHtml(link.slug)}">
        <span class="emoji" aria-hidden="true">${emoji}</span>
        <span class="label">${escapeHtml(link.title)}</span>
        ${ARROW_ICON}
      </a>`;
    })
    .join('\n');

  const jsonLd = jsonLdFor(profile, siteUrl, avatarUrl);
  const scriptHash = `'sha256-${createHash('sha256').update(jsonLd).digest('base64')}'`;

  const html = fill(templates.index, {
    TITLE: escapeHtml(title),
    NAME: escapeHtml(profile.name),
    BIO: escapeHtml(profile.bio),
    CANONICAL: escapeHtml(canonical),
    AVATAR: escapeHtml(avatarUrl),
    OG_IMAGE: escapeHtml(ogImage),
    OG_ALT: escapeHtml(ogAlt),
    JSONLD: jsonLd,
    LINKS: links,
    YEAR: String(new Date().getFullYear()),
  });

  return { html, scriptHash };
}

const numberFormatter = new Intl.NumberFormat('es-AR');

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function safeDateFormatter(timeZone, options) {
  try {
    return new Intl.DateTimeFormat('es-AR', { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat('es-AR', { ...options, timeZone: 'UTC' });
  }
}

function formatDateTime(iso, timeZone) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return safeDateFormatter(timeZone, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatShortDate(iso, timeZone) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return safeDateFormatter(timeZone, {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatTime(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return safeDateFormatter(timeZone, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatUtcDay(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

function linkRow(link, timeZone) {
  const emoji = link.emoji ? escapeHtml(link.emoji) : '·';
  const title = link.removed
    ? `<span class="link-title">${escapeHtml(link.title)}</span>`
    : `<a class="link-title" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(link.title)}</a>`;

  return `            <tr class="${link.removed ? 'removed' : ''}">
              <td>
                <span class="link-cell">
                  <span class="link-emoji" aria-hidden="true">${emoji}</span>
                  <span>
                    ${title}
                    <span class="link-slug">/go/${escapeHtml(link.slug)}</span>
                  </span>
                </span>
              </td>
              <td class="num">${formatNumber(link.clicks)}</td>
              <td class="num">${formatNumber((link.share * 100).toFixed(1))}%</td>
              <td class="muted">${escapeHtml(formatDateTime(link.lastClickAt, timeZone))}</td>
            </tr>`;
}

function barsBlock(stats) {
  if (stats.total === 0) {
    return '          <p class="empty">Todavía no hay clics registrados en este período.</p>';
  }

  const max = Math.max(1, ...stats.days.map((day) => day.clicks));
  const bars = stats.days
    .map((day) => {
      const height = day.clicks === 0 ? 0 : Math.max(4, Math.round((day.clicks / max) * 100));
      const label = `${formatUtcDay(day.date)}: ${formatNumber(day.clicks)} ${day.clicks === 1 ? 'clic' : 'clics'}`;
      return `<div class="bar" title="${escapeHtml(label)}"><span style="height:${height}%"></span></div>`;
    })
    .join('');

  const first = stats.days[0]?.date;
  const last = stats.days[stats.days.length - 1]?.date;

  return `          <div class="bars" role="img" aria-label="Actividad diaria de clics">
${bars}
          </div>
          <div class="axis">
            <span>${escapeHtml(formatUtcDay(first))}</span>
            <span>${escapeHtml(formatUtcDay(last))} · UTC</span>
          </div>`;
}

function referrersBlock(stats) {
  if (stats.referrers.length === 0) {
    return '          <p class="empty">Todavía no hay referentes registrados en este período.</p>';
  }

  const items = stats.referrers
    .map(
      (referrer) => `            <li class="ref">
              <span class="ref-name" title="${escapeHtml(referrer.host)}">${escapeHtml(referrer.host)}</span>
              <span class="ref-count">${formatNumber(referrer.clicks)} ${referrer.clicks === 1 ? 'clic' : 'clics'}</span>
            </li>`,
    )
    .join('\n');

  return `          <ul class="refs">
${items}
          </ul>`;
}

/** Renderiza el panel privado de estadísticas. */
export function renderStats(profile, stats, { templates, tz, csrf = '' }) {
  const rangeLinks = [
    { value: '7', label: '7 días' },
    { value: '30', label: '30 días' },
    { value: 'all', label: 'Todo' },
  ]
    .map((range) => {
      const active = stats.range === range.value;
      return `<a class="tab" href="/stats?range=${range.value}"${active ? ' aria-current="page"' : ''}>${range.label}</a>`;
    })
    .join('\n      ');

  const lastClickValue = stats.lastClickAt ? formatShortDate(stats.lastClickAt, tz) : '—';
  const lastClickNote = stats.lastClickAt ? formatTime(stats.lastClickAt, tz) : 'Sin registros';

  const rows = stats.links.map((link) => linkRow(link, tz)).join('\n');

  const content = `    <header class="top">
      <div>
        <p class="eyebrow">Panel privado</p>
        <h1>Estadísticas</h1>
        <p class="sub">Clics registrados en <strong>${escapeHtml(profile.name)}</strong>.</p>
      </div>
      <div class="actions">
        <a class="button" href="/admin">Editar página</a>
        <a class="button" href="/stats.csv?range=${stats.range}">Descargar CSV</a>
        <a class="button" href="/" target="_blank" rel="noopener">Ver página ↗</a>
        <form method="post" action="/logout" class="logout-form">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="button" type="submit">Cerrar sesión</button>
        </form>
      </div>
    </header>

    <nav class="ranges" aria-label="Período">
      ${rangeLinks}
    </nav>

    <section class="cards" aria-label="Resumen">
      <article class="card">
        <p class="card-label">Total de clics</p>
        <p class="card-value">${formatNumber(stats.total)}</p>
        <p class="card-note">${escapeHtml(stats.rangeLabel)}</p>
      </article>
      <article class="card">
        <p class="card-label">Visitantes únicos</p>
        <p class="card-value">${formatNumber(stats.uniqueVisitors)}</p>
        <p class="card-note">IP anonimizada con sal</p>
      </article>
      <article class="card">
        <p class="card-label">Enlaces activos</p>
        <p class="card-value">${formatNumber(stats.activeLinks)}</p>
        <p class="card-note">Definidos en links.json</p>
      </article>
      <article class="card">
        <p class="card-label">Último clic</p>
        <p class="card-value">${escapeHtml(lastClickValue)}</p>
        <p class="card-note">${escapeHtml(lastClickNote)}</p>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Clics por enlace</h2>
        <span class="muted" style="font-size:.75rem">${escapeHtml(stats.rangeLabel)}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Enlace</th>
              <th scope="col" class="num">Clics</th>
              <th scope="col" class="num">%</th>
              <th scope="col">Último clic</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
    </section>

    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Actividad</h2>
          <span class="muted" style="font-size:.75rem">${stats.days.length} días · UTC</span>
        </div>
        <div class="panel-body">
${barsBlock(stats)}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Referentes</h2>
          <span class="muted" style="font-size:.75rem">Principales</span>
        </div>
        <div class="panel-body">
${referrersBlock(stats)}
        </div>
      </section>
    </div>`;

  const html = fill(templates.stats, {
    TITLE: escapeHtml(`Estadísticas · ${profile.name}`),
    CONTENT: content,
    TZ: escapeHtml(tz),
    GENERATED: escapeHtml(formatDateTime(new Date().toISOString(), tz)),
  });

  return { html };
}

/** Campos ocultos comunes a todos los formularios del panel. */
function adminHidden(csrf, version) {
  return `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="version" value="${escapeHtml(version)}">`;
}

function adminLinkRow(link, index, total, clicks, csrf, version) {
  const action = `/admin/links/${encodeURIComponent(link.slug)}`;
  const deleteUrl = `/admin/delete/${encodeURIComponent(link.slug)}`;
  const clickLabel = `${formatNumber(clicks)} ${clicks === 1 ? 'clic' : 'clics'}`;

  return `        <article class="link-item">
          <form method="post" action="${action}" class="link-form">
${adminHidden(csrf, version)}
            <div class="link-meta">
              <span class="position">${String(index + 1).padStart(2, '0')}</span>
              <span class="click-count">${clickLabel}</span>
              <a class="go-link" href="/go/${encodeURIComponent(link.slug)}" target="_blank" rel="noopener noreferrer">/go/${escapeHtml(link.slug)} ↗</a>
            </div>
            <div class="link-fields">
              <label class="field field-title">
                <span>Título</span>
                <input type="text" name="title" value="${escapeHtml(link.title)}" maxlength="120" required>
              </label>
              <label class="field field-url">
                <span>URL</span>
                <input type="text" name="url" value="${escapeHtml(link.url)}" maxlength="2048" inputmode="url" autocomplete="off" spellcheck="false" required>
              </label>
              <label class="field field-emoji">
                <span>Emoji</span>
                <input type="text" name="emoji" value="${escapeHtml(link.emoji)}" maxlength="16" autocomplete="off">
              </label>
              <label class="field field-slug">
                <span>Slug</span>
                <input type="text" name="slug" value="${escapeHtml(link.slug)}" maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" autocomplete="off" spellcheck="false" required>
              </label>
            </div>
            <div class="row-actions">
              <button class="button primary" type="submit">Guardar</button>
              <button class="button mini" type="submit" formaction="${action}/move" name="direction" value="up" aria-label="Subir ${escapeHtml(link.title)}" title="Subir"${index === 0 ? ' disabled' : ''}>↑</button>
              <button class="button mini" type="submit" formaction="${action}/move" name="direction" value="down" aria-label="Bajar ${escapeHtml(link.title)}" title="Bajar"${index === total - 1 ? ' disabled' : ''}>↓</button>
              <a class="button mini danger" href="${deleteUrl}" aria-label="Eliminar ${escapeHtml(link.title)}">Eliminar</a>
            </div>
          </form>
        </article>`;
}

/**
 * Renderiza el panel de administración.
 * `confirm` muestra la pantalla de confirmación antes de borrar un enlace.
 */
export function renderAdmin(
  profile,
  stats,
  {
    templates,
    csrf,
    version,
    avatarUrl = profile.avatar,
    notice = null,
    error = '',
    confirm = null,
  },
) {
  const clicksBySlug = new Map(
    (stats?.links ?? []).map((link) => [link.slug, link.clicks]),
  );

  const header = `    <header class="top">
      <div>
        <p class="eyebrow">Panel privado</p>
        <h1>Administración</h1>
        <p class="sub">Edita el perfil, el avatar y los enlaces de <strong>${escapeHtml(profile.name)}</strong>.</p>
      </div>
      <div class="actions">
        <a class="button" href="/admin/export">Descargar JSON</a>
        <a class="button" href="/stats">Estadísticas</a>
        <a class="button" href="/" target="_blank" rel="noopener">Ver página ↗</a>
        <form method="post" action="/logout" class="logout-form">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="button" type="submit">Cerrar sesión</button>
        </form>
      </div>
    </header>`;

  const alert = error
    ? `    <div class="alert bad" role="alert"><strong>No se pudo guardar.</strong> ${escapeHtml(error)}</div>`
    : notice
      ? `    <div class="alert good" role="status">${escapeHtml(notice)}</div>`
      : '';

  let body;

  if (confirm) {
    body = `    <section class="panel confirm">
      <div class="panel-head">
        <h2>Eliminar enlace</h2>
        <span class="muted">Esta acción no se puede deshacer desde el panel</span>
      </div>
      <div class="panel-body">
        <p class="confirm-question">¿Eliminar <strong>${escapeHtml(confirm.link.title)}</strong>?</p>
        <p class="muted">Se quitará <code>/go/${escapeHtml(confirm.link.slug)}</code> de la página. Los clics históricos se conservan en las estadísticas y se guarda una copia de <code>links.json</code> antes de borrar.</p>
        <form method="post" action="/admin/links/${encodeURIComponent(confirm.link.slug)}/delete" class="form">
${adminHidden(csrf, version)}
          <div class="form-actions">
            <button class="button danger" type="submit">Eliminar definitivamente</button>
            <a class="button" href="/admin">Cancelar</a>
          </div>
        </form>
      </div>
    </section>`;
  } else {
    const rows = profile.links
      .map((link, index) =>
        adminLinkRow(link, index, profile.links.length, clicksBySlug.get(link.slug) ?? 0, csrf, version),
      )
      .join('\n');

    body = `    <div class="layout">
      <section class="panel">
        <div class="panel-head">
          <h2>Perfil</h2>
          <span class="muted">Texto de la página pública</span>
        </div>
        <div class="panel-body">
          <form method="post" action="/admin/profile" class="form">
${adminHidden(csrf, version)}
            <div class="field-grid">
              <label class="field">
                <span>Nombre</span>
                <input type="text" name="name" value="${escapeHtml(profile.name)}" maxlength="120" required>
              </label>
              <label class="field">
                <span>Rol o profesión</span>
                <input type="text" name="role" value="${escapeHtml(profile.role)}" maxlength="160">
              </label>
            </div>
            <label class="field">
              <span>Bio</span>
              <textarea name="bio" rows="3" maxlength="320">${escapeHtml(profile.bio)}</textarea>
            </label>
            <div class="field-grid">
              <label class="field">
                <span>URL del sitio (Open Graph)</span>
                <input type="text" name="siteUrl" value="${escapeHtml(profile.siteUrl)}" maxlength="2048" inputmode="url" placeholder="https://links.ejemplo.com" autocomplete="off" spellcheck="false">
              </label>
              <label class="field">
                <span>Avatar (ruta o URL)</span>
                <input type="text" name="avatar" value="${escapeHtml(profile.avatar)}" maxlength="2048" inputmode="url" autocomplete="off" spellcheck="false">
              </label>
            </div>
            <p class="note">Si defines SITE_URL en .env, ese valor tiene prioridad sobre la URL del sitio.</p>
            <div class="form-actions">
              <button class="button primary" type="submit">Guardar perfil</button>
              <span class="muted">Al guardar se regenera la tarjeta Open Graph y el favicon.</span>
            </div>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Avatar</h2>
          <span class="muted">512 × 512 PNG</span>
        </div>
        <div class="panel-body avatar-panel">
          <img class="avatar-preview" src="${escapeHtml(avatarUrl)}" width="112" height="112" alt="Avatar actual de ${escapeHtml(profile.name)}">
          <form method="post" action="/admin/avatar" enctype="multipart/form-data" class="form">
${adminHidden(csrf, version)}
            <label class="field">
              <span>Nueva imagen</span>
              <input type="file" name="avatar" accept="image/jpeg,image/png,image/webp" required>
            </label>
            <button class="button primary" type="submit">Subir y recortar</button>
          </form>
          <p class="note">JPG, PNG o WebP de hasta 5 MB. Se recorta al centro, se convierte a PNG y se eliminan EXIF/GPS. También se actualiza la vista previa al compartir.</p>
        </div>
      </section>
    </div>

    <section class="panel links-panel">
      <div class="panel-head">
        <h2>Enlaces <span class="count">${profile.links.length}</span></h2>
        <span class="muted">Cambia el orden con ↑ ↓ · Los cambios se publican al guardar</span>
      </div>
      <div class="panel-body">
        <div class="link-list">
${rows}
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Agregar enlace</h2>
        <span class="muted">Se añade al final de la lista</span>
      </div>
      <div class="panel-body">
        <form method="post" action="/admin/links" class="link-form">
${adminHidden(csrf, version)}
          <div class="link-fields">
            <label class="field field-title">
              <span>Título</span>
              <input type="text" name="title" placeholder="GitHub" maxlength="120" required>
            </label>
            <label class="field field-url">
              <span>URL</span>
              <input type="text" name="url" placeholder="https://github.com/tu-usuario" maxlength="2048" inputmode="url" autocomplete="off" spellcheck="false" required>
            </label>
            <label class="field field-emoji">
              <span>Emoji</span>
              <input type="text" name="emoji" placeholder="🐙" maxlength="16" autocomplete="off">
            </label>
            <label class="field field-slug">
              <span>Slug</span>
              <input type="text" name="slug" placeholder="github" maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" autocomplete="off" spellcheck="false">
            </label>
          </div>
          <div class="row-actions">
            <button class="button primary" type="submit">Crear enlace</button>
            <span class="muted">Si dejas el slug vacío se genera desde el título.</span>
          </div>
        </form>
      </div>
    </section>`;
  }

  const content = `${header}
${alert}
${body}

    <footer class="foot">
      <p>Datos guardados en <code>links.json</code> · copias automáticas de los últimos 20 cambios.</p>
      <p>Versión ${escapeHtml(version.slice(0, 12))} · Los enlaces de ejemplo con “ejemplo” deben reemplazarse.</p>
    </footer>`;

  const html = fill(templates.admin, {
    TITLE: escapeHtml(confirm ? `Eliminar ${confirm.link.title} · Administración` : `Administración · ${profile.name}`),
    CONTENT: content,
  });

  return { html };
}

/** Renderiza el formulario de acceso privado. */
export function renderLogin(templates, { csrf = '', next = '/admin', user = '', error = '', notice = '' } = {}) {
  const alert = error
    ? `      <div class="alert bad" role="alert">${escapeHtml(error)}</div>`
    : notice
      ? `      <div class="alert good" role="status">${escapeHtml(notice)}</div>`
      : '';

  const html = fill(templates.login, {
    TITLE: 'Acceso privado',
    CSRF: escapeHtml(csrf),
    NEXT: escapeHtml(next),
    USER: escapeHtml(user),
    ALERT: alert,
  });

  return { html };
}

/** Renderiza una página de error simple. */
export function renderError(templates, { status, title, message }) {
  return fill(templates.error, {
    TITLE: escapeHtml(title),
    CODE: `HTTP ${status}`,
    MESSAGE: escapeHtml(message),
  });
}
