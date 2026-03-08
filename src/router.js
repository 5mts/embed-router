/**
 * QueryRouter — Embeddable client-side router
 * 
 * A routing library designed for widgets embedded via <script> tags in arbitrary
 * CMS environments. Supports two URL modes:
 * 
 *   - 'hash': routes stored in location.hash (#/path/to/page)
 *   - 'query': routes stored in a query param (?route=/path/to/page)
 * 
 * Query mode exists because some host SPAs use hash routing themselves, making
 * hash-based embed routing impossible. The router handles the complexities of
 * being a "guest" on someone else's page:
 * 
 *   - Preserves host query params when writing ours
 *   - Writes backup route to history.state (survives host URL clobbering)
 *   - Polls for external URL changes (catches host pushState we can't listen for)
 *   - Migrates legacy param-based URLs to the new path format
 *   - Provides AbortSignals that cancel on navigation (for data fetching)
 * 
 * ARCHITECTURE:
 * 
 *   Internal state is the source of truth, not the URL.
 *   The URL is the persistence layer — written as a side effect of navigation
 *   and read on initialization / back-forward. This eliminates timing issues
 *   where the URL hasn't updated yet but the app needs to render.
 * 
 * USAGE:
 * 
 *   const router = new QueryRouter({
 *     mode: 'query',
 *     routes: [
 *       { path: '/', name: 'home' },
 *       { path: '/:section/candidate/:candidate', name: 'candidate' },
 *     ],
 *     legacyRoutes: [
 *       { params: ['section', 'candidate'], path: '/:section/candidate/:candidate' },
 *     ],
 *   });
 * 
 *   router.on('route', ({ route, previous, source }) => {
 *     console.log('Navigate to:', route.path, route.params);
 *   });
 * 
 *   router.start();
 *   // later...
 *   router.navigate('/city-council/candidate/harper');
 *   // or by name:
 *   router.navigate('candidate', { section: 'city-council', candidate: 'harper' });
 *   // cleanup:
 *   router.destroy();
 */

import { HashStrategy } from './hash.js';
import { QueryStringStrategy } from './query.js';
import { compileRoutes, matchRoute, buildPath } from './matcher.js';
import { migrateLegacyUrl, removeLegacyParams } from './legacy.js';
import { normalizePath, isPathSafe } from './normalize.js';
import { Emitter } from './emitter.js';

/**
 * Capture the URL as early as possible — before any host SPA code can modify it.
 * Call this at the top of your script, before async work or config loading.
 * Pass the result as `initialUrl` to the QueryRouter constructor.
 * 
 * @returns {{ search: string, hash: string, href: string }}
 */
export function snapshotUrl() {
  if (typeof window === 'undefined') {
    return { search: '', hash: '', href: '' };
  }
  return {
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
  };
}

// --- Default not-found route result ---
const NOT_FOUND = Object.freeze({
  name: null,
  path: null,
  params: {},
  pattern: null,
  notFound: true,
});

