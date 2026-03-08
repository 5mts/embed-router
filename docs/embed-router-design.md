# Embed Router: Design Document

A routing library for embedded widgets that must survive hostile host page environments. The router provides unique URLs per screen, direct linking, and correct browser back/forward behavior — all without owning the page.

---

## Problem Statement

The embed runs on pages we don't control. The browser has one URL bar and one history stack, and the host page believes it owns both. Host pages interfere in specific, documented ways:

- **Click interception**: Host JS uses event delegation on ancestor elements to catch `<a>` clicks and run them through its own navigation (e.g., WPR listens on `.wp-site-blocks`, triggering `loadPageFromLink` → `swapContent` → crash).
- **`hashchange` interception**: Setting `window.location.hash` fires `hashchange`, which host scripts listen for and react to with their own navigation logic.
- **`popstate` interception**: Host JS listens for `popstate` to handle back/forward. If the embed calls `pushState`, pressing back/forward triggers the host's handler, which crashes.
- **History stack corruption**: Any `pushState()` while at a "back" position wipes the forward stack. If the host calls `pushState` in response to detecting a URL change (via MutationObserver, polling, or event listeners), forward navigation breaks.
- **Asynchronous URL rewriting**: Some CMSs (Grove/Brightspot) update the URL asynchronously — after the embed's click handler fires but before the page finishes loading. The URL is stale at the moment the embed needs to read its route.

---

## Architecture Overview

Three layers, each with a single responsibility:

```
┌─────────────────────────────────────────────┐
│  Embed Application                          │
│  Subscribes to router core for current route│
└──────────────┬──────────────────────────────┘
               │ subscribe / navigate
┌──────────────▼──────────────────────────────┐
│  Router Core                                │
│  Canonical route state + internal stack     │
│  Never reads the URL directly               │
│  Emits lifecycle events                     │
└──────────┬─────────────────▲────────────────┘
           │ write           │ read (cold start + popstate)
┌──────────▼─────────────────┴────────────────┐
│  URL Adapter                                │
│  Strategy-specific URL read/write           │
│  Navigation intent buffer (sessionStorage)  │
│  Runs on host page                          │
└─────────────────────────────────────────────┘
```

### Data flow rules

| Trigger | Direction | Description |
|---|---|---|
| User clicks link in embed (SPA mode) | Core → Adapter | Router core updates state, adapter writes URL as side effect |
| User clicks link in embed (reload mode) | Intent buffer only | Intent is stored, browser follows link naturally, embed re-mounts on new page |
| User hits back/forward | Adapter → Core | Adapter detects `popstate`, reads URL, pushes new state into core |
| Cold page load | Adapter → Core | Adapter reads intent buffer (if present) or URL, seeds core |
| Host rewrites URL async | Intent buffer | Core reads intent buffer (sessionStorage), ignores stale URL |

**Key principle: the URL is the persistence/sharing layer, not the source of truth for active navigation.** During user interaction within the embed, router core state is authoritative. The URL is written as a side effect and may lag. On cold start or back/forward, the URL becomes the source of truth because there is no in-memory state.

---

## Two Dimensions of Configuration

The router has two independent configuration axes:

**URL strategy** — _where_ the route is stored in the URL:
- `hash` — namespaced hash fragment (default)
- `queryparam` — namespaced query parameter
- `hash-direct` — hash via `location.hash` (no pushState)
- `none` — no URL reflection

**Link mode** — _how_ navigation happens when the user clicks a link:
- `spa` — the embed intercepts the click, prevents default, calls `pushState`, and re-renders in place. The page does not reload.
- `reload` — the embed sets the navigation intent in sessionStorage, then lets the browser follow the `<a>` href naturally. The host CMS handles the full page transition. The embed re-mounts on the new page and reads the intent buffer.

These are independent because some hosts _require_ full page transitions to function correctly (they need to run their own transition lifecycle, update ads, re-render layout). In those environments, fighting the host's navigation is counterproductive — the right approach is to ride the host's page transition and survive the remount.

| | `spa` link mode | `reload` link mode |
|---|---|---|
| **`hash` URL strategy** | Default. pushState writes hash, embed re-renders in place. | Embed writes `<a href="#/section/race">`, browser follows, page reloads, embed reads hash on mount. |
| **`queryparam` URL strategy** | pushState writes query param, embed re-renders in place. | Embed writes `<a href="?evg=/section/race">`, browser follows, host handles transition. |
| **`none` URL strategy** | Internal routing only, no URL change. | Not a valid combination. |

---

## Strategy Resolution

Strategy is not always known at build time. It may come from multiple sources, resolved in priority order:

```
1. Explicit config        — hardcoded in embed script tag or init call
2. API response override  — server-side embed settings (url_mode, link_mode)
3. Runtime detection      — sniff the deployment environment
4. Defaults               — hash strategy, spa link mode
```

### Runtime detection

The router can infer its environment from contextual signals:

```javascript
function detectStrategy(): { urlStrategy: string, linkMode: string } {
  // Check if the embed script's URL path matches a known CMS pattern
  const scriptEl = document.querySelector(`#${embedId} + script`);
  const scriptSrc = scriptEl?.src || '';

  // Grove/Brightspot deploys from a specific directory
  if (scriptSrc.match(/\/grove-embeds\//)) {
    return { urlStrategy: 'queryparam', linkMode: 'reload' };
  }

  // If the URL already has route params in query string but no hash,
  // we're probably in query mode from a previous navigation
  const params = new URLSearchParams(location.search);
  if (!location.hash && params.has('section')) {
    return { urlStrategy: 'queryparam', linkMode: 'reload' };
  }

  return { urlStrategy: 'hash', linkMode: 'spa' };
}
```

### Late reconfiguration

Because the API response can override strategy, the router must support reconfiguration after initialization. The first API call may return `url_mode` and `link_mode` fields that differ from the detected defaults. When this happens:

1. The URL adapter switches strategies.
2. If the current route is already in the URL under the old strategy, the adapter rewrites it under the new strategy using `replaceState` (no new history entry).
3. The router core state is unaffected — it doesn't know or care about the URL strategy.

```javascript
router.reconfigure({
  urlStrategy: apiResponse.embed.url_mode,   // e.g. 'queryparam'
  linkMode: apiResponse.embed.link_mode,      // e.g. 'reload'
});
```

---

## Layer 1: Router Core

Pure state management. No DOM, no browser APIs. Framework-agnostic.

### API

```typescript
interface Route {
  path: string;                       // e.g. "/race/123"
  params: Record<string, string>;     // extracted named params
}

interface RouterCore {
  current: Route;
  navigate(path: string): void;       // push new route
  replace(path: string): void;        // replace current (no new history entry)
  back(): boolean;                    // returns false if at bottom of embed's stack
  forward(): boolean;                 // returns false if at top
  subscribe(fn: (route: Route) => void): () => void;
  onNavigationComplete(fn: () => void): () => void;  // after render settles
  reconfigure(config: Partial<AdapterConfig>): void;
  getShareableURL(): string;          // current route as a copyable URL
}
```

### Internal history stack

The browser's `history.length` is shared with the host and unreliable. The router maintains its own stack:

```typescript
interface InternalStack {
  entries: string[];    // ordered list of paths
  index: number;        // current position
}
```

On `navigate()`: splice everything after `index`, push new path, increment index.
On `back()`: decrement index (do not modify entries).
On `forward()`: increment index (do not modify entries).

The stack tells the router whether "back" should exit the embed's history entirely (index === 0). When that happens, the router can either do nothing (let the browser's native back take over) or emit an event so the embed can show an "exit" state.

### Route matching

Keep this minimal. Flat list of route definitions with named params:

```typescript
const routes = [
  '/',
  '/:section',
  '/:section/candidate/:candidate',
  '/:section/:group',
  '/:section/:group/topic/:topic',
  '/:section/topic/:topic',
];
```

Match in order, first wins. Extract named params into `route.params`. No nested routes, no middleware, no async loading — this is a URL-to-params mapper, nothing more.

---

## Layer 2: Navigation Intent Buffer

Solves the timing problem where the host page rewrites the URL asynchronously after the embed's click handler fires but before the application reads it. Also the _only_ routing mechanism in reload link mode, where the intent must survive a full page transition.

### Mechanism

```typescript
const STORAGE_PREFIX = 'electup';

