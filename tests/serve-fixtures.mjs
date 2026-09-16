import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const PORT = 3000;

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const ALLOWED_FIXTURES = new Set([
  'sample-application.html',
  'traditional-form.html',
  'aria-labels.html',
  'checkbox-radio.html',
  'sensitive-fields.html',
  'unlabeled-fields.html',
  'search-utility-page.html',
  'app-with-search.html',
  'empty-and-unlabeled.html',
  'two-unrelated-forms.html',
]);

/**
 * Resolves an incoming request URL to a safe fixture file path.
 * Strips query parameters and hashes, normalizes path, and guards against directory traversal
 * by checking against an explicit allowlist of known fixtures.
 *
 * @param {string} rawUrl - The request URL (e.g. "/sample-application.html?foo=bar")
 * @param {string} fixturesDir - Root fixtures directory
 * @returns {string | null} Absolute path to valid fixture file, or null if denied / invalid
 */
export function resolveFixturePath(rawUrl, fixturesDir = FIXTURES_DIR) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  // Reject path traversal attempts immediately
  if (
    rawUrl.includes('..') ||
    rawUrl.includes('/.') ||
    rawUrl.includes('\\.') ||
    rawUrl.includes('\0')
  ) {
    return null;
  }

  let pathname = '/';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  // Default root / to sample-application.html
  if (pathname === '/' || pathname === '') {
    pathname = '/sample-application.html';
  }

  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('..') || decodedPath.includes('\0')) {
    return null;
  }

  const cleanName = path.basename(decodedPath);
  if (!ALLOWED_FIXTURES.has(cleanName)) {
    return null;
  }

  if (decodedPath !== `/${cleanName}`) {
    return null;
  }

  const resolvedPath = path.resolve(fixturesDir, cleanName);
  const normalizedFixturesDir = path.normalize(fixturesDir) + path.sep;
  if (!resolvedPath.startsWith(normalizedFixturesDir)) {
    return null;
  }

  return resolvedPath;
}

/**
 * Request handler for the test fixture server.
 */
export function handleFixtureRequest(req, res, fixturesDir = FIXTURES_DIR) {
  const filePath = resolveFixturePath(req.url, fixturesDir);

  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access denied');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(
      'Fixture not found. Available fixtures: /sample-application.html, /traditional-form.html, /aria-labels.html, /checkbox-radio.html, /sensitive-fields.html, /unlabeled-fields.html',
    );
  }
}

// Start server if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = http.createServer((req, res) => handleFixtureRequest(req, res));
  server.listen(PORT, () => {
    console.log(
      `SubmitLog fixture server listening at http://localhost:${PORT}/sample-application.html`,
    );
  });
}