export class QueryRouter {
  /**
   * @param {object} config
   * @param {'query'|'hash'} config.mode - URL strategy
   * @param {Array<{ path: string, name?: string }>} config.routes - route definitions (order matters)
   * @param {string} [config.param='route'] - query param name (query mode only)
   * @param {string|null} [config.id=null] - multi-embed prefix, e.g. 'a' → 'a.route'
   * @param {'push'|'replace'} [config.historyMode='push'] - default history behavior
   * @param {string} [config.defaultRoute='/'] - fallback when no route matches
   * @param {Array<{ params: string[], path?: string, toPath?: Function }>} [config.legacyRoutes] - legacy URL migration
   * @param {number} [config.pollInterval=100] - ms between URL change checks
   * @param {boolean} [config.debug=false] - log routing decisions to console
   * @param {{ search: string, hash: string }} [config.initialUrl] - from snapshotUrl()
   * @param {Function} [config.normalizeRoute] - custom path normalizer (receives string, returns string|null)
   * @param {Function} [config.onHostInterference] - called if host strips our query param
   */
  constructor(config) {
    if (typeof window === 'undefined') {
      throw new Error('[embed-router] QueryRouter requires a browser environment');
    }

    // --- Config ---
    this._config = {
      mode: config.mode || 'query',
      param: config.param || 'route',
      id: config.id || null,
      historyMode: config.historyMode || 'push',
      defaultRoute: config.defaultRoute || '/',
      pollInterval: config.pollInterval ?? 100,
      debug: config.debug || false,
      normalizeRoute: config.normalizeRoute || normalizePath,
      onHostInterference: config.onHostInterference || null,
    };

    // --- State key for history.state (namespaced if multi-embed) ---
    const stateKey = this._config.id
      ? `__er_${this._config.id}`
      : '__embedRoute';

    // --- Strategy ---
    const strategyConfig = {
      param: this._config.param,
      id: this._config.id,
      stateKey,
      debug: this._config.debug,
    };

    this._strategy = this._config.mode === 'hash'
      ? new HashStrategy(strategyConfig)
      : new QueryStringStrategy(strategyConfig);

    // --- Route compilation ---
    if (!config.routes || config.routes.length === 0) {
      throw new Error('[embed-router] At least one route must be defined');
    }
    this._compiledRoutes = compileRoutes(config.routes);
    this._legacyRoutes = config.legacyRoutes || [];

    // --- Events ---
    this._emitter = new Emitter();

    // --- Navigation state ---
    this._currentRoute = NOT_FOUND;
    this._generation = 0;           // incremented on each navigation for stale-check
    this._abortController = null;   // current navigation's AbortController
    this._lastWatchValue = null;    // for polling change detection
    this._started = false;
    this._hostInterferenceDetected = false;
    this._displaced = false;

    // --- Bound handlers (so we can remove them on destroy) ---
    this._onPopState = this._handlePopState.bind(this);
    this._onHashChange = this._handleHashChange.bind(this);
    this._pollTimerId = null;

    // --- Determine initial route (as early as possible) ---
    this._initialUrl = config.initialUrl || null;
    this._resolveInitialRoute();

    this._log('Constructed', {
      mode: this._config.mode,
      initialRoute: this._currentRoute,
    });
  }

  // ===== PUBLIC API =====

  /**
   * Start listening for URL changes and emit the initial route event.
   * Call this after subscribing to 'route' events.
   */
  start() {
    if (this._started) return;
    this._started = true;

    // Attach event listeners
    for (const event of this._strategy.events) {
      if (event === 'popstate') {
        window.addEventListener('popstate', this._onPopState);
      } else if (event === 'hashchange') {
        window.addEventListener('hashchange', this._onHashChange);
      }
    }

    // Start polling
    this._lastWatchValue = this._strategy.getWatchValue();
    if (this._config.pollInterval > 0) {
      this._pollTimerId = setInterval(
        () => this._poll(),
        this._config.pollInterval
      );
    }

    // Emit initial route
    this._emitter.emit('route', {
      route: this._currentRoute,
      previous: null,
      source: 'init',
      state: null,
    });

    this._log('Started');
  }

