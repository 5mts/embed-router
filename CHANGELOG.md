# Changelog

## Unreleased

### Breaking Changes

- **Hash strategy: empty hash returns `null`** — `HashStrategy.read()` now returns `null` for empty (`#`), bare (`#/`), and missing hashes instead of returning `'/'`. This lets initial route resolution fall through to the goingTo cue, `history.state` backup, or default route correctly. If your code depended on hash mode resolving `#` or `#/` to the root route, it will now resolve via `defaultRoute` (which defaults to `'/'` anyway, so in practice this is unlikely to break anything).

- **`navigate()` argument parsing** — The heuristic for distinguishing path vs named-route calls has changed. Previously it checked for `'historyMode' in params`. Now it uses `pathOrName.startsWith('/')`: paths start with `/`, everything else is a route name. Add `{ named: true/false }` in the options object to override when the heuristic isn't sufficient. If you only ever passed paths starting with `/` or used named routes with a params object, no change is needed.

- **goingTo cue format** — `storeGoingTo()` now writes JSON (`{ path, ts }`) to sessionStorage instead of a bare string. The router reads both formats, so existing cues written by older versions will still work. However, if you had external code reading the goingTo key directly, update it to parse JSON.

### New Features

- **Native History API capture** — All internal `pushState`/`replaceState` calls now use captured native references that bypass host monkey-patches (React Router, Vue Router, GTM, etc.). Includes iframe fallback when the prototype is already patched. New exports: `safePushState`, `safeReplaceState`, `captureHistoryApi`.

- **Capture-phase popstate handling** — The `popstate` listener is now registered in capture phase. Embed history entries (tagged with our state key) are handled immediately with `stopImmediatePropagation()`, preventing host frameworks from seeing them and crashing. Non-embed entries are deferred by one tick as before. In hash mode, the subsequent `hashchange` event is also suppressed for our entries.

- **`reconfigure({ mode, linkMode })`** — Switch URL strategy or link mode at runtime, typically after an API response provides the embed's server-side configuration. Preserves current route; only the URL representation changes.

- **`restart()`** — Re-emit the current route for subscribers when the embed re-mounts without a full page reload. Falls through to `start()` if not yet started.

- **`navigationComplete(options)`** — Signal that rendering is complete after a navigation. Scrolls the embed into view (only upward), dispatches an `electupLoaded` CustomEvent on `document`, and emits `navigationComplete` on the router's emitter.

- **`embedId` config** — DOM element ID of the embed container, used by `navigationComplete()` for scroll targeting and event detail.

- **`linkMode` config** — Explicit control over SPA vs reload navigation (`'spa'` | `'reload'`). Defaults to `'spa'` for hash mode, `'reload'` for query mode.

- **`prefix` config (hash mode)** — Optional hash namespace prefix to prevent collisions with host anchor links. With `prefix: 'evg'`, URLs become `#evg:/path` and host hashes like `#contact` are ignored.

- **`getParamName()`** — Returns the query parameter name (e.g., `'route'`, `'a.route'`) or `null` in hash mode. Replaces internal `_strategy.param` access.

- **`getLinkMode()`** — Returns the current link mode (`'spa'` or `'reload'`).

- **`storeGoingTo(pathOrName, [params])`** — Public API for storing reload-mode navigation intent in sessionStorage. Includes 10-second TTL to expire stale cues.

- **Initial history state tagging** — In SPA mode, `start()` tags the initial history entry with the router's state key via `replaceState`. This ensures back-button from the first embed navigation is recognized as ours and suppressed from host handlers.

- **`{ named }` option for `navigate()`** — Explicit override for the path-vs-name heuristic: `navigate('foo', {}, { named: false })` forces path interpretation.

### Improvements

- **goingTo TTL** — Stored navigation intents expire after 10 seconds, preventing stale cues from hijacking the initial route on unrelated page loads.

- **`destroy()` uses capture phase** — Event listener removal now correctly passes the capture flag, matching how listeners were registered. Previously, bubble-phase `removeEventListener` would fail to remove capture-phase listeners.

### Documentation

- Added `data-excludelink` guidance for manual link building with `buildUrl()`.
- README fully updated to cover all new config options, methods, exports, and concepts.
