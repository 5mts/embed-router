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
import { safeReplaceState } from './history.js';
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
   * @param {'spa'|'reload'} [config.linkMode] - how navigation happens. 'spa' intercepts clicks
   *   and navigates without page reload. 'reload' lets the browser follow links naturally,
   *   storing the intended route in sessionStorage so the next page load picks it up.
   *   Defaults to 'spa' for hash mode, 'reload' for query mode.
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
    const mode = config.mode || 'query';
    this._config = {
      mode,
      param: config.param || 'route',
      id: config.id || null,
      linkMode: config.linkMode || (mode === 'hash' ? 'spa' : 'reload'),
      historyMode: config.historyMode || 'push',
      defaultRoute: config.defaultRoute || '/',
      pollInterval: config.pollInterval ?? 100,
      embedId: config.embedId || null,
      debug: config.debug || false,
      normalizeRoute: config.normalizeRoute || normalizePath,
      onHostInterference: config.onHostInterference || null,
      prefix: config.prefix || '',
    };

    // --- sessionStorage key for goingTo cue (reload mode) ---
    this._goingToKey = this._config.id
      ? `__er_goingTo_${this._config.id}`
      : '__er_goingTo';

    // --- State key for history.state (namespaced if multi-embed) ---
    const stateKey = this._config.id
      ? `__er_${this._config.id}`
      : '__embedRoute';

    // --- Strategy ---
    const strategyConfig = {
      param: this._config.param,
      id: this._config.id,
      prefix: this._config.prefix,
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
    this._onHashChangeSuppressor = this._handleHashChangeSuppressor.bind(this);
    this._suppressNextHashChange = false;
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

    this._addStrategyListeners();

    // Start polling
    this._lastWatchValue = this._strategy.getWatchValue();
    this._startPolling();

    // Emit initial route
    this._emitter.emit('route', {
      route: this._currentRoute,
      previous: null,
      source: 'init',
      state: null,
    });

    // Tag the initial history entry so back/forward recognizes it as ours.
    // Without this, the first back-button press after an embed navigation
    // won't have our stateKey and won't be suppressed from host handlers.
    if (this._config.linkMode === 'spa') {
      const stateKey = this._strategy._stateKey;
      if (!window.history.state?.[stateKey]) {
        const initialPath = this._currentRoute.path || this._config.defaultRoute;
        safeReplaceState(
          { ...window.history.state, [stateKey]: initialPath },
          '',
          window.location.href,
        );
      }
    }

    this._log('Started');
  }

  /**
   * Navigate to a new route.
   * 
   * Accepts either:
   *   - A path string: navigate('/city-council/candidate/harper')
   *   - A path + options: navigate('/city-council', { historyMode: 'replace' })
   *   - A route name + params: navigate('candidate', { section: 'city-council', candidate: 'harper' })
   *   - A route name + params + options: navigate('candidate', { section: 'x' }, { historyMode: 'replace' })
   *
   * Heuristic: if the first argument starts with '/', it's always a path.
   * Otherwise it's treated as a route name (second arg = params).
   * Use { named: true/false } in options to override the heuristic.
   *
   * @param {string} pathOrName - path string (starts with /) or route name
   * @param {object} [paramsOrOptions] - route params (if named) or options (if path)
   * @param {object} [options]
   * @param {'push'|'replace'} [options.historyMode] - override default history mode
   * @param {boolean} [options.named] - force named route (true) or path (false) interpretation
   * @returns {boolean} true if navigation occurred, false if deduped
   */
  navigate(pathOrName, paramsOrOptions, options = {}) {
    let path;

    // Determine if this is a named route or a path.
    // Heuristic: paths start with '/', route names don't.
    // Override with { named: true/false } in either options position.
    const namedOverride = options.named ?? paramsOrOptions?.named;
    const isNamed = namedOverride !== undefined
      ? namedOverride
      : !pathOrName.startsWith('/');

    if (isNamed && paramsOrOptions && typeof paramsOrOptions === 'object') {
      // Named route: navigate('candidate', { section: 'x', candidate: 'y' }, options?)
      path = buildPath(this._compiledRoutes, pathOrName, paramsOrOptions);
    } else if (!isNamed && paramsOrOptions && typeof paramsOrOptions === 'object') {
      // Path with options in second arg: navigate('/city-council', { historyMode: 'replace' })
      path = pathOrName;
      options = paramsOrOptions;
    } else {
      // Bare path or name string
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

    // Reload mode (programmatic): store the goingTo cue and trigger a full
    // page reload. The Link component handles this differently — it calls
    // storeGoingTo() directly and lets the browser follow the <a href>.
    if (this._config.linkMode === 'reload') {
      this.storeGoingTo(normalized);
      const url = this.buildUrl(normalized);
      this._log('Reload navigate', { path: normalized, url });
      window.location.href = url;
      return true;
    }

    // --- SPA mode below ---

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
    if (params && typeof params === 'object') {
      path = buildPath(this._compiledRoutes, pathOrName, params);
    } else {
      path = pathOrName;
    }

    const normalized = this._normalize(path) || this._config.defaultRoute;

    if (this._config.mode === 'hash') {
      const prefix = this._config.prefix;
      return prefix ? `#${prefix}:${normalized}` : `#${normalized}`;
    }

    // Query mode: build URL preserving existing params
    const url = new URL(window.location.href);
    const paramName = this._strategy.param;
    url.searchParams.set(paramName, normalized);
    // Return relative URL (path + search + hash)
    return url.pathname + url.search + url.hash;
  }

  /**
   * Get the current link mode ('spa' or 'reload').
   * @returns {'spa'|'reload'}
   */
  getLinkMode() {
    return this._config.linkMode;
  }

  /**
   * Get the query parameter name used by the current strategy.
   * Returns null in hash mode (no query param is used).
   * @returns {string|null}
   */
  getParamName() {
    return this._strategy.param ?? null;
  }

  /**
   * Signal that the application has finished rendering after a navigation.
   * Triggers post-navigation behaviors: scroll-to-embed and the
   * embedRouterLoaded custom event.
   *
   * Call this from your app after data fetching + rendering is complete.
   *
   * @param {object} [options]
   * @param {string} [options.scrollToId] - element ID to scroll to (defaults to embedId config)
   */
  navigationComplete(options = {}) {
    const scrollToId = options.scrollToId || this._config.embedId;

    // Scroll to embed (only scroll UP to bring it into view, not down)
    if (scrollToId && typeof document !== 'undefined') {
      const el = document.getElementById(scrollToId);
      if (el) {
        const rect = el.getBoundingClientRect();
        const targetTop = rect.top + window.scrollY - (window.innerHeight * 0.08);
        if (window.scrollY > targetTop) {
          window.scrollTo({ top: targetTop });
        }
      }
    }

    // Emit loaded event for host page / iframe parent integration
    if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
      document.dispatchEvent(new CustomEvent('embedRouterLoaded', {
        bubbles: false,
        detail: {
          path: this._currentRoute.path,
          params: this._currentRoute.params,
          embedId: this._config.embedId,
        },
      }));
    }

    // Emit on the router's own emitter for subscribers
    this._emitter.emit('navigationComplete', {
      route: this._currentRoute,
    });

    this._log('Navigation complete', this._currentRoute.path);
  }

  /**
   * Store a goingTo cue in sessionStorage for reload-mode navigation.
   *
   * Used by the Link component in reload mode: it calls this before letting
   * the browser follow the <a href> naturally. On the next page load, the
   * router reads the cue in _resolveInitialRoute() to render the correct route.
   *
   * @param {string} pathOrName - path string or route name
   * @param {object} [params] - if first arg is a route name, the params to fill in
   */
  storeGoingTo(pathOrName, params) {
    let path;
    if (params && typeof params === 'object') {
      path = buildPath(this._compiledRoutes, pathOrName, params);
    } else {
      path = pathOrName;
    }
    const normalized = this._normalize(path);
    if (!normalized) return;
    try {
      sessionStorage.setItem(this._goingToKey, JSON.stringify({
        path: normalized,
        ts: Date.now(),
      }));
      this._log('Stored goingTo cue', normalized);
    } catch (e) {
      this._log('Failed to write goingTo cue', e);
    }
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
   * Reconfigure the router's URL strategy and/or link mode at runtime.
   *
   * Typically called after the first API response provides the embed's
   * server-side configuration. The current route is preserved — only
   * the URL representation changes.
   *
   * @param {object} config
   * @param {'hash'|'query'} [config.mode] - new URL strategy
   * @param {'spa'|'reload'} [config.linkMode] - new link mode
   * @returns {boolean} true if any configuration changed
   */
  reconfigure({ mode, linkMode } = {}) {
    const currentPath = this._currentRoute.path;
    let changed = false;

    if (linkMode && linkMode !== this._config.linkMode) {
      this._config.linkMode = linkMode;
      changed = true;
      this._log('Reconfigured linkMode', linkMode);
    }

    if (mode && mode !== this._config.mode) {
      // Tear down current strategy's listeners and polling
      if (this._started) {
        this._removeStrategyListeners();
        this._stopPolling();
      }

      // Switch strategy
      this._config.mode = mode;
      const strategyConfig = {
        param: this._config.param,
        id: this._config.id,
        prefix: this._config.prefix,
        stateKey: this._strategy._stateKey,
        debug: this._config.debug,
      };
      this._strategy = mode === 'hash'
        ? new HashStrategy(strategyConfig)
        : new QueryStringStrategy(strategyConfig);

      // Re-register listeners if started
      if (this._started) {
        this._addStrategyListeners();
        this._startPolling();
      }

      // Rewrite URL under new strategy (replaceState, no new history entry)
      if (currentPath && currentPath !== '/') {
        try {
          this._strategy.write(currentPath, 'replace');
        } catch (e) {
          this._log('Failed to rewrite URL after reconfigure', e);
        }
      }

      this._lastWatchValue = this._strategy.getWatchValue();
      changed = true;
      this._log('Reconfigured mode', mode);
    }

    return changed;
  }

  /**
   * Re-initialize the router. If already started, re-emits the current route
   * with source 'restart' (useful when the embed re-mounts without a full
   * page reload). If not started, calls start().
   */
  restart() {
    if (!this._started) {
      this.start();
      return;
    }

    // Already started — re-emit current route so subscribers re-render
    this._emitter.emit('route', {
      route: this._currentRoute,
      previous: null,
      source: 'restart',
      state: null,
    });

    this._log('Restarted');
  }

  /**
   * Full cleanup. Removes all event listeners, clears polling interval,
   * aborts in-flight work, and removes all subscribers.
   *
   * Call this when the embed is being unmounted/destroyed.
   */
  destroy() {
    this._started = false;

    this._removeStrategyListeners();
    this._stopPolling();

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
   * Register event listeners for the current strategy (capture phase).
   */
  _addStrategyListeners() {
    for (const event of this._strategy.events) {
      if (event === 'popstate') {
        window.addEventListener('popstate', this._onPopState, true);
      } else if (event === 'hashchange') {
        window.addEventListener('hashchange', this._onHashChange, true);
      }
    }
    // Hash mode: hashchange suppressor for back/forward through our entries
    if (this._config.mode === 'hash') {
      window.addEventListener('hashchange', this._onHashChangeSuppressor, true);
    }
  }

  /**
   * Remove event listeners for the current strategy (capture phase).
   */
  _removeStrategyListeners() {
    window.removeEventListener('popstate', this._onPopState, true);
    window.removeEventListener('hashchange', this._onHashChange, true);
    window.removeEventListener('hashchange', this._onHashChangeSuppressor, true);
  }

  /**
   * Start the URL change polling interval.
   */
  _startPolling() {
    if (this._config.pollInterval > 0) {
      this._pollTimerId = setInterval(
        () => this._poll(),
        this._config.pollInterval
      );
    }
  }

  /**
   * Stop the URL change polling interval.
   */
  _stopPolling() {
    if (this._pollTimerId != null) {
      clearInterval(this._pollTimerId);
      this._pollTimerId = null;
    }
  }

  /**
   * Resolve the initial route on construction.
   * Order of precedence:
   *   0. goingTo sessionStorage cue (reload-mode navigation intent)
   *   1. URL snapshot (if provided) or current URL
   *   2. history.state backup
   *   3. Legacy URL migration
   *   4. Default route
   */
  _resolveInitialRoute() {
    let path = null;
    let source = 'default';

    // 0. Check sessionStorage goingTo cue (reload-mode navigation handoff).
    //    Highest priority: if present, the user just clicked a reload-mode link
    //    and the page reloaded. The URL may not reflect the intended route yet.
    try {
      const raw = sessionStorage.getItem(this._goingToKey);
      if (raw) {
        sessionStorage.removeItem(this._goingToKey);
        // Parse JSON format { path, ts }. Handle legacy bare-string format gracefully.
        let goingToPath;
        let expired = false;
        try {
          const parsed = JSON.parse(raw);
          goingToPath = parsed.path;
          // Expire stale cues (> 10 seconds old)
          if (parsed.ts && Date.now() - parsed.ts > 10_000) {
            expired = true;
          }
        } catch {
          // Legacy bare string format (no JSON)
          goingToPath = raw;
        }
        if (goingToPath && !expired) {
          path = goingToPath;
          source = 'goingTo';
          this._log('goingTo cue found in sessionStorage', path);
        } else if (expired) {
          this._log('goingTo cue expired, ignoring', goingToPath);
        }
      }
    } catch (e) {
      // sessionStorage may be unavailable (private browsing, etc.)
    }

    // 1. Try reading from URL (snapshot or current)
    if (!path && this._initialUrl) {
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

    // If we resolved from a non-URL source, write the route to the URL
    // so the user sees the correct URL and can share it
    if (source === 'goingTo' || source === 'history-state') {
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

      const prefix = this._config.prefix;
      if (prefix) {
        const expected = `#${prefix}:`;
        if (!hash.startsWith(expected)) return null;
        const path = hash.slice(expected.length);
        if (!path) return null;
        return path.startsWith('/') ? path : '/' + path;
      }

      if (hash === '#/') return null;
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
      safeReplaceState(window.history.state, '', finalUrl.toString());

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
   *
   * Registered in capture phase so we fire before host handlers. If the
   * history entry is ours (has our stateKey), we stopImmediatePropagation
   * to prevent the host's popstate handler from seeing it and crashing.
   * We also reconcile immediately for our entries (no deferral needed).
   *
   * For entries that aren't ours, we defer by one tick to let the host
   * settle, then check if we need to react (e.g., host navigated away).
   */
  _handlePopState(event) {
    const stateKey = this._strategy._stateKey;
    const isOurs = event.state?.[stateKey] !== undefined;

    if (isOurs) {
      // Suppress before host handlers see it
      event.stopImmediatePropagation();

      // In hash mode, also suppress the subsequent hashchange event
      if (this._config.mode === 'hash') {
        this._suppressNextHashChange = true;
      }

      // Handle immediately — no need to defer for our own entries
      this._reconcile(event, 'popstate', /* force */ true);
    } else {
      // Not our entry — defer to let host SPA handle it, then check
      // if we need to react (e.g., host navigated away, we're displaced)
      setTimeout(() => {
        this._reconcile(event, 'popstate', /* force */ false);
      }, 0);
    }
  }

  /**
   * Handle hashchange events (hash mode).
   * Registered in capture phase.
   */
  _handleHashChange() {
    this._reconcile(null, 'hashchange');
  }

  /**
   * Suppress hashchange events that follow our own popstate handling.
   *
   * When the user navigates back/forward through hash-based history entries
   * created via pushState, the browser fires both popstate AND hashchange.
   * We handle the navigation in popstate and suppress the hashchange to
   * prevent the host's hashchange listener from reacting to our hash.
   */
  _handleHashChangeSuppressor(event) {
    if (this._suppressNextHashChange) {
      this._suppressNextHashChange = false;
      event.stopImmediatePropagation();
    }
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