  /**
   * Navigate to a new route.
   * 
   * Accepts either:
   *   - A path string: navigate('/city-council/candidate/harper')
   *   - A route name + params: navigate('candidate', { section: 'city-council', candidate: 'harper' })
   * 
   * @param {string} pathOrName - path string or route name
   * @param {object} [params] - if first arg is a route name, the params to fill in
   * @param {object} [options]
   * @param {'push'|'replace'} [options.historyMode] - override default history mode for this navigation
   * @returns {boolean} true if navigation occurred, false if deduped
   */
  navigate(pathOrName, params, options = {}) {
    let path;

    if (params && typeof params === 'object' && !Array.isArray(params)) {
      // Distinguish between route params and options.
      // If the object has 'historyMode' it's an options object, not route params.
      // If pathOrName starts with '/' it's a path, so second arg must be options.
      const isOptions = 'historyMode' in params || 'state' in params || pathOrName.startsWith('/');
      if (isOptions) {
        path = pathOrName;
        options = params;
      } else {
        // Treat as named route: navigate('candidate', { section: 'x', candidate: 'y' })
        path = buildPath(this._compiledRoutes, pathOrName, params);
      }
    } else {
      path = pathOrName;
    }

    // Normalize
    const normalized = this._normalize(path);
    if (!normalized) {
      this._log('Navigation blocked: invalid path', path);
      return false;
    }

    // Deduplicate
    if (normalized === this._currentRoute.path) {
      this._log('Navigation deduped (same path)', normalized);
      return false;
    }

    // Match route
    const matched = matchRoute(this._compiledRoutes, normalized);
    const route = matched || { ...NOT_FOUND, path: normalized };

    // Increment generation and create new abort controller
    this._generation++;
    const gen = this._generation;
    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();

    // Update internal state FIRST (sync, before pushState)
    const previous = this._currentRoute;
    this._currentRoute = route;

    // Emit event (sync — Preact will re-render immediately)
    const navState = options.state || null;
    this._emitter.emit('route', { route, previous, source: 'navigate', state: navState });

    // Write to URL
    const historyMode = options.historyMode || this._config.historyMode;
    this._strategy.write(normalized, historyMode);
    this._lastWatchValue = this._strategy.getWatchValue();

    this._log('Navigated', { path: normalized, route: route.name, historyMode, gen });

    // Verify param survived (query mode only, defense in depth)
    if (this._strategy.needsInterferenceDetection) {
      setTimeout(() => {
        if (this._generation !== gen) return; // stale check
        const { survived } = this._strategy.verify(normalized);
        if (!survived) {
          this._hostInterferenceDetected = true;
          this._log('⚠️ Host interference detected: param was stripped after pushState');
          this._config.onHostInterference?.({ path: normalized });
        }
      }, 60);
    }

    return true;
  }

  /**
   * Get the current route (synchronous).
   * @returns {{ name: string|null, path: string, params: object, pattern: string|null, notFound?: boolean }}
   */
  getRoute() {
    return this._currentRoute;
  }

  /**
   * Get an AbortSignal that is cancelled when the next navigation occurs.
   * Use this for data fetching:
   * 
   *   fetch(url, { signal: router.getAbortSignal() })
   * 
   * @returns {AbortSignal}
   */
  getAbortSignal() {
    if (!this._abortController) {
      this._abortController = new AbortController();
    }
    return this._abortController.signal;
  }

  /**
   * Get the current navigation generation number.
   * Useful for manual stale-checking when AbortSignal isn't practical.
   * 
   *   const gen = router.getGeneration();
   *   const data = await fetchData();
   *   if (router.getGeneration() !== gen) return; // stale
   * 
   * @returns {number}
   */
  getGeneration() {
    return this._generation;
  }

  /**
   * Build a URL string for a given path or route name.
   * This is what <Link> components use for the href attribute.
   * 
   * @param {string} pathOrName
   * @param {object} [params]
   * @returns {string} full URL suitable for an <a href>
   */
  buildUrl(pathOrName, params) {
    let path;
    if (params) {
      path = buildPath(this._compiledRoutes, pathOrName, params);
    } else {
      path = pathOrName;
    }

    const normalized = this._normalize(path) || this._config.defaultRoute;

    if (this._config.mode === 'hash') {
      return '#' + normalized;
    }

    // Query mode: build URL preserving existing params
    const url = new URL(window.location.href);
    const paramName = this._strategy.param;
    url.searchParams.set(paramName, normalized);
    // Return relative URL (path + search + hash)
    return url.pathname + url.search + url.hash;
  }

  /**
   * Subscribe to route change events.
   * 
   * @param {'route'} event
   * @param {(data: { route: object, previous: object|null, source: string }) => void} fn
   * @returns {() => void} unsubscribe function
   */
  on(event, fn) {
    return this._emitter.on(event, fn);
  }

