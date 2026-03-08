# embed-router

A client-side routing library for embeddable widgets that live as `<script>` tags inside arbitrary CMS environments.

## The Problem

We build embeddable election and civic engagement widgets — candidate profiles, voter guides, topic comparisons — that clients embed on their sites via `<script>` tags. Every screen inside these widgets needs a shareable URL so voters can link each other to specific candidates or topics.

The standard solution for embedded routing is **hash-based URLs** (`#/city-council/candidate/harper`). But several of the CMS platforms our clients use are themselves single-page applications with their own hash routing. Embedding a hash-routed widget inside a hash-routed CMS creates collisions: broken history, lost state, unpredictable navigation.

**Query string routing** (`?route=/city-council/candidate/harper`) is the escape hatch. Query parameters don't conflict with hash routing, work in every browser, and produce shareable URLs. But being a "guest" on someone else's page introduces challenges that no existing router library was designed to handle:

- The host CMS may **clobber our query parameters** when it does its own `pushState` navigation.
- The host CMS may **patch `history.pushState`** and react to URL changes we make.
- `pushState` does **not fire `popstate`**, so we can't rely on events alone to detect external URL changes.
- The host CMS may use **its own query parameters** that we need to preserve.
- Legacy embed URLs using the old parameter format (`?section=X&candidate=Y`) are in the wild and need to keep working.

This library solves all of these problems.

## How It Works

### Architecture

```
                    ┌────────────────────────────┐
                    │     Your Preact App         │
                    │  useRoute() / useNavigate() │
                    │  <Route> / <Link>           │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │      QueryRouter            │
                    │  (vanilla JS, ~6KB)         │
                    │                             │
                    │  Internal state = truth     │
                    │  URL = persistence layer    │
                    │  history.state = backup     │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │     URL Strategy            │
                    │  ┌───────┐  ┌───────────┐  │
                    │  │ Hash  │  │  Query     │  │
                    │  │  #/…  │  │  ?route=/… │  │
                    │  └───────┘  └───────────┘  │
                    └────────────────────────────┘
```

**Key design principle: internal state is the source of truth, not the URL.**

When `navigate()` is called, the router updates its internal state and emits a `route` event **synchronously**, before writing to the URL. This means your Preact components re-render immediately with the new route data. The URL write (`pushState`) is a side effect that happens after. This eliminates an entire class of timing bugs where the app needs route data but the URL hasn't caught up yet.

The URL is a **persistence layer**. It's written to so users can share links and so the browser's back/forward buttons work. But it's not read during normal forward navigation — only on initialization and on `popstate` (back/forward).

### The Host Interference Problem

We discovered through diagnostics against a real host CMS (a proprietary SPA used by public media organizations) that:

1. **`pushState` is patched** by the host — the host's router wraps it to react to URL changes.
2. **The host preserves our query params** on our own `pushState` calls. No interference during normal embed navigation.
3. **The host clobbers our query params** when it does its own navigation. It builds URLs from its own state, ignoring our params.
4. **The host does NOT wipe `history.state`**. It uses its own key (`psUrl`) but preserves unknown keys.
5. **The embed DOM survives** `pushState` — the host doesn't re-mount our widget on URL changes.

This means our query param is reliable *within* our own navigations, but gets lost when the user navigates the host page. The solution: every time we `pushState`, we write the route path to **both** the query string and `history.state`. When the user hits the back button and returns to our embed, `popstate` fires with our `history.state` intact, and we recover the route even if the query param was lost.

```
Our pushState:  URL: ?route=/candidate/harper
                state: { ...hostState, __embedRoute: '/candidate/harper' }

Host pushState: URL: /other-page  (our param is gone)
                state: { psUrl: '...' }  (but previous entry's state is preserved)

User hits back: URL: ?route=/candidate/harper  (browser restores our entry's URL)
                state: { __embedRoute: '/candidate/harper' }  (our state is back)
```

### URL Change Detection

The router uses three channels to detect URL changes, all funneling through a single reconciliation function that deduplicates:

1. **`popstate` event** — fires on browser back/forward. We defer handling by one tick (`setTimeout(fn, 0)`) to let the host's own `popstate` handlers settle first. Always forces re-evaluation since popstate inherently means something external happened.
2. **`hashchange` event** — (hash mode only) fires on hash changes.
3. **Polling** — every 100ms, we compare `location.search` (or `location.hash`) to the last known value. This catches host `pushState` calls that modify the URL without triggering `popstate`. The check is a single string comparison — negligible performance cost.

## Installation

The library is vanilla JS with zero dependencies. It can be imported as ES modules or bundled with your Preact app.

```
src/
├── index.js              # Main entry point
├── router.js             # QueryRouter class
├── matcher.js            # Route pattern compilation and matching
├── normalize.js          # Path normalization and safety
├── legacy.js             # Legacy URL migration
├── emitter.js            # Event emitter
├── strategies/
│   ├── query.js          # Query string URL strategy
│   └── hash.js           # Hash URL strategy
└── preact/
    └── index.js          # Preact bindings (hooks + components)
```

## Quick Start

### 1. Create the router

```js
import { QueryRouter, snapshotUrl } from 'embed-router';

// Capture the URL as early as possible in your script — before any
// async work or host SPA code can modify it.
const urlSnapshot = snapshotUrl();

// Later, when your config is ready:
const router = new QueryRouter({
  mode: config.mode,    // 'query' or 'hash' — from your embed config
  routes: [
    { path: '/', name: 'home' },
    { path: '/:section', name: 'section' },
    { path: '/:section/candidate/:candidate', name: 'candidate' },
    { path: '/:section/:group', name: 'group' },
    { path: '/:section/:group/topic/:topic', name: 'topic' },
    { path: '/:section/topic/:topic', name: 'sectionTopic' },
  ],
  legacyRoutes: [
    { params: ['section', 'group', 'topic'], path: '/:section/:group/topic/:topic' },
    { params: ['section', 'candidate'],      path: '/:section/candidate/:candidate' },
    { params: ['section', 'topic'],          path: '/:section/topic/:topic' },
    { params: ['section', 'group'],          path: '/:section/:group' },
    { params: ['section'],                   path: '/:section' },
  ],
  initialUrl: urlSnapshot,
});
```

### 2. Wire up Preact

```jsx
import { RouterProvider, Route, Link, useRoute, useNavigate, useAbortSignal } from 'embed-router/preact';

function App() {
  return (
    <RouterProvider router={router}>
      <Route path="/" component={Home} />
      <Route path="/:section" component={SectionPage} />
      <Route path="/:section/candidate/:candidate" component={CandidatePage} />
      <Route path="/:section/:group" component={GroupPage} />
      <Route path="/:section/:group/topic/:topic" component={TopicPage} />
      <Route fallback component={NotFound} />
    </RouterProvider>
  );
}
```

### 3. Use in components

```jsx
function CandidatePage({ params }) {
  const { section, candidate } = params;
  const signal = useAbortSignal();
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`/api/candidates/${candidate}`, { signal })
      .then(r => r.json())
      .then(setData)
      .catch(err => {
        if (err.name !== 'AbortError') throw err;
      });
  }, [candidate, signal]);

  return (
    <div>
      <Link to={`/${section}`}>← Back to race</Link>
      {data && <h1>{data.name}</h1>}
    </div>
  );
}
```

## API Reference

### `snapshotUrl()`

Captures `location.search`, `location.hash`, and `location.href` at the moment it's called. Pass the result as `initialUrl` to the router constructor. This protects against the host CMS modifying the URL between script load and router initialization.

```js
const snapshot = snapshotUrl();
// → { search: '?route=/candidate/harper', hash: '', href: '...' }
```

Call this as early as possible — ideally the first line of your entry script.

### `new QueryRouter(config)`

