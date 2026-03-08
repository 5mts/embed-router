/**
 * Route Matcher
 * 
 * Compiles route path patterns (e.g. "/:section/candidate/:slug") into
 * regex matchers and provides param extraction + path building.
 * 
 * Pattern syntax:
 *   :paramName  - matches one URL segment (everything except /)
 *   *           - wildcard, matches rest of path (must be last)
 *   literal     - matches exact text
 * 
 * Examples:
 *   /                                → matches root only
 *   /:section                        → matches /city-council, extracts { section: 'city-council' }
 *   /:section/candidate/:candidate   → matches /city-council/candidate/harper
 *   /:section/:group/topic/:topic    → matches /city-council/district-1/topic/taxes
 */

/**
 * Compile a single route definition into a matcher object.
 * 
 * @param {{ path: string, name?: string }} route
 * @returns {{ regex: RegExp, paramNames: string[], name: string|null, path: string, build: (params: object) => string }}
 */
export function compileRoute(route) {
  const { path, name = null } = route;
  const paramNames = [];
  let hasWildcard = false;

  // Build regex from path pattern
  const regexParts = path
    .split('/')
    .filter(Boolean) // remove empty segments from leading/trailing slashes
    .map((segment) => {
      if (segment === '*') {
        hasWildcard = true;
        paramNames.push('_wildcard');
        return '(.+)';
      }
      if (segment.startsWith(':')) {
        const paramName = segment.slice(1);
        if (!paramName) {
          throw new Error(`Empty param name in route pattern: ${path}`);
        }
        paramNames.push(paramName);
        return '([^/]+)';
      }
      // Literal segment - escape regex special chars
      return escapeRegex(segment);
    });

  // Build the full regex
  // ^\/segment1\/segment2\/?$ with optional trailing slash
  const regexStr = regexParts.length === 0
    ? '^\\/?$'  // root route: matches "" or "/"
    : '^\\/' + regexParts.join('\\/') + (hasWildcard ? '$' : '\\/?$');

  const regex = new RegExp(regexStr, 'i'); // case-insensitive matching

  /**
   * Build a path string from named params.
   * @param {object} params
   * @returns {string}
   */
  function build(params = {}) {
    const built = path.replace(/:([^/]+)/g, (_, paramName) => {
      const value = params[paramName];
      if (value == null) {
        throw new Error(`Missing param "${paramName}" for route "${name || path}"`);
      }
      return encodeURIComponent(value);
    });
    // Handle wildcard
    if (hasWildcard && params._wildcard) {
      return built.replace('*', params._wildcard);
    }
    return built;
  }

  return { regex, paramNames, name, path, build };
}

/**
 * Compile an array of route definitions into matchers.
 * Routes are matched in order — first match wins.
 * 
 * @param {Array<{ path: string, name?: string }>} routes
 * @returns {Array<ReturnType<typeof compileRoute>>}
 */
export function compileRoutes(routes) {
  return routes.map(compileRoute);
}

/**
 * Match a path string against compiled routes.
 * Returns the first match with extracted params, or null.
 * 
 * @param {Array<ReturnType<typeof compileRoute>>} compiledRoutes
 * @param {string} path - normalized path string (e.g. "/city-council/candidate/harper")
 * @returns {{ name: string|null, path: string, params: object, pattern: string } | null}
 */
export function matchRoute(compiledRoutes, path) {
  for (const route of compiledRoutes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return {
        name: route.name,
        path,
        params,
        pattern: route.path,
      };
    }
  }
  return null;
}

/**
 * Find a compiled route by name.
 * 
 * @param {Array<ReturnType<typeof compileRoute>>} compiledRoutes
 * @param {string} name
 * @returns {ReturnType<typeof compileRoute> | undefined}
 */
export function findRouteByName(compiledRoutes, name) {
  return compiledRoutes.find((r) => r.name === name);
}

/**
 * Build a path from a route name and params.
 * 
 * @param {Array<ReturnType<typeof compileRoute>>} compiledRoutes
 * @param {string} name
 * @param {object} params
 * @returns {string}
 */
export function buildPath(compiledRoutes, name, params) {
  const route = findRouteByName(compiledRoutes, name);
  if (!route) {
    throw new Error(`Unknown route name: "${name}"`);
  }
  return route.build(params);
}

// --- Utilities ---

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