  /**
   * Unsubscribe from events.
   * @param {'route'} event
   * @param {Function} fn
   */
  off(event, fn) {
    this._emitter.off(event, fn);
  }

  /**
   * Full cleanup. Removes all event listeners, clears polling interval,
   * aborts in-flight work, and removes all subscribers.
   * 
   * Call this when the embed is being unmounted/destroyed.
   */
  destroy() {
    this._started = false;

    // Remove DOM event listeners
    window.removeEventListener('popstate', this._onPopState);
    window.removeEventListener('hashchange', this._onHashChange);

    // Stop polling
    if (this._pollTimerId != null) {
      clearInterval(this._pollTimerId);
      this._pollTimerId = null;
    }

    // Abort any in-flight work
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Clear all event subscribers
    this._emitter.removeAll();

    this._log('Destroyed');
  }

  // ===== PRIVATE =====

  /**
   * Resolve the initial route on construction.
   * Order of precedence:
   *   1. URL snapshot (if provided) or current URL
   *   2. history.state backup
   *   3. Legacy URL migration
   *   4. Default route
   */
  _resolveInitialRoute() {
    let path = null;
    let source = 'default';

    // 1. Try reading from URL (snapshot or current)
    if (this._initialUrl) {
      // Parse the snapshot to extract our route
      path = this._readFromSnapshot(this._initialUrl);
      if (path) source = 'url-snapshot';
    }

    if (!path) {
      path = this._strategy.read();
      if (path) source = 'url';
    }

    // 2. Try history.state backup
    if (!path) {
      path = this._strategy.readFromState();
      if (path) source = 'history-state';
    }

    // 3. Try legacy URL migration
    if (!path) {
      const searchStr = this._initialUrl?.search || window.location.search;
      const searchParams = new URLSearchParams(searchStr);
      const paramName = this._strategy instanceof QueryStringStrategy
        ? this._strategy.param
        : 'route';

      const migration = migrateLegacyUrl(searchParams, this._legacyRoutes, paramName);
      if (migration) {
        path = migration.path;
        source = 'legacy-migration';

        // Rewrite URL to new format (replaceState)
        this._performLegacyMigration(migration);
      }
    }

    // Normalize
    const normalized = path ? this._normalize(path) : null;
    const finalPath = normalized || this._config.defaultRoute;

    // Match against route table
    const matched = matchRoute(this._compiledRoutes, finalPath);
    this._currentRoute = matched || { ...NOT_FOUND, path: finalPath };

    // If we resolved from history.state but URL doesn't have our param,
    // write it to URL so the user sees the correct URL and can share it
    if (source === 'history-state') {
      try {
        this._strategy.write(finalPath, 'replace');
      } catch (e) {
        this._log('Failed to restore URL from history.state', e);
      }
    }

    this._log('Initial route resolved', { path: finalPath, source, matched: !!matched });
  }

  /**
   * Read our route from a URL snapshot.
   * @param {{ search: string, hash: string }} snapshot
   * @returns {string|null}
   */
  _readFromSnapshot(snapshot) {
    if (this._config.mode === 'hash') {
      const hash = snapshot.hash;
      if (!hash || hash === '#') return null;
      const path = hash.slice(1);
      return path.startsWith('/') ? path : '/' + path;
    }

    // Query mode
    const params = new URLSearchParams(snapshot.search);
    const paramName = this._strategy.param;
    const value = params.get(paramName);
    if (!value) return null;
    return value.startsWith('/') ? value : '/' + value;
  }