Creates a router instance. Does **not** start listening for URL changes until `start()` is called, but does resolve the initial route immediately (so `getRoute()` works right away).

#### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'query' \| 'hash'` | `'query'` | URL strategy. `'query'` stores route in `?route=...`, `'hash'` stores in `#/...` |
| `routes` | `Array` | *required* | Route definitions. Order matters — first match wins. |
| `param` | `string` | `'route'` | Query parameter name (query mode only). |
| `id` | `string \| null` | `null` | Multi-embed prefix. If set, param becomes `{id}.{param}` (e.g., `'a'` → `'a.route'`). |
| `historyMode` | `'push' \| 'replace'` | `'push'` | Whether `navigate()` adds a history entry (push) or replaces the current one. |
| `defaultRoute` | `string` | `'/'` | Route path when no route info is found in the URL. |
| `legacyRoutes` | `Array` | `[]` | Legacy URL migration patterns (see Legacy Support below). |
| `pollInterval` | `number` | `100` | Milliseconds between URL change checks. Set to `0` to disable polling. |
| `debug` | `boolean` | `false` | Log all routing decisions to the console. |
| `initialUrl` | `object \| null` | `null` | From `snapshotUrl()`. If null, reads current URL. |
| `normalizeRoute` | `Function \| null` | built-in | Custom path normalizer. Receives a string, returns normalized string or null to reject. |
| `onHostInterference` | `Function \| null` | `null` | Called if the host CMS strips our query param after a `pushState`. |

#### Route definitions

```js
routes: [
  { path: '/', name: 'home' },
  { path: '/:section', name: 'section' },
  { path: '/:section/candidate/:candidate', name: 'candidate' },
]
```

- **`:paramName`** matches a single URL segment (anything except `/`) and extracts it as a named parameter.
- **`*`** (wildcard) matches the rest of the path. Must be the last segment. Captured as `_wildcard`.
- **Literal segments** match exact text (case-insensitive).
- **`name`** is optional but recommended — enables `navigate('candidate', { ... })` and `<Link to="candidate" params={...}>`.
- **Order matters.** Routes are tested in array order; first match wins. Put more specific patterns before less specific ones.

### `router.start()`

Starts the `popstate` listener, hash change listener (hash mode), and polling interval. Emits the initial `route` event. Idempotent — safe to call multiple times.

### `router.navigate(pathOrName, [params], [options])`

Navigate to a new route. Returns `true` if navigation occurred, `false` if deduplicated (same path).

```js
// By path:
router.navigate('/city-council/candidate/harper');

// By route name:
router.navigate('candidate', { section: 'city-council', candidate: 'harper' });

// With options:
router.navigate('/city-council', { historyMode: 'replace' });
```

**What happens on navigate:**

1. Path is normalized and validated
2. Deduplicated against current route (same path → no-op)
3. Navigation generation counter increments
4. Previous navigation's `AbortSignal` is cancelled
5. Internal state updates (synchronous)
6. `route` event emits (synchronous — Preact re-renders here)
7. `pushState` / `replaceState` writes to URL with `history.state` backup
8. Param survival is verified after 60ms (query mode)

### `router.getRoute()`

Returns the current matched route (synchronous).

```js
const route = router.getRoute();
// → {
//     name: 'candidate',
//     path: '/city-council/candidate/harper',
//     params: { section: 'city-council', candidate: 'harper' },
//     pattern: '/:section/candidate/:candidate',
//     notFound: false,
//   }
```

If no route matches, `notFound` is `true`, `name` is `null`, and `path` is the unmatched path string.

### `router.getAbortSignal()`

Returns an `AbortSignal` that is automatically aborted when the next navigation occurs. Use this to cancel in-flight `fetch` calls when the user navigates away.

```js
const signal = router.getAbortSignal();
fetch(url, { signal }).catch(err => {
  if (err.name === 'AbortError') return; // expected, user navigated
  throw err;
});
```

### `router.getGeneration()`

