/**
 * Request body handling.
 *
 * `readRawBody` is required for webhook signature verification: an HMAC can only
 * be checked against the exact bytes the sender signed. Vercel's Node runtime
 * parses JSON bodies, but it also restores the raw stream so it can be replayed
 * — `readRawBody` uses that. If the stream cannot be replayed (a different
 * runtime, or a platform that has already consumed it), we fall back to the
 * parsed body re-serialised, and the caller decides whether that is good enough.
 */

import { app } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';

/**
 * Read the request body as a Buffer without assuming it has been consumed.
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, { limit = app.maxBodyBytes } = {}) {
  // Prefer a body the platform already gave us as raw bytes.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');

  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        throw new AppError(Codes.PAYLOAD_TOO_LARGE, undefined, 413, {
          details: { limitBytes: limit },
        });
      }
      chunks.push(buffer);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // The stream was already consumed by the platform. Signal that with an
    // empty result so the caller can fall back.
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks);
}

/**
 * The best available representation of the raw request body.
 * @returns {{raw: Buffer, exact: boolean}}
 */
export async function rawBodyBestEffort(req, options = {}) {
  const raw = await readRawBody(req, options);
  if (raw.length > 0) return { raw, exact: true };

  if (Buffer.isBuffer(req.body)) return { raw: req.body, exact: true };
  if (typeof req.body === 'string') return { raw: Buffer.from(req.body, 'utf8'), exact: true };
  if (req.body && typeof req.body === 'object') {
    // Re-serialised, not byte-identical to what the sender signed.
    return { raw: Buffer.from(JSON.stringify(req.body), 'utf8'), exact: false };
  }
  return { raw: Buffer.alloc(0), exact: true };
}

/**
 * Parse a JSON request body.
 *
 * @param {object} req
 * @param {object} [options]
 * @param {boolean} [options.allowEmpty=true] treat an empty body as `{}`
 * @param {number} [options.limit]
 */
export async function parseJsonBody(req, { allowEmpty = true, limit = app.maxBodyBytes } = {}) {
  const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = await readRawBody(req, { limit });
  if (raw.length === 0) {
    if (allowEmpty) return {};
    throw new AppError(Codes.VALIDATION_ERROR, 'A request body is required.');
  }
  if (raw.length > limit) {
    throw new AppError(Codes.PAYLOAD_TOO_LARGE, undefined, 413, { details: { limitBytes: limit } });
  }
  if (contentType && contentType !== 'application/json') {
    throw new AppError(Codes.UNSUPPORTED_MEDIA_TYPE, 'Send application/json.', 415);
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(Codes.VALIDATION_ERROR, 'The request body is not valid JSON.');
  }
}

/**
 * Read a multipart/form-data body and split it into fields and files.
 *
 * A small, dependency-free multipart parser: it handles the boundary framing
 * and the headers each part needs, and nothing more. Bodies are already capped
 * by `app.maxBodyBytes` before this runs.
 *
 * @returns {Promise<{fields: Record<string,string>, files: object[]}>}
 */
export async function parseMultipartBody(req, { limit = app.maxBodyBytes } = {}) {
  const contentType = String(req.headers?.['content-type'] || '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    throw new AppError(Codes.UNSUPPORTED_MEDIA_TYPE, 'A multipart boundary is required.', 415);
  }
  const boundary = `--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`;

  const raw = await readRawBody(req, { limit });
  if (raw.length === 0) throw new AppError(Codes.VALIDATION_ERROR, 'The upload was empty.');

  const fields = {};
  const files = [];

  const boundaryBuffer = Buffer.from(boundary, 'utf8');
  let position = raw.indexOf(boundaryBuffer);
  if (position === -1) {
    throw new AppError(Codes.VALIDATION_ERROR, 'The upload was malformed.');
  }

  while (position !== -1) {
    const partStart = position + boundaryBuffer.length;
    if (raw.slice(partStart, partStart + 2).toString('utf8') === '--') break; // closing boundary

    const headerEnd = raw.indexOf('\r\n\r\n', partStart);
    if (headerEnd === -1) break;

    const headerText = raw.slice(partStart, headerEnd).toString('utf8');
    const nextBoundary = raw.indexOf(boundaryBuffer, headerEnd);
    if (nextBoundary === -1) break;

    // Trim the CRLF that precedes the next boundary.
    const content = raw.slice(headerEnd + 4, nextBoundary - 2);

    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headerText)?.[1] || '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
    const mimeType = (typeMatch?.[1] || 'application/octet-stream').trim();

    if (name) {
      if (filename !== undefined) {
        files.push({ field: name, filename, mimeType, data: content, size: content.length });
      } else {
        fields[name] = content.toString('utf8');
      }
    }

    position = nextBoundary;
  }

  return { fields, files };
}