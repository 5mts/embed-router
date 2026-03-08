# embed-router: Implementation Punch List

Changes needed to bring the existing `@electup/embed-router` package to production readiness, organized by priority. Each item includes the rationale, affected files, and implementation notes.

---

## 1. Capture native History APIs

**Priority: Highest — this is the single most impactful change.**

The router currently calls `window.history.pushState` / `replaceState` directly in both strategies. If the host has monkey-patched these (React Router, Vue Router, Next.js, analytics tools like GTM), every URL write triggers the host's wrapper.

### Changes

**New file: `src/history.js`**

```javascript
/**
 * Captured native History API references.
 *
 * Grab these as early as possible — before host frameworks load.
 * If the prototype is already patched, fall back to extracting
 * clean references from a temporary iframe.
 */

let _pushState;
let _replaceState;

function capture() {
  // Attempt 1: grab from prototype (survives instance-level patches)
  _pushState = History.prototype.pushState;
  _replaceState = History.prototype.replaceState;

  // Heuristic: if the function looks wrapped (e.g., its toString doesn't
  // contain native code), try the iframe fallback
  const isNative = (fn) =>
    Function.prototype.toString.call(fn).includes('[native code]');

  if (!isNative(_pushState) || !isNative(_replaceState)) {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      _pushState = iframe.contentWindow.History.prototype.pushState;
      _replaceState = iframe.contentWindow.History.prototype.replaceState;
      document.body.removeChild(iframe);
    } catch {
      // If iframe approach fails (CSP, sandboxed context), keep what we have
    }
  }
}

// Capture immediately on module load
if (typeof window !== 'undefined') {
  capture();
}

export function safePushState(state, title, url) {
  _pushState.call(history, state, title, url);
}

export function safeReplaceState(state, title, url) {
  _replaceState.call(history, state, title, url);
}
```

**Modified: `src/hash.js` and `src/query.js`**

Replace all `window.history.pushState(...)` and `window.history.replaceState(...)` calls with `safePushState(...)` and `safeReplaceState(...)` imported from `history.js`.

### Notes

- Module-level side effect (capturing on import) is intentional — this must happen as early as possible.
- The `isNative` heuristic isn't bulletproof (some frameworks use Proxy), but it catches the common case and the iframe fallback handles the rest.
- Export `capture()` for the rare case where the consumer needs to re-trigger (e.g., the module loaded before `document.body` existed and the iframe fallback failed).

---

## 2. Capture-phase popstate with `stopImmediatePropagation`

**Priority: Highest — prevents host crash on back/forward.**

Currently, `_handlePopState` listens in bubble phase and defers with `setTimeout`. The host's popstate handler still fires (and may crash) before the deferred handler runs. The production embed already proved that capture-phase + `stopImmediatePropagation` is necessary for WPR.

### Changes

**Modified: `src/router.js`**

The popstate listener registration in `start()` changes from:

```javascript
window.addEventListener('popstate', this._onPopState);
```

to:

```javascript
window.addEventListener('popstate', this._onPopState, true); // capture phase
```

The handler itself changes:

```javascript
_handlePopState(event) {
  // Check if this history entry belongs to us
  const stateKey = this._strategy._stateKey;
  if (event.state?.[stateKey] !== undefined) {
    // This is our entry — suppress before host handlers see it
    event.stopImmediatePropagation();
  }

  // Reconcile (still defer by one tick for entries that aren't ours,
  // but process immediately for our own entries)
  if (event.state?.[stateKey] !== undefined) {
    this._reconcile(event, 'popstate', true);
  } else {
    // Not our entry — defer to let host handle it, then check
    // if we need to react (e.g., host navigated away, we're displaced)
    setTimeout(() => {
      this._reconcile(event, 'popstate', false);
    }, 0);
  }
}
```

Also add a capture-phase `hashchange` suppression listener for the `hash` strategy, since `hashchange` fires on back/forward through hash entries even when they were created via `pushState`:

```javascript
// In start(), if hash mode:
if (this._config.mode === 'hash') {
  window.addEventListener('hashchange', this._onHashChangeSuppressor, true);
}

// New handler:
_hashChangeSuppressorActive = false;

_handleHashChangeSuppressor(event) {
  if (this._hashChangeSuppressorActive) {
    this._hashChangeSuppressorActive = false;
    event.stopImmediatePropagation();
  }
}
```

Set `_hashChangeSuppressorActive = true` in `_handlePopState` when processing an embed entry in hash mode, just before the reconcile call. This prevents the host's hashchange handler from also firing.

### Notes

- `stopImmediatePropagation` only works if our listener is registered before the host's. Since we're in capture phase on `window`, we fire before any bubble-phase listeners. If the host also uses capture phase, we need to be registered first (load order matters).
- The stateKey check on `event.state` is the critical filter — it's how we know the entry is ours.
- `destroy()` must also remove the capture-phase listeners.

---

## 3. `reconfigure()` method

**Priority: High — required for API-driven mode switching.**

The API response can return `url_mode` and `link_mode` that override the initial configuration. The router needs to switch strategies at runtime.

### Changes

**Modified: `src/router.js` — new public method:**

```javascript
/**
 * Reconfigure the router's URL strategy and/or link mode at runtime.
 *
 * Typically called after the first API response provides the embed's
 * server-side configuration. The current route is preserved — only
 * the URL representation changes.
 *
 * @param {object} config
 * @param {'hash'|'query'} [config.mode]
 * @param {'spa'|'reload'} [config.linkMode]
 */
reconfigure({ mode, linkMode }) {
  const currentPath = this._currentRoute.path;
  let changed = false;

  if (linkMode && linkMode !== this._config.linkMode) {
    this._config.linkMode = linkMode;
    changed = true;
    this._log('Reconfigured linkMode', linkMode);
  }

  if (mode && mode !== this._config.mode) {
    // Tear down current strategy's listeners
    this._removeStrategyListeners();
    if (this._pollTimerId != null) {
      clearInterval(this._pollTimerId);
    }

    // Switch strategy
    this._config.mode = mode;
    const strategyConfig = {
      param: this._config.param,
      id: this._config.id,
      stateKey: this._strategy._stateKey, // preserve the key
      debug: this._config.debug,
    };
    this._strategy = mode === 'hash'
      ? new HashStrategy(strategyConfig)
      : new QueryStringStrategy(strategyConfig);

    // Re-register listeners if started
    if (this._started) {
      this._addStrategyListeners();
      if (this._config.pollInterval > 0) {
        this._pollTimerId = setInterval(
          () => this._poll(),
          this._config.pollInterval
        );
      }
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
```

This also requires extracting the listener registration/removal from `start()` and `destroy()` into `_addStrategyListeners()` and `_removeStrategyListeners()` helper methods so they can be reused by `reconfigure()`.

---

## 4. Clean up `navigate()` argument parsing

**Priority: High — API clarity before the interface solidifies.**

The current heuristic for distinguishing `navigate(path, options)` from `navigate(name, params, options)` is fragile. If route params happen to contain `historyMode` or `state` as a key, the detection breaks.

### Changes

**Modified: `src/router.js`**

Replace the overloaded signature with explicit path-first semantics. Named route navigation moves to a separate method:

```javascript
/**
 * Navigate to a path.
 *
 * @param {string} path - e.g. '/city-council/candidate/harper'
 * @param {object} [options]
 * @param {'push'|'replace'} [options.historyMode]
 * @param {*} [options.state]
 * @returns {boolean}
 */
navigate(path, options = {}) {
  // ... existing logic, but path is always a path string
}

/**
 * Navigate to a named route with params.
 *
 * @param {string} name - route name
 * @param {object} params - route params
 * @param {object} [options]
 * @returns {boolean}
 */
navigateTo(name, params, options = {}) {
  const path = buildPath(this._compiledRoutes, name, params);
  return this.navigate(path, options);
}
```

**Modified: `src/preact/index.js`**

Update `useNavigate` to return an object with both methods, or keep returning a single function that always takes a path (the `Link` component already builds the path before calling navigate). The `Link` component updates to use `navigateTo` when `params` are provided:

```javascript
// In Link's handleClick:
if (linkParams) {
  router.navigateTo(to, linkParams, options);
} else {
  router.navigate(to, options);
}
```

**Modified: `storeGoingTo`** — same split:

```javascript
storeGoingTo(path) { ... }
storeGoingToNamed(name, params) {
  const path = buildPath(this._compiledRoutes, name, params);
  return this.storeGoingTo(path);
}
```

### Notes

- This is a breaking API change, but since the library isn't in production yet, now is the time.
- The `buildUrl` method should follow the same pattern: `buildUrl(path)` and `buildUrlForRoute(name, params)`.

---

## 5. Tag initial history state

**Priority: Medium — improves back/forward reliability.**

When the embed first loads in SPA mode, the current history entry may not have the embed's state tag. If the user navigates forward within the embed and then hits back, the initial entry's popstate event won't be recognized as ours.

### Changes

**Modified: `src/router.js` — in `start()`, after emitting the initial route:**

```javascript
// Tag the initial history entry so back/forward recognizes it as ours
if (this._config.linkMode === 'spa') {
  const stateKey = this._strategy._stateKey;
  if (!history.state?.[stateKey]) {
    safeReplaceState(
      { ...history.state, [stateKey]: this._currentRoute.path || '/' },
      ''
    );
  }
}
```

---

## 6. Expose `_stateKey` via public accessor

**Priority: Medium — fixes the private field access in Preact bindings.**

The `Link` component's `buildPathFromNameSafe` helper accesses `router._strategy?.param`, which is a private field.

### Changes

**Modified: `src/router.js` — new public method:**

```javascript
/**
 * Get the query parameter name used by the current strategy.
 * Returns null in hash mode.
 * @returns {string|null}
 */
getParamName() {
  return this._strategy.param ?? null;
}
```

**Modified: `src/preact/index.js`**

Replace `router._strategy?.param || 'route'` with `router.getParamName() || 'route'`.

---

## 7. Navigation lifecycle hooks

**Priority: Medium — every embed needs scroll and loaded events.**

The router currently emits `route` events and nothing else. Post-navigation concerns (scroll-to-embed, loaded event, external link patching) are entirely the consumer's responsibility. Scroll and the loaded event are universal enough to belong in the router.

### Changes

**Modified: `src/router.js` — new method and event:**

```javascript
/**
 * Signal that the application has finished rendering after a navigation.
 * This triggers post-navigation behaviors: scroll-to-embed and the
 * electupLoaded event.
 *
 * Call this from your app after data fetching + rendering is complete.
 *
 * @param {object} [options]
 * @param {string} [options.scrollToId] - element ID to scroll to
 */
navigationComplete(options = {}) {
  const scrollToId = options.scrollToId || this._config.embedId;

  // Scroll to embed (only scroll UP, not down)
  if (scrollToId && this._config.linkMode === 'spa') {
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
  document.dispatchEvent(new CustomEvent('electupLoaded', {
    bubbles: false,
    detail: {
      path: this._currentRoute.path,
      params: this._currentRoute.params,
      embedId: this._config.id,
    }
  }));

  // Emit on the router's own emitter for subscribers
  this._emitter.emit('navigationComplete', {
    route: this._currentRoute,
  });

  this._log('Navigation complete', this._currentRoute.path);
}
```

**New config option: `embedId`**

Add `embedId` to the constructor config. This is separate from `id` (which namespaces the query param). `embedId` is the DOM element ID used for scroll targeting and event detail.

```javascript
this._config.embedId = config.embedId || null;
```

### Notes

- The `fromEmbed` cookie for reload-mode scroll is left to the consumer. It requires setting the cookie in the click handler before page transition, which the consumer's `Link` wrapper or click handler is better positioned to do.
- External link patching (`target="_blank"` on API content) stays with the consumer — it requires knowledge of which DOM selectors contain API content, which varies per embed.

---

## 8. Hash strategy: distinguish empty hash from root route

**Priority: Medium — correctness issue.**

`HashStrategy.read()` currently returns `'/'` when the hash is empty. This makes it impossible to distinguish "no embed route in the URL" from "the embed is at the root route." The reconcile logic and initial route resolution both need to know the difference.

### Changes

**Modified: `src/hash.js`:**

```javascript
read() {
  const hash = window.location.hash;
  if (!hash || hash === '#' || hash === '#/') return null;  // was: return '/'
  const path = hash.slice(1);
  return path.startsWith('/') ? path : '/' + path;
}
```

Then in `_resolveInitialRoute`, the existing fallback chain handles this correctly — if `read()` returns null, it falls through to history.state, then legacy migration, then the default route.

---

## 9. Add `hash-direct` and `none` strategies

**Priority: Low — escape hatches for hostile environments.**

These are documented in the design doc as fallback strategies. They're unlikely to be needed soon but complete the strategy matrix.

### New file: `src/hash-direct.js`

```javascript
export class HashDirectStrategy {
  constructor(config) {
    this.needsInterferenceDetection = false;
    this.events = ['hashchange'];  // no popstate — we don't use pushState
    this._prefix = config.prefix || '';
  }

  read() {
    const hash = window.location.hash;
    if (!hash || hash === '#') return null;
    const path = hash.slice(1);
    // If using a prefix, strip it
    if (this._prefix && path.startsWith(this._prefix + ':')) {
      return path.slice(this._prefix.length + 1);
    }
    return path.startsWith('/') ? path : '/' + path;
  }

  readFromState() {
    return null;  // no state object available
  }

  write(path, mode) {
    // mode is ignored — location.hash always pushes
    window.location.hash = this._prefix
      ? `${this._prefix}:${path}`
      : path;
  }

  getWatchValue() {
    return window.location.hash;
  }

  verify() {
    return { survived: true, currentValue: this.read() };
  }
}
```

### New file: `src/none.js`

```javascript
export class NoneStrategy {
  constructor() {
    this.needsInterferenceDetection = false;
    this.events = [];  // no URL listeners at all
  }

  read() { return null; }
  readFromState() { return null; }
  write() { /* no-op */ }
  getWatchValue() { return ''; }
  verify() { return { survived: true, currentValue: null }; }
}
```

### Modified: `src/router.js`

Add `'hash-direct'` and `'none'` to the strategy selection switch. The `none` strategy means the URL never changes — routing is purely internal. The `goingTo` sessionStorage cue and `buildUrl()` still work for shareability.

---

## 10. Add `data-excludelink` to the strategy contract for `buildUrl`

**Priority: Low — documentation/convention change.**

The `Link` component already adds `data-excludelink="true"`, which is correct. But `buildUrl()` returns a bare URL string. If someone builds links manually instead of using `<Link>`, they need to remember the attribute. Add a note in the JSDoc and README.

No code change needed — just documentation.

---

## 11. Re-initialization support

**Priority: Low — needed for host soft navigations.**

Some host SPAs destroy and recreate DOM without a full page load. The embed needs to detect this and re-mount.

### Changes

**Modified: `src/router.js` — new method:**

```javascript
/**
 * Check if the router can be safely restarted (e.g., after the host
 * did a soft navigation that destroyed the embed DOM). Idempotent —
 * safe to call repeatedly.
 *
 * @returns {boolean} true if the router was restarted
 */
restart() {
  if (this._started) {
    // Already running — re-emit current route for the freshly mounted UI
    this._emitter.emit('route', {
      route: this._currentRoute,
      previous: null,
      source: 'restart',
      state: null,
    });
    return true;
  }
  return this.start(), true;
}
```

The consuming application hooks into `window.addEventListener('electup_load', ...)` and calls `router.restart()`. The double-mount guard is the consumer's responsibility (check if the DOM element is already mounted).

---

## Summary: Priority Order

| # | Change | Priority | Files |
|---|---|---|---|
| 1 | Capture native History APIs | Highest | New `history.js`, modify `hash.js`, `query.js` |
| 2 | Capture-phase popstate + stopImmediatePropagation | Highest | `router.js` |
| 3 | `reconfigure()` method | High | `router.js` |
| 4 | Clean up `navigate()` argument parsing | High | `router.js`, `preact/index.js` |
| 5 | Tag initial history state | Medium | `router.js` |
| 6 | Expose param name via public accessor | Medium | `router.js`, `preact/index.js` |
| 7 | Navigation lifecycle hooks | Medium | `router.js` |
| 8 | Hash strategy: empty vs root distinction | Medium | `hash.js` |
| 9 | `hash-direct` and `none` strategies | Low | New `hash-direct.js`, `none.js`, `router.js` |
| 10 | `data-excludelink` documentation | Low | README |
| 11 | Re-initialization support | Low | `router.js` |

Items 1–2 are the critical defenses against host interference. Items 3–4 are API correctness before the interface hardens. Items 5–8 improve reliability. Items 9–11 are future-proofing.

### Not in scope for the router package

These are application-layer concerns that belong in the consuming embed, not the router library:

- **Strategy detection at runtime** — the consumer determines the mode and passes it in (or calls `reconfigure()` after the API response)
- **`fromEmbed` cookie for reload-mode scroll** — set in the consumer's click handler
- **External link patching** (`target="_blank"` on API content) — requires knowledge of content selectors
- **Analytics sessionStorage keys** — the consumer's responsibility, using the `electup_*` prefix convention
- **DOM mutation observer for re-mounting** — the consumer detects removal and calls `router.restart()`
