/**
 * Path normalization and validation.
 * 
 * All route paths pass through normalization before matching or storage.
 * This ensures consistent behavior regardless of how the path was entered
 * (URL, navigate() call, legacy migration, etc.).
 */

const MAX_PATH_LENGTH = 500;

/**
 * Default path normalizer.
 * - Ensures leading slash
 * - Lowercases (our slugs are always lowercase)
 * - Strips trailing slash (except for root "/")
 * - Collapses multiple slashes
 * - Rejects paths over MAX_PATH_LENGTH
 * 
 * @param {string} path
 * @returns {string|null} normalized path, or null if invalid
 */
export function normalizePath(path) {
  if (typeof path !== 'string') return null;
  if (path.length > MAX_PATH_LENGTH) return null;

  let normalized = path
    .toLowerCase()
    .replace(/\/+/g, '/')   // collapse multiple slashes
    .replace(/\/$/, '');     // strip trailing slash

  // Ensure leading slash
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // Root path edge case
  if (normalized === '') {
    normalized = '/';
  }

  return normalized;
}

/**
 * Check if a path looks safe (no XSS, no protocol injection, etc.)
 * This is a basic sanity check — route matching provides further validation.
 * 
 * @param {string} path
 * @returns {boolean}
 */
export function isPathSafe(path) {
  if (typeof path !== 'string') return false;
  if (path.length > MAX_PATH_LENGTH) return false;

  // Block anything that looks like a protocol or script injection
  if (/^[a-z]+:/i.test(path) && !path.startsWith('/')) return false;
  if (/<|>|javascript:|data:|vbscript:/i.test(path)) return false;

  return true;
}