function storageKey(embedId: string): string {
  return `${STORAGE_PREFIX}_nav_${embedId}`;
}

function setIntent(embedId: string, path: string): void {
  try {
    sessionStorage.setItem(storageKey(embedId), JSON.stringify({
      path,
      timestamp: Date.now()
    }));
  } catch {
    // sessionStorage unavailable — fall through to URL
  }
}

function consumeIntent(embedId: string): string | null {
  try {
    const raw = sessionStorage.getItem(storageKey(embedId));
    if (!raw) return null;
    const intent = JSON.parse(raw);
    sessionStorage.removeItem(storageKey(embedId));
    // Expire stale intents (e.g., > 10 seconds old)
    if (Date.now() - intent.timestamp > 10_000) return null;
    return intent.path;
  } catch {
    return null;
  }
}
```

### Why the intent buffer is architectural, not a workaround

In reload mode, the embed has no in-memory state between page loads. The browser's URL may be controlled by the host CMS's transition system and may not reflect the embed's route until after the host's own navigation completes — or may never reflect it at all. The intent buffer is the canonical handoff mechanism. In SPA mode, it serves as a fallback for async URL rewriting. Either way, it is a first-class layer, not an edge-case patch.

### sessionStorage constraints

sessionStorage is per-origin, per-tab. If the embed runs on `newsroom.com`, it shares sessionStorage with `newsroom.com`'s own scripts. Keys are namespaced by embed ID to avoid collisions — both with the host and with other embeds on the same page. If sessionStorage is unavailable (private browsing on some older browsers, storage quota exceeded), the buffer degrades gracefully — active SPA navigation still works via router core state, but reload-mode navigation and the cross-page-load handoff are lost.

---

## Layer 3: URL Adapter

The only component that touches `window.history` and `window.location`. Configured per embed deployment based on host page behavior.

### Full configuration

```typescript
interface AdapterConfig {
  urlStrategy: 'hash' | 'queryparam' | 'hash-direct' | 'none';
  linkMode: 'spa' | 'reload';
  prefix: string;        // namespace, e.g. 'evg'
  embedId: string;       // unique embed identifier, for multi-embed + storage keys
}
```

### Capturing native APIs

**This must happen as early as possible in script execution**, before host frameworks load and monkey-patch.

```javascript
// Grab from prototype — more robust than instance properties.
// Some frameworks replace history.pushState but leave History.prototype alone.
const _pushState = History.prototype.pushState;
const _replaceState = History.prototype.replaceState;

function safePushState(state, title, url) {
  _pushState.call(history, state, title, url);
}

function safeReplaceState(state, title, url) {
  _replaceState.call(history, state, title, url);
}
```

**Fallback if the prototype is already patched** (embed script loaded after host framework):

```javascript
function getCleanHistoryAPI() {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  const clean = {
    pushState: iframe.contentWindow.History.prototype.pushState,
    replaceState: iframe.contentWindow.History.prototype.replaceState,
  };
  document.body.removeChild(iframe);
  return clean;
}
```

This creates a temporary iframe to get an untouched `History.prototype`, then discards the iframe. The function references remain valid after removal.

### Strategy: `hash` (default — most resilient)

Writes the embed route into the URL hash using `pushState`, which does **not** fire `hashchange`. This is the critical distinction — `location.hash = ...` fires `hashchange` and the host reacts, but `pushState` with a hash-containing URL does not.

```javascript
const STATE_KEY = '__electup';

function writeRoute(path, push = true) {
  const hash = `#${config.prefix}:${path}`;
  const url = new URL(window.location);
  url.hash = hash;
  const state = { [STATE_KEY]: true, embedId: config.embedId, path };

  if (push) {
    safePushState(state, '', url.toString());
  } else {
    safeReplaceState(state, '', url.toString());
  }
}

