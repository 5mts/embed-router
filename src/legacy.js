/**
 * Legacy URL Migrator
 * 
 * Handles backwards compatibility with old embed URLs that used individual
 * query parameters (e.g. ?section=city-council&candidate=harper) instead
 * of the new single-path format (?route=/city-council/candidate/harper).
 * 
 * Legacy route definitions are processed in order — most specific first
 * (longest params array wins). The first definition where ALL required
 * params are present in the URL wins.
 * 
 * Two formats supported:
 * 
 * 1. Path template (common case) - params auto-substituted:
 *    { params: ['section', 'candidate'], path: '/:section/candidate/:candidate' }
 * 
 * 2. Function (complex mappings):
 *    { params: ['section', 'candidate'], toPath: (p) => `/${p.section}/candidate/${p.candidate}` }
 */

/**
 * Attempt to migrate legacy query params to a route path.
 * 
 * @param {URLSearchParams} searchParams - current URL's query params
 * @param {Array<{ params: string[], path?: string, toPath?: (p: object) => string }>} legacyRoutes
 * @param {string} routeParam - the modern route param name (to skip if already present)
 * @returns {{ path: string, matchedParams: string[] } | null}
 */
export function migrateLegacyUrl(searchParams, legacyRoutes, routeParam) {
  if (!legacyRoutes || legacyRoutes.length === 0) return null;

  // If the modern route param is already present, no migration needed
  if (searchParams.has(routeParam) && searchParams.get(routeParam)) {
    return null;
  }

  for (const legacy of legacyRoutes) {
    const { params: requiredParams, path: pathTemplate, toPath } = legacy;

    if (!requiredParams || requiredParams.length === 0) continue;

    // Check if ALL required params are present and non-empty
    const values = {};
    let allPresent = true;

    for (const param of requiredParams) {
      const value = searchParams.get(param);
      if (value == null || value === '') {
        allPresent = false;
        break;
      }
      values[param] = value;
    }

    if (!allPresent) continue;

    // Build the path
    let path;
    if (typeof toPath === 'function') {
      path = toPath(values);
    } else if (typeof pathTemplate === 'string') {
      path = pathTemplate.replace(/:([^/]+)/g, (_, paramName) => {
        if (values[paramName] == null) {
          throw new Error(
            `Legacy route template references ":${paramName}" but it's not in the params list: [${requiredParams.join(', ')}]`
          );
        }
        return encodeURIComponent(values[paramName]);
      });
    } else {
      throw new Error(
        'Legacy route must have either "path" (template string) or "toPath" (function)'
      );
    }

    return { path, matchedParams: requiredParams };
  }

  return null;
}

/**
 * Remove legacy params from a URLSearchParams object.
 * Used after migration to clean up the URL.
 * 
 * @param {URLSearchParams} searchParams
 * @param {string[]} paramsToRemove
 * @returns {URLSearchParams} new URLSearchParams with legacy params removed
 */
export function removeLegacyParams(searchParams, paramsToRemove) {
  const cleaned = new URLSearchParams(searchParams);
  for (const param of paramsToRemove) {
    cleaned.delete(param);
  }
  return cleaned;
}