Returns a number that increments on every navigation. For manual stale-checking when `AbortSignal` isn't practical.

```js
const gen = router.getGeneration();
const data = await someAsyncWork();
if (router.getGeneration() !== gen) return; // user navigated, discard result
```

### `router.buildUrl(pathOrName, [params])`

Builds a URL string for the given route. Used by `<Link>` for the `href` attribute.

```js
router.buildUrl('/city-council');
// query mode: '/voterguide?route=%2Fcity-council'
// hash mode:  '#/city-council'

router.buildUrl('candidate', { section: 'city-council', candidate: 'harper' });
// query mode: '/voterguide?route=%2Fcity-council%2Fcandidate%2Fharper'
```

### `router.on(event, fn)` / `router.off(event, fn)`

Subscribe/unsubscribe to route change events. `on` returns an unsubscribe function.

```js
const unsub = router.on('route', ({ route, previous, source }) => {
  console.log(`Navigated to ${route.name} via ${source}`);
  // source is: 'init' | 'navigate' | 'popstate' | 'hashchange' | 'poll'
});

// Later:
unsub();
```

### `router.destroy()`

Full cleanup. Removes all event listeners, clears the polling interval, aborts in-flight work, and removes all subscribers. Call this when the embed is unmounted.

### Preact Components

#### `<RouterProvider router={router}>`

Context provider. Wraps your app and auto-starts the router. All hooks and components below must be descendants of this.

#### `<Route path="..." component={...} />`

Renders its component when the current path matches. Extracted params are passed as a `params` prop. The full matched route is passed as a `route` prop.

```jsx
<Route path="/:section/candidate/:candidate" component={CandidatePage} />

function CandidatePage({ params, route }) {
  // params: { section: 'city-council', candidate: 'harper' }
  // route:  { name: 'candidate', path: '...', ... }
}
```

Use `fallback` for a catch-all when no route matches:

```jsx
<Route fallback component={NotFound} />
```

#### `<Link to="..." [params={...}] [replace]>`

Renders an `<a>` tag with the correct `href` for accessibility and right-click behavior, but intercepts left-clicks to use `navigate()` (no page reload).

```jsx
<Link to="/city-council">City Council</Link>
<Link to="candidate" params={{ section: 'city-council', candidate: 'harper' }}>
  Harper Robinson
</Link>
<Link to="/city-council" replace>Back (no history entry)</Link>
```

Props:
- `to` — path string or route name
- `params` — route params (when `to` is a route name)
- `replace` — if true, uses `replaceState` instead of `pushState`
- `class` / `activeClass` — CSS classes. `activeClass` is added when the link matches the current route
- All other props are passed through to the `<a>` element

Adds `aria-current="page"` when the link matches the current route.

#### `useRoute()`

Returns the current route state. Re-renders when the route changes.

```js
const { path, params, name, pattern, notFound, previous, source } = useRoute();
```

#### `useNavigate()`

Returns the `navigate()` function.

```js
const navigate = useNavigate();
navigate('/city-council');
navigate('candidate', { section: 'city-council', candidate: 'harper' });
```

#### `useAbortSignal()`

Returns the current navigation's `AbortSignal`. Changes on every navigation.

#### `useRouter()`

Returns the raw `QueryRouter` instance. Escape hatch for advanced use cases.

## Legacy URL Support

Old embeds generated URLs with individual query parameters:

```
?section=city-council&candidate=harper-robinson
?section=city-council&group=district-1&topic=reasons-for-running
```

These URLs exist in the wild — bookmarked, shared in articles, linked from social media. The `legacyRoutes` config handles this transparently.

### How it works

On initialization, before the first route match, the router checks if the URL contains legacy parameters. If a legacy pattern matches, it:

1. Builds the equivalent new-format path
2. Rewrites the URL via `replaceState` (old params removed, `?route=...` added)
3. Proceeds with normal routing against the new path

The user sees the clean new URL, their old bookmark still worked, and all future shares use the new format.