function readRoute(): string | null {
  const hash = window.location.hash;
  const prefix = `#${config.prefix}:`;
  if (!hash.startsWith(prefix)) return null;
  return hash.slice(prefix.length);
}
```

**popstate handling**:

```javascript
window.addEventListener('popstate', (event) => {
  if (event.state?.[STATE_KEY] && event.state.embedId === config.embedId) {
    event.stopImmediatePropagation();
    routerCore.handleExternalNavigation(event.state.path);
  }
}, true); // capture phase — fire before host listeners
```

The `STATE_KEY` + `embedId` check is critical — it ensures the embed ignores both the host's history entries and other embeds' entries. `stopImmediatePropagation` in capture phase prevents the host's popstate handler from seeing the event at all.

**Residual risk**: `hashchange` *does* fire when the user navigates back/forward through hash-based entries. The host's `hashchange` listener will see it. Mitigation: the namespaced hash (`#evg:/race/123`) won't match anything the host expects, so well-behaved hosts will ignore it. For poorly-behaved hosts that react to any `hashchange`, use `queryparam` strategy instead.

### Strategy: `queryparam`

Writes the embed route as a query parameter. Avoids hash entirely.

```javascript
function writeRoute(path, push = true) {
  const url = new URL(window.location);
  url.searchParams.set(config.prefix, path);
  const state = { [STATE_KEY]: true, embedId: config.embedId, path };

  if (push) {
    safePushState(state, '', url.toString());
  } else {
    safeReplaceState(state, '', url.toString());
  }
}

function readRoute(): string | null {
  const url = new URL(window.location);
  return url.searchParams.get(config.prefix) || null;
}
```

**Key advantage**: No `hashchange` event fired at all, even on back/forward. The host only sees `popstate`, and the `STATE_KEY` check filters the embed's entries.

**Key risk**: Requires `pushState`, which is the API most likely to be monkey-patched. Depends on the captured-native-API technique working. Also, some hosts strip unknown query params on page load — the intent buffer handles this.

### Strategy: `hash-direct`