  /**
   * Perform legacy URL migration: rewrite URL to new format.
   */
  _performLegacyMigration(migration) {
    try {
      const url = new URL(window.location.href);
      const cleaned = removeLegacyParams(url.searchParams, migration.matchedParams);

      // Build new URL with cleaned params + our route param
      const newUrl = new URL(window.location.href);
      newUrl.search = cleaned.toString();
      this._strategy.write(migration.path, 'replace');

      // Now remove the legacy params from the URL that strategy.write created
      const finalUrl = new URL(window.location.href);
      for (const param of migration.matchedParams) {
        finalUrl.searchParams.delete(param);
      }
      window.history.replaceState(window.history.state, '', finalUrl.toString());

      this._log('Legacy URL migrated', {
        from: migration.matchedParams,
        to: migration.path,
      });
    } catch (e) {
      this._log('Legacy migration failed (non-fatal)', e);
    }
  }

  /**
   * Handle popstate events (back/forward button).
   * Deferred by one tick to let the host SPA settle first.
   */
  _handlePopState(event) {
    // Defer to let host SPA's own popstate handlers run first.
    // Always force re-evaluation — popstate means the user navigated browser
    // history, which is always significant even if the path looks unchanged
    // (they may have gone away and come back).
    setTimeout(() => {
      this._reconcile(event, 'popstate', /* force */ true);
    }, 0);
  }

  /**
   * Handle hashchange events (hash mode).
   */
  _handleHashChange() {
    this._reconcile(null, 'hashchange');
  }

  /**
   * Poll for URL changes that we can't detect via events.
   * This catches: host SPA doing pushState, programmatic URL changes, etc.
   */
  _poll() {
    const current = this._strategy.getWatchValue();
    if (current !== this._lastWatchValue) {
      this._lastWatchValue = current;
      this._reconcile(null, 'poll');
    }
  }

  /**
   * Central reconciliation — all URL change detection channels funnel here.
   * Reads the URL, deduplicates, and emits if the route has changed.
   * 
   * @param {PopStateEvent|null} event
   * @param {'popstate'|'hashchange'|'poll'} source
   */
  _reconcile(event, source, force = false) {
    // Try URL first, then history.state as backup
    let path = this._strategy.read();
    if (!path && source === 'popstate') {
      path = this._strategy.readFromState(event);
    }

    if (!path) {
      // URL has no route info. This likely means the host SPA navigated to a
      // different page. We mark ourselves as "displaced" so that when the user
      // goes back, we re-emit even if the path is the same as before.
      if (this._currentRoute.path !== null && !this._currentRoute.notFound) {
        this._log('Reconcile: route disappeared from URL (host navigated away?)', { source });
        this._displaced = true;
      }
      return;
    }

    const normalized = this._normalize(path);
    if (!normalized) return;

    // Dedup — but re-emit if:
    // 1. We were displaced (host navigated away and back)
    // 2. The watch value changed (something happened externally, even if path looks same)
    //    This handles: host pushState'd away (clobbering URL), then user hit back.
    //    The path resolves to the same route, but we may need to re-render.
    const watchValue = this._strategy.getWatchValue();
    const externalChange = watchValue !== this._lastWatchValue;
    
    if (normalized === this._currentRoute.path && !this._displaced && !externalChange && !force) {
      this._lastWatchValue = watchValue;
      return;
    }
    this._displaced = false;

    // Match route
    const matched = matchRoute(this._compiledRoutes, normalized);
    const route = matched || { ...NOT_FOUND, path: normalized };

    // Update generation and abort controller
    this._generation++;
    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();

    // Update state and emit
    const previous = this._currentRoute;
    this._currentRoute = route;
    this._lastWatchValue = this._strategy.getWatchValue();

    this._emitter.emit('route', { route, previous, source, state: null });

    this._log('Reconciled', { path: normalized, source, route: route.name });
  }

  /**
   * Normalize a path using the configured normalizer.
   * @param {string} path
   * @returns {string|null}
   */
  _normalize(path) {
    if (!isPathSafe(path)) {
      this._log('Path rejected (unsafe)', path);
      return null;
    }
    return this._config.normalizeRoute(path);
  }

  /**
   * Debug logger.
   */
  _log(...args) {
    if (this._config.debug) {
      console.log('[embed-router]', ...args);
    }
  }
}