### Configuration

Legacy routes are checked in order — **most specific first** (longest `params` array). Each pattern requires ALL listed params to be present.

```js
legacyRoutes: [
  // Most specific first
  { params: ['section', 'group', 'topic'], path: '/:section/:group/topic/:topic' },
  { params: ['section', 'candidate'],      path: '/:section/candidate/:candidate' },
  { params: ['section', 'topic'],          path: '/:section/topic/:topic' },
  { params: ['section', 'group'],          path: '/:section/:group' },
  { params: ['section'],                   path: '/:section' },
]
```

The `path` template uses the same `:param` syntax as route definitions — values are auto-substituted from the query string.

For complex mappings, use a `toPath` function instead:

```js
{
  params: ['section', 'candidate'],
  toPath: (p) => `/custom-path/${p.section}/c/${p.candidate}`,
}
```

If the modern `route` parameter is already present in the URL, legacy migration is skipped entirely.

## Multi-Embed Support

If you need multiple embeds on the same page, each sharing URL space, pass an `id` to namespace the query parameter:

```js
// Embed A
new QueryRouter({ id: 'a', routes: [...] });  // uses ?a.route=/...

// Embed B
new QueryRouter({ id: 'b', routes: [...] });  // uses ?b.route=/...
```

The prefix also namespaces the `history.state` backup key (`__er_a`, `__er_b`).

When `id` is null (the default), no prefix is used — the param is just `route` and the state key is `__embedRoute`. Don't use `id` unless you actually need multiple embeds.

## Switching Between Hash and Query Mode

The `mode` config switches between hash and query string routing. Route definitions, navigation calls, and components are identical — only the URL format changes.

```js
// Reads from embed config at runtime
const router = new QueryRouter({
  mode: config.mode,  // 'hash' or 'query'
  routes: [...],      // same routes either way
});
```

- **Hash mode** (`#/city-council/candidate/harper`): Uses `location.hash`. No interference detection needed — the hash is entirely ours. Simpler, but conflicts with host SPAs that use hash routing.
- **Query mode** (`?route=/city-council/candidate/harper`): Uses a query parameter in `location.search`. Includes `history.state` backup, interference detection, and polling. Works alongside any host routing strategy.

## Debug Mode

Pass `debug: true` to log every routing decision:

```
[embed-router] Initial route resolved { path: '/city-council', source: 'url', matched: true }
[embed-router] Started
[embed-router] Navigated { path: '/city-council/candidate/harper', route: 'candidate', historyMode: 'push', gen: 1 }
[embed-router] Reconciled { path: '/city-council', source: 'popstate', route: 'section' }
[embed-router] ⚠️ Host interference detected: param was stripped after pushState
```

This is invaluable when debugging routing issues in unfamiliar CMS environments.

## Testing

The library ships with two test suites (121 tests total):

```bash
node tests/test-core.js     # Route matching, normalization, legacy migration, emitter (65 tests)
node tests/test-router.js   # Full router lifecycle with browser mocks (56 tests)
```

The integration tests mock `window.location`, `history`, and DOM event listeners to simulate real browser behavior including `pushState`, `popstate`, and the host-CMS-clobbers-our-params scenario.

## File Overview

| File | Size | Purpose |
|------|------|---------|
| `router.js` | ~10KB | Core `QueryRouter` class — init, navigate, reconcile, destroy |
| `matcher.js` | ~3KB | Compile route patterns to regex, match paths, extract params, build paths |
| `strategies/query.js` | ~2.5KB | Read/write `?route=` with param preservation and `history.state` backup |
| `strategies/hash.js` | ~1.5KB | Read/write `#/path` |
| `legacy.js` | ~2KB | Declarative legacy URL migration |
| `normalize.js` | ~1KB | Path normalization, safety checks |
| `emitter.js` | ~1KB | Minimal event emitter |
| `preact/index.js` | ~5KB | RouterProvider, Route, Link, hooks |