For environments where `pushState` is completely hostile (host's monkey-patch throws errors, or the host actively reverts pushState changes). Sets `location.hash` directly.

```javascript
function writeRoute(path, push = true) {
  // This WILL fire hashchange. No way around it.
  window.location.hash = `${config.prefix}:${path}`;
  // Cannot distinguish push vs replace — hash assignment always pushes.
}
```

**Trade-off**: `hashchange` fires and the host may react, but with namespacing, most hosts ignore unrecognized hashes. No `pushState` call at all, so monkey-patching is irrelevant. Cannot do `replaceState` — every hash change creates a history entry.

### Strategy: `none`

Maximum isolation. No URL reflection at all. Route state lives only in the router core and intent buffer (sessionStorage). Back/forward within the embed is handled via the internal stack only.

Shareable URLs are generated on demand rather than maintained in the address bar:

```javascript
function getShareableURL(path) {
  const url = new URL(window.location);
  url.hash = `${config.prefix}:${path}`;
  return url.toString();
}
```

---

## Click Handling

Click handling behavior depends entirely on the link mode.

### Reload mode

In reload mode, the embed uses real `<a>` tags with real `href` attributes. The click handler's only job is to set the navigation intent before the browser follows the link:

```javascript
function handleClick(event, path) {
  // Store intent — this is the primary routing mechanism in reload mode
  setIntent(config.embedId, path);
  // Do NOT preventDefault — let the browser follow the href naturally.
  // The host CMS handles the page transition. The embed re-mounts on
  // the new page and reads the intent buffer.
}
```

The `<a>` tag's `href` is still set to a valid URL (hash or query param format) so that if sessionStorage fails, the URL itself carries the route.

### SPA mode

In SPA mode, the embed must prevent the click from reaching the host's navigation system. Multiple lines of defense, applied in combination:

#### Defense 1: Cooperative opt-out attributes

Some host CMSs check for opt-out signals on links. Adding `data-excludelink="true"` (or similar CMS-specific attributes) tells well-behaved hosts to leave the link alone. This is the cheapest defense and should always be applied:

```html
<a href="#evg:/race/123"
   data-excludelink="true"
   data-evg-link="/race/123">
  Race Name
</a>
```

The `data-excludelink` attribute costs nothing and handles the cooperative case. The `data-evg-link` attribute is the embed's own marker for its click handler.

#### Defense 2: Capture-phase listener with stopImmediatePropagation

```javascript
embedRoot.addEventListener('click', (event) => {
  const link = event.target.closest('[data-evg-link]');
  if (!link) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const path = link.getAttribute('data-evg-link');
  setIntent(config.embedId, path);
  router.navigate(path);
}, { capture: true });
```

`stopImmediatePropagation()` (not just `stopPropagation`) prevents other listeners on the same element from firing. `capture: true` ensures this fires during the capture phase, before bubble-phase listeners on ancestor elements.

**Limitation**: If the host has a capture-phase listener on `document`, it fires before the embed root's capture listener (capture phase goes outside-in). See Defense 4.

#### Defense 3: Avoid `<a>` tags for navigation links

Host SPA routers typically intercept clicks on `<a>` elements specifically (checking `event.target.closest('a')` or similar). Using non-anchor elements sidesteps this entirely:

```html
<span role="link" tabindex="0"
      data-evg-link="/race/123"
      data-excludelink="true"
      aria-label="View Race Name">
  Race Name
</span>
```

Add keyboard handling (Enter/Space) for accessibility. This is the most reliable defense against click interception, at the cost of losing native anchor semantics (right-click → open in new tab, middle-click, etc.).

#### Defense 4: Shadow DOM isolation

If the host's capture-phase `document` listener checks selectors or walks the DOM, a Shadow DOM root prevents it from seeing the embed's internal elements:

```javascript
const shadow = embedRoot.attachShadow({ mode: 'open' });
// Render embed content inside shadow root
// Host's document-level listeners can't query into the shadow
```

Reserve this for environments where the host's click interception is especially aggressive. Shadow DOM adds CSS isolation complexity.

#### Recommended layering

Apply defenses cumulatively, not as alternatives:

1. **Always**: `data-excludelink="true"` on all embed `<a>` tags (zero cost)
2. **Always in SPA mode**: Capture-phase click handler with `stopImmediatePropagation`
3. **If host still intercepts**: Switch to non-anchor elements (Defense 3)
4. **If host intercepts in capture phase on document**: Shadow DOM (Defense 4)

### External content links

The embed may render HTML content from the API that contains `<a>` tags pointing to external URLs (e.g., links within candidate answers). These are not navigation links — they should open in a new tab and must not be intercepted by the host or the embed's own click handler.

After rendering API content, walk the DOM and set `target="_blank"` on anchor tags within content areas. The embed's click handler already ignores links that don't have `data-evg-link`, but the host's click handler won't — so these links still need protection:

```javascript
function patchExternalLinks(containerEl) {
  const links = containerEl.querySelectorAll('a:not([data-evg-link])');
  for (const link of links) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('data-excludelink', 'true');
  }
}
```

Call this after every render that inserts API-provided HTML.

---

## Popstate Filtering

When the user hits back/forward, both the host's and the embed's `popstate` listeners fire. The embed must handle its own entries and ignore the host's.

### Identifying embed entries

Every `pushState` call from the adapter includes a state object with the `__electup` key and the embed ID:

```javascript
safePushState({
  __electup: true,
  embedId: config.embedId,
  path: '/race/123'
}, '', url);
```

The `popstate` handler checks this:

```javascript
window.addEventListener('popstate', (event) => {
  if (config.linkMode !== 'spa') return; // reload mode doesn't use popstate

  if (event.state?.__electup && event.state.embedId === config.embedId) {
    event.stopImmediatePropagation();
    routerCore.handleExternalNavigation(event.state.path);
  }
  // Not ours — do nothing, let the host handle it
}, true); // capture phase
```

### Preventing host crash on embed entries

The harder problem: when back/forward lands on an embed entry, the host's `popstate` handler also fires. The host sees a URL it may not recognize and crashes.

**Mitigation A: Hash-only changes.** If the embed only modifies the hash (Strategy `hash`), the host's path-based router sees an unchanged path and typically short-circuits. This is the primary reason `hash` is the default strategy.

**Mitigation B: Preserve all host URL components.** When writing the URL, always read the current path and query params and write them back unchanged:

```javascript
function writeRoute(path, push = true) {
  const url = new URL(window.location);
  // Only touch our specific part — hash or one query param
  // Path and all other params are preserved
  url.hash = `${config.prefix}:${path}`;
  safePushState({ __electup: true, embedId: config.embedId, path }, '', url.toString());
}
```

When the host's `popstate` handler reads the URL, it sees its own path/params intact and is less likely to react destructively.

**Mitigation C: Suppress `hashchange` propagation.** If using hash strategy and the host listens to `hashchange`:

```javascript
let suppressNextHashChange = false;

window.addEventListener('popstate', (event) => {
  if (event.state?.__electup && event.state.embedId === config.embedId) {
    suppressNextHashChange = true;
    event.stopImmediatePropagation();
    routerCore.handleExternalNavigation(event.state.path);
  }
}, true);

// Must be added BEFORE host's hashchange listener to work
window.addEventListener('hashchange', (event) => {
  if (suppressNextHashChange) {
    suppressNextHashChange = false;
    event.stopImmediatePropagation();
  }
}, true); // capture phase
```

**Mitigation D: Tag initial state.** On first load, if the current history state doesn't already have the embed's tag, add it via `replaceState`. This ensures that if the user navigates forward into the embed and then hits back, the initial entry is recognized:

```javascript
if (config.linkMode === 'spa' && !history.state?.__electup) {
  safeReplaceState(
    { ...history.state, __electup: true, embedId: config.embedId },
    ''
  );
}
```

---

## Cold Start / Page Load

On page load, the embed needs to determine its initial route. Priority order:

```
1. Navigation intent buffer (sessionStorage)  — handles reload mode + async URL rewriting
2. URL (via adapter's readRoute)              — handles direct link / shared URL
3. Default route                               — fallback to index screen
```

```javascript
function resolveInitialRoute(): string {
  // 1. Check intent buffer (survives cross-page navigation)
  const intent = consumeIntent(config.embedId);
  if (intent) return intent;

  // 2. Read URL via configured strategy
  const fromURL = adapter.readRoute();
  if (fromURL) return fromURL;

  // 3. Default
  return '/';
}
```

### Deferred initialization

Some hosts do URL cleanup on load (`replaceState` to normalize the URL, strip unknown params). The embed should delay its initial URL read slightly to run after the host's init:

```javascript
function initialize() {
  requestAnimationFrame(() => {
    queueMicrotask(() => {
      const initialPath = resolveInitialRoute();
      routerCore.initialize(initialPath);
    });
  });
}
```

If the host strips the URL during its init, the intent buffer (populated before the page navigation that triggered this load) will still have the correct path.

### Re-initialization after host soft navigation

Some host SPAs do soft navigations that destroy and recreate DOM regions without a full page load. The embed needs to detect this and re-mount. Two mechanisms:

**Custom event**: The embed listens for a re-initialization event that the host (or the embed's own loader script) can dispatch:

```javascript
window.addEventListener('electup_load', () => {
  const appEl = document.getElementById(config.embedId);
  if (appEl && !appEl.__mounted) {
    mount(appEl);
  }
});
```

**Guard against double-mounting**: Always check whether the embed is already mounted before initializing. The host may fire the event multiple times.

---

## Navigation Lifecycle

Every navigation — whether triggered by a user click, back/forward, or cold start — follows the same lifecycle. The router emits events at each stage so the embedding application can hook in.

### Lifecycle stages

```
1. Intent set        →  setIntent() stores path in sessionStorage
2. Route resolved    →  router core updates current route + params
3. URL written       →  adapter writes route to URL (SPA mode only)
4. Application fetch →  (application responsibility — not the router's job)
5. Render complete   →  application signals completion
6. Post-render       →  scroll to embed, patch external links, emit loaded event
```

Steps 4 and 5 are the application's responsibility. The router provides hooks for the application to signal completion, and handles step 6 itself.

### Navigation complete event

After the application signals that rendering is done, the router dispatches a `CustomEvent` on the document. This is the integration point for host pages and iframe parents (e.g., pym.js) that need to know the embed has finished updating:

```javascript
function emitNavigationComplete() {
  document.dispatchEvent(new CustomEvent('electupLoaded', {
    bubbles: false,  // don't let host page scripts react unexpectedly
    detail: {
      path: routerCore.current.path,
      params: routerCore.current.params,
      embedId: config.embedId
    }
  }));
}
```

The application calls `router.navigationComplete()` after its render settles, which triggers this event and the post-render steps.

### Scroll to embed

After navigation completes and the DOM has updated, scroll the viewport so the embed is visible. This matters because the embed may be far down a long page, and after a route change the user expects to see the new content.

```javascript
function scrollToEmbed() {
  const el = document.getElementById(config.embedId);
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const targetTop = rect.top + window.scrollY - (window.innerHeight * 0.08);

  // Only scroll UP to the embed — don't scroll down if the user is already
  // above it (they may have scrolled past intentionally)
  if (window.scrollY > targetTop) {
    window.scrollTo({ top: targetTop });
  }
}
```

In reload mode, a different mechanism is needed because the embed re-mounts after a full page load and doesn't know whether the navigation was triggered by an embed link or a normal page visit. The production approach uses a short-lived cookie:

```javascript
// In the click handler (before page transition):
document.cookie = 'fromEmbed=1; max-age=30; path=/';

// On mount (after page load):
function shouldScrollOnMount(): boolean {
  if (document.cookie.includes('fromEmbed=1')) {
    document.cookie = 'fromEmbed=; max-age=0; path=/';
    return true;
  }
  return false;
}
```

The cookie survives the page transition (unlike in-memory state) and is consumed on mount. `max-age=30` ensures it expires quickly if the user navigates away without hitting the embed.

---

## Resilience Mechanisms

### Mutation observer for DOM removal

Some CMSs run cleanup passes that remove or replace DOM nodes. If the embed's root element is removed, detect it and re-mount:

```javascript
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.removedNodes) {
      if (node === embedRoot || node.contains(embedRoot)) {
        remount();
        return;
      }
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });
```

### URL state recovery

After writing a route to the URL, verify it stuck:

```javascript
function writeRouteWithVerify(path, push = true) {
  writeRoute(path, push);

  // Check after a tick — if host reverted, retry once
  setTimeout(() => {
    const current = readRoute();
    if (current !== path) {
      // Host overwrote us. Try replaceState (less disruptive).
      writeRoute(path, false);
    }
  }, 50);
}
```

Don't retry indefinitely — if the host is actively fighting, degrade to `none` strategy and rely on the intent buffer.

### Multiple embeds on one page

If a page has multiple embeds, each needs its own namespace in the URL and sessionStorage. The `embedId` config parameter handles this:

```
#evg-ballot:/race/123    (embedId: 'ballot')
#evg-guide:/candidate/45 (embedId: 'guide')

?evg-ballot=/race/123&evg-guide=/candidate/45
```

Each embed's adapter reads/writes only its own namespaced key. The `popstate` state object includes the `embedId` so handlers can filter:

```javascript
safePushState({
  __electup: true,
  embedId: config.embedId,
  path: '/race/123'
}, '', url);

// In popstate handler:
if (event.state?.__electup && event.state.embedId === config.embedId) {
  // This is ours
}
```

Intent buffer keys are also namespaced: `electup_nav_ballot`, `electup_nav_guide`.

### sessionStorage as shared infrastructure

The embed uses sessionStorage for multiple concerns: the navigation intent buffer, and potentially analytics state (visit ID, session start, screen depth). All keys must be namespaced under a consistent scheme:

```
electup_nav_{embedId}          — navigation intent buffer
electup_visit_{embedId}        — analytics visit ID
electup_session_{embedId}      — analytics session state
```

The router library owns the `electup_nav_*` keys. Other keys are the application's responsibility, but the naming convention should be documented to avoid collisions.

---

## Strategy Selection Guide

| Host behavior | URL strategy | Link mode | Reason |
|---|---|---|---|
| Standard CMS (WordPress, Drupal, static) | `hash` | `spa` | Low risk. Hash changes don't affect path-based hosts. |
| SPA with path-based routing (React/Next/Vue) | `hash` | `spa` | Host router ignores hash. No `hashchange` fired via pushState. |
| WordPress with WPR / SPA transition themes | `hash` | `spa` | Capture-phase popstate + stopImmediatePropagation handles WPR. |
| Host actively uses hash (anchor links, hash routing) | `queryparam` | `spa` | Avoids hash collision entirely. |
| Grove / Brightspot | `queryparam` | `reload` | Host requires full page transitions. Intent buffer handles async URL. |
| Host monkey-patches pushState AND uses hash | `hash-direct` | `spa` | No pushState call. hashchange fires but namespaced. |
| Maximally hostile (pushState breaks, hash breaks) | `none` | `spa` | Internal routing only. Share via explicit button. |

Default to `hash` + `spa`. Only change when a specific interference pattern is observed and documented for that host.

---

## Implementation Checklist

### Phase 1: Core

- [ ] Route matcher (path patterns → extracted params)
- [ ] Internal history stack (entries + index)
- [ ] `navigate`, `replace`, `back`, `forward` methods
- [ ] Subscription system for route changes
- [ ] `navigationComplete()` method + event dispatch
- [ ] `reconfigure()` for late strategy changes

### Phase 2: URL Adapter

- [ ] Native API capture (prototype grab + iframe fallback)
- [ ] `hash` strategy (pushState with namespaced hash)
- [ ] `queryparam` strategy (pushState with namespaced param)
- [ ] `hash-direct` strategy (location.hash assignment)
- [ ] `none` strategy (internal only + shareable URL generation)
- [ ] `popstate` listener with state key filtering (capture phase)
- [ ] `hashchange` suppression (capture phase)
- [ ] Cold start route resolution (intent buffer → URL → default)
- [ ] Strategy resolution chain (config → API → runtime detection → default)
- [ ] Late reconfiguration support

### Phase 3: Intent Buffer

- [ ] `setIntent` / `consumeIntent` with sessionStorage
- [ ] Namespace by embedId
- [ ] Timestamp-based expiration
- [ ] Graceful degradation when sessionStorage unavailable

### Phase 4: Click Handling

- [ ] `data-excludelink="true"` on all embed links (cooperative defense)
- [ ] Capture-phase listener on embed root with `stopImmediatePropagation`
- [ ] SPA mode: preventDefault + navigate
- [ ] Reload mode: setIntent + let browser follow href
- [ ] External content link patching (`target="_blank"` post-render)
- [ ] Keyboard accessibility (Enter/Space on non-anchor elements, if used)

### Phase 5: Navigation Lifecycle

- [ ] Scroll-to-embed after SPA navigation
- [ ] `fromEmbed` cookie for scroll-on-mount (reload mode)
- [ ] `electupLoaded` custom event dispatch
- [ ] `electup_load` listener for re-initialization after host soft navigation
- [ ] Double-mount guard

### Phase 6: Resilience

- [ ] DOM removal detection via MutationObserver
- [ ] URL write verification + retry
- [ ] Deferred initialization for host cleanup passes
- [ ] Multi-embed namespace support (URL + sessionStorage)

---

## Testing Matrix

Each strategy × link mode combination should be tested against these host environments:

| Environment | Click interception | hashchange | popstate | pushState patching | URL rewriting | Recommended config |
|---|---|---|---|---|---|---|
| Static HTML | No | No | No | No | No | hash + spa |
| WordPress (standard theme) | Possible | Possible | No | No | No | hash + spa |
| WordPress (WPR / SPA themes) | Yes | Yes | Yes | Likely | Possible | hash + spa |
| Squarespace | Yes | Yes | No | No | Yes | queryparam + spa |
| React SPA (CRA / Next.js) | Yes | No | Yes | Yes | No | hash + spa |
| Vue SPA (Nuxt) | Yes | No | Yes | Yes | No | hash + spa |
| Grove / Brightspot | Yes | Possible | Yes | Possible | Yes (async) | queryparam + reload |
| AMP pages | Restricted | Restricted | Restricted | Restricted | Restricted | none + spa |

### Test procedure per cell

1. Deploy embed with configured strategy + link mode.
2. Navigate through 3+ screens within the embed.
3. Verify back/forward walks through embed history correctly.
4. Copy URL from address bar, open in new tab — verify deep link restores correct screen.
5. Verify host page console has no errors caused by the embed's navigation.
6. Verify host page's own navigation (if any) still works alongside the embed.
7. Verify scroll-to-embed behavior on navigation.
8. Verify external links within API content open in new tabs.
