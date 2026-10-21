import Busboy from 'busboy';
import sharp from 'sharp';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'El formulario es demasiado grande.');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Lee un formulario urlencoded o multipart (solo un archivo llamado "avatar").
 * No usa JavaScript en el navegador: acepta el <input type="file"> nativo.
 */
export async function readForm(req, { maxFields = 40, maxFileBytes = 5 * 1024 * 1024 } = {}) {
  const contentType = String(req.headers['content-type'] ?? '');

  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const body = await readBody(req, 256 * 1024);
    const fields = Object.fromEntries(new URLSearchParams(body));
    return { fields, file: null };
  }

  if (!contentType.startsWith('multipart/form-data')) {
    throw new HttpError(415, 'Formato de formulario no soportado.');
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fields: maxFields,
          fieldSize: 32 * 1024,
          files: 1,
          fileSize: maxFileBytes,
          parts: maxFields + 2,
        },
      });
    } catch {
      reject(new HttpError(400, 'El formulario multipart no es válido.'));
      return;
    }

    const fields = {};
    let file = null;
    let tooLarge = false;

    parser.on('field', (name, value, info) => {
      if (info.valueTruncated) tooLarge = true;
      fields[name] = value;
    });

    parser.on('file', (name, stream, info) => {
      if (name !== 'avatar' || file) {
        stream.resume();
        return;
      }

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on('limit', () => {
        tooLarge = true;
      });
      stream.on('end', () => {
        file = {
          buffer: Buffer.concat(chunks),
          size,
          filename: info.filename,
          mimeType: info.mimeType,
        };
      });
    });

    parser.on('filesLimit', () => {
      tooLarge = true;
    });
    parser.on('error', () => {
      reject(new HttpError(400, 'No se pudo leer el archivo subido.'));
    });
    parser.on('close', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'La imagen supera el máximo de 5 MB.'));
        return;
      }
      resolve({ fields, file });
    });

    req.on('aborted', () => {
      reject(new HttpError(400, 'La carga se interrumpió.'));
    });
    req.on('error', () => {
      reject(new HttpError(400, 'No se pudo leer el formulario.'));
    });

    req.pipe(parser);
  });
}

/**
 * Valida y normaliza la foto: recorte cuadrado 512×512, PNG y sin metadatos.
 * sharp descarta EXIF/GPS por defecto al crear una imagen nueva.
 */
export async function processAvatar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Selecciona una imagen.');
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new HttpError(415, 'El archivo no es una imagen válida.');
  }

  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new HttpError(
      415,
      'Formato no permitido. Usa una imagen JPG, PNG o WebP (no SVG).',
    );
  }

  try {
    return await sharp(buffer, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    throw new HttpError(422, 'No se pudo procesar la imagen. Prueba con otra foto.');
  }
}
