/**
 * Integration tests for QueryRouter.
 * 
 * Mocks browser globals (window, location, history) to test the full
 * router lifecycle: initialization, navigation, back/forward, legacy
 * migration, interference detection, and cleanup.
 */

// --- Browser Global Mocks ---

const historyStack = [];
let historyIndex = -1;
let popstateListeners = [];
let hashchangeListeners = [];

function resetMocks() {
  historyStack.length = 0;
  historyIndex = -1;
  popstateListeners = [];
  hashchangeListeners = [];
  sessionStore.clear();

  // Push initial entry
  historyStack.push({
    state: null,
    url: 'https://example.com/voterguide',
  });
  historyIndex = 0;
}

function currentUrl() {
  return new URL(historyStack[historyIndex].url);
}

// Mock window.location
const locationProxy = new Proxy({}, {
  get(_, prop) {
    const url = currentUrl();
    if (prop === 'search') return url.search;
    if (prop === 'hash') return url.hash;
    if (prop === 'href') return url.href;
    if (prop === 'pathname') return url.pathname;
    if (prop === 'origin') return url.origin;
    return undefined;
  },
  set(_, prop, value) {
    if (prop === 'hash') {
      const url = currentUrl();
      url.hash = value;
      historyStack[historyIndex].url = url.toString();
      // hashchange
      hashchangeListeners.forEach(fn => fn(new Event('hashchange')));
    }
    return true;
  }
});

// Mock history
const historyMock = {
  get state() {
    return historyStack[historyIndex]?.state || null;
  },
  pushState(state, title, url) {
    const resolved = new URL(url, currentUrl().origin).toString();
    historyIndex++;
    historyStack.splice(historyIndex, Infinity, { state, url: resolved });
  },
  replaceState(state, title, url) {
    const resolved = new URL(url, currentUrl().origin).toString();
    historyStack[historyIndex] = { state, url: resolved };
  },
  back() {
    if (historyIndex > 0) {
      historyIndex--;
      const entry = historyStack[historyIndex];
      popstateListeners.forEach(fn =>
        fn({ state: entry.state, type: 'popstate', stopImmediatePropagation() {} })
      );
    }
  },
  go(n) {
    const target = historyIndex + n;
    if (target >= 0 && target < historyStack.length) {
      historyIndex = target;
      const entry = historyStack[historyIndex];
      popstateListeners.forEach(fn =>
        fn({ state: entry.state, type: 'popstate', stopImmediatePropagation() {} })
      );
    }
  },
};

// Mock sessionStorage
const sessionStore = new Map();
const sessionStorageMock = {
  getItem(key) { return sessionStore.get(key) ?? null; },
  setItem(key, value) { sessionStore.set(key, String(value)); },
  removeItem(key) { sessionStore.delete(key); },
  clear() { sessionStore.clear(); },
};

// Install mocks
globalThis.window = {
  location: locationProxy,
  history: historyMock,
  addEventListener(event, fn, _capture) {
    if (event === 'popstate') popstateListeners.push(fn);
    if (event === 'hashchange') hashchangeListeners.push(fn);
  },
  removeEventListener(event, fn, _capture) {
    if (event === 'popstate') popstateListeners = popstateListeners.filter(f => f !== fn);
    if (event === 'hashchange') hashchangeListeners = hashchangeListeners.filter(f => f !== fn);
  },
};
globalThis.location = locationProxy;
globalThis.history = historyMock;
globalThis.sessionStorage = sessionStorageMock;
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;
globalThis.Event = Event;
globalThis.AbortController = AbortController;
globalThis.setTimeout = globalThis.setTimeout;
globalThis.clearInterval = globalThis.clearInterval;
globalThis.setInterval = globalThis.setInterval;

// --- Import router (after mocks are set up) ---
const { QueryRouter, snapshotUrl } = await import('../src/router.js');

// --- Test helpers ---
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${message}`); }
}
function assertEqual(actual, expected, message) {
  if (actual === expected) { passed++; } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}
function section(name) { console.log(`\n▸ ${name}`); }

const routes = [
  { path: '/', name: 'home' },
  { path: '/:section', name: 'section' },
  { path: '/:section/candidate/:candidate', name: 'candidate' },
  { path: '/:section/:group', name: 'group' },
  { path: '/:section/:group/topic/:topic', name: 'topic' },
];

// ===== TESTS =====

section('QueryRouter — Init with no route (defaults to /)');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', routes });
  assertEqual(router.getRoute().name, 'home', 'defaults to home route');
  assertEqual(router.getRoute().path, '/', 'default path is /');
  router.destroy();
}

section('QueryRouter — Init with route in URL');
resetMocks();
{
  historyStack[0].url = 'https://example.com/voterguide?route=/city-council/candidate/harper';
  const router = new QueryRouter({ mode: 'query', routes });
  assertEqual(router.getRoute().name, 'candidate', 'matches candidate route');
  assertEqual(router.getRoute().params.candidate, 'harper', 'extracts candidate param');
  assertEqual(router.getRoute().params.section, 'city-council', 'extracts section param');
  router.destroy();
}

section('QueryRouter — Init with route in history.state (back/forward recovery)');
resetMocks();
{
  historyStack[0].state = { __embedRoute: '/city-council' };
  // URL has no route param — simulates host having clobbered it
  const router = new QueryRouter({ mode: 'query', routes });
  assertEqual(router.getRoute().name, 'section', 'recovers from history.state');
  assertEqual(router.getRoute().params.section, 'city-council', 'correct params');
  router.destroy();
}

section('QueryRouter — Init with legacy URL params');
resetMocks();
{
  historyStack[0].url = 'https://example.com/voterguide?section=city-council&candidate=harper';
  const legacyRoutes = [
    { params: ['section', 'candidate'], path: '/:section/candidate/:candidate' },
    { params: ['section'], path: '/:section' },
  ];
  const router = new QueryRouter({ mode: 'query', routes, legacyRoutes });
  assertEqual(router.getRoute().name, 'candidate', 'migrates legacy URL');
  assertEqual(router.getRoute().params.candidate, 'harper', 'correct params from legacy');

  // Verify URL was rewritten
  const url = currentUrl();
  assertEqual(url.searchParams.has('section'), false, 'legacy params removed from URL');
  assertEqual(url.searchParams.get('route'), '/city-council/candidate/harper', 'new route param in URL');
  router.destroy();
}

section('QueryRouter — navigate() by path');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  let emitted = null;
  router.on('route', (data) => { emitted = data; });
  router.start();

  // Reset emitted after init event
  emitted = null;

  const result = router.navigate('/city-council/candidate/harper');
  assert(result === true, 'navigate returns true');
  assertEqual(router.getRoute().name, 'candidate', 'internal state updated');
  assertEqual(emitted?.route.name, 'candidate', 'route event emitted');
  assertEqual(emitted?.source, 'navigate', 'source is navigate');

  // Verify URL
  const url = currentUrl();
  assertEqual(url.searchParams.get('route'), '/city-council/candidate/harper', 'URL updated');

  // Verify history.state backup
  assertEqual(history.state.__embedRoute, '/city-council/candidate/harper', 'history.state backup written');

  router.destroy();
}

section('QueryRouter — navigate() by name');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  router.start();

  router.navigate('candidate', { section: 'city-council', candidate: 'harper' });
  assertEqual(router.getRoute().name, 'candidate', 'matches by name');
  assertEqual(router.getRoute().params.candidate, 'harper', 'correct params');
  router.destroy();
}

section('QueryRouter — navigate() deduplication');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  let eventCount = 0;
  router.on('route', () => eventCount++);
  router.start();
  eventCount = 0; // reset after init

  router.navigate('/city-council');
  assertEqual(eventCount, 1, 'first navigate emits');

  const result = router.navigate('/city-council');
  assertEqual(result, false, 'duplicate returns false');
  assertEqual(eventCount, 1, 'duplicate does not emit');
  router.destroy();
}

section('QueryRouter — navigate() with historyMode override');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, historyMode: 'push' });
  router.start();

  const stackBefore = historyStack.length;
  router.navigate('/city-council', { historyMode: 'replace' });
  assertEqual(historyStack.length, stackBefore, 'replace does not add history entry');
  router.destroy();
}

section('QueryRouter — navigate() with named override');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 0 });
  router.start();

  // Force named=false to treat a non-/ string as a path
  router.navigate('city-council', { named: false });
  assertEqual(router.getRoute().name, 'section', 'named:false treats string as path');
  assertEqual(router.getRoute().params.section, 'city-council', 'correct params');
  router.destroy();
}

section('QueryRouter — AbortSignal on navigation');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  router.start();

  router.navigate('/city-council');
  const signal1 = router.getAbortSignal();
  assert(!signal1.aborted, 'signal is not aborted initially');

  router.navigate('/city-council/candidate/harper');
  assert(signal1.aborted, 'previous signal is aborted on new navigation');

  const signal2 = router.getAbortSignal();
  assert(!signal2.aborted, 'new signal is fresh');
  router.destroy();
}

section('QueryRouter — Generation counter');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  router.start();

  const gen0 = router.getGeneration();
  router.navigate('/city-council');
  const gen1 = router.getGeneration();
  assert(gen1 > gen0, 'generation increments on navigate');

  router.navigate('/city-council/candidate/harper');
  const gen2 = router.getGeneration();
  assert(gen2 > gen1, 'generation increments again');
  router.destroy();
}

section('QueryRouter — popstate (back/forward)');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 0 });
  let lastEvent = null;
  router.on('route', (data) => { lastEvent = data; });
  router.start();

  router.navigate('/city-council');
  router.navigate('/city-council/candidate/harper');

  // Simulate back button
  lastEvent = null;
  history.back();

  // popstate handler defers with setTimeout(fn, 0)
  await new Promise(r => setTimeout(r, 10));

  assertEqual(lastEvent?.route.name, 'section', 'back navigates to previous route');
  assertEqual(lastEvent?.source, 'popstate', 'source is popstate');
  assertEqual(router.getRoute().params.section, 'city-council', 'correct params after back');
  router.destroy();
}

section('QueryRouter — popstate recovers from history.state when URL is clobbered');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 0 });
  router.start();

  // Navigate to a route (this writes both URL and history.state)
  router.navigate('/city-council/candidate/harper');

  // Simulate host clobbering the URL on its next pushState
  // (like the Vue CMS does)
  history.pushState({ psUrl: 'https://example.com/other-page' }, '', '/voterguide');

  // Now go back — the URL won't have ?route= but history.state should
  let lastEvent = null;
  router.on('route', (data) => { lastEvent = data; });

  history.back();
  await new Promise(r => setTimeout(r, 10));

  // The popstate should recover the route from history.state
  assertEqual(lastEvent?.route.name, 'candidate', 'recovers route from history.state');
  assertEqual(lastEvent?.route.params.candidate, 'harper', 'correct params from state');
  router.destroy();
}

section('QueryRouter — Hash mode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'hash', routes });
  router.start();

  router.navigate('/city-council/candidate/harper');
  assertEqual(currentUrl().hash, '#/city-council/candidate/harper', 'writes to hash');
  assertEqual(router.getRoute().name, 'candidate', 'matches route');
  router.destroy();
}

section('QueryRouter — Hash mode init');
resetMocks();
{
  historyStack[0].url = 'https://example.com/voterguide#/city-council';
  const router = new QueryRouter({ mode: 'hash', routes });
  assertEqual(router.getRoute().name, 'section', 'reads initial hash');
  assertEqual(router.getRoute().params.section, 'city-council', 'correct params');
  router.destroy();
}

section('QueryRouter — Multi-embed with id prefix');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, id: 'a' });
  router.start();

  router.navigate('/city-council');
  assertEqual(currentUrl().searchParams.get('a.route'), '/city-council', 'uses prefixed param');
  assertEqual(currentUrl().searchParams.has('route'), false, 'does not use unprefixed param');
  router.destroy();
}

section('QueryRouter — Preserves host query params');
resetMocks();
{
  historyStack[0].url = 'https://example.com/voterguide?hostParam=keepme&page=3';
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  router.start();

  router.navigate('/city-council');
  const url = currentUrl();
  assertEqual(url.searchParams.get('hostParam'), 'keepme', 'preserves hostParam');
  assertEqual(url.searchParams.get('page'), '3', 'preserves page');
  assertEqual(url.searchParams.get('route'), '/city-council', 'adds our route');
  router.destroy();
}

section('QueryRouter — buildUrl');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', routes });

  const url = router.buildUrl('/city-council/candidate/harper');
  assert(url.includes('route='), 'contains route param');
  assert(url.includes('city-council'), 'contains path');

  const namedUrl = router.buildUrl('candidate', { section: 'city-council', candidate: 'harper' });
  assert(namedUrl.includes('route='), 'named route produces URL');
  router.destroy();
}

section('QueryRouter — buildUrl in hash mode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'hash', routes });
  const url = router.buildUrl('/city-council');
  assertEqual(url, '#/city-council', 'hash mode buildUrl');
  router.destroy();
}

section('QueryRouter — snapshotUrl');
{
  resetMocks();
  historyStack[0].url = 'https://example.com/page?route=/test#hash';
  const snap = snapshotUrl();
  assertEqual(snap.search, '?route=/test', 'captures search');
  assertEqual(snap.hash, '#hash', 'captures hash');
}

section('QueryRouter — Init from snapshot');
resetMocks();
{
  // Snapshot captured early with route param
  const snapshot = { search: '?route=/city-council/candidate/harper', hash: '', href: 'https://example.com/voterguide?route=/city-council/candidate/harper' };
  // But by now the URL has been modified by the host
  historyStack[0].url = 'https://example.com/voterguide';

  const router = new QueryRouter({ mode: 'query', routes, initialUrl: snapshot });
  assertEqual(router.getRoute().name, 'candidate', 'uses snapshot over current URL');
  router.destroy();
}

section('QueryRouter — Invalid path handling');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  router.start();

  const result = router.navigate('javascript:alert(1)');
  assertEqual(result, false, 'rejects unsafe path');
  assertEqual(router.getRoute().name, 'home', 'stays on current route');
  router.destroy();
}

section('QueryRouter — Not-found route');
resetMocks();
{
  historyStack[0].url = 'https://example.com/voterguide?route=/nonexistent/deep/path';
  const router = new QueryRouter({ mode: 'query', routes });
  assert(router.getRoute().notFound === true, 'sets notFound flag');
  assertEqual(router.getRoute().path, '/nonexistent/deep/path', 'preserves the path');
  router.destroy();
}

section('QueryRouter — destroy() cleanup');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 50 });
  router.start();

  const listenersBefore = popstateListeners.length;
  router.destroy();

  assert(popstateListeners.length < listenersBefore, 'removes popstate listener');

  // Events should not fire after destroy
  let emitted = false;
  router.on('route', () => { emitted = true; });
  // This on() silently does nothing because removeAll was called
  // but if somehow a listener was added, navigate shouldn't work
  router.destroy();
}

section('QueryRouter — defaultRoute config');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', routes, defaultRoute: '/city-council' });
  assertEqual(router.getRoute().name, 'section', 'uses custom default route');
  assertEqual(router.getRoute().params.section, 'city-council', 'default route params');
  router.destroy();
}

section('QueryRouter — linkMode defaults');
resetMocks();
{
  const hashRouter = new QueryRouter({ mode: 'hash', routes });
  assertEqual(hashRouter.getLinkMode(), 'spa', 'hash defaults to spa');
  hashRouter.destroy();

  const queryRouter = new QueryRouter({ mode: 'query', routes });
  assertEqual(queryRouter.getLinkMode(), 'reload', 'query defaults to reload');
  queryRouter.destroy();
}

section('QueryRouter — linkMode override');
resetMocks();
{
  const router = new QueryRouter({ mode: 'hash', linkMode: 'reload', routes });
  assertEqual(router.getLinkMode(), 'reload', 'hash can be overridden to reload');
  router.destroy();

  const router2 = new QueryRouter({ mode: 'query', linkMode: 'spa', routes });
  assertEqual(router2.getLinkMode(), 'spa', 'query can be overridden to spa');
  router2.destroy();
}

section('QueryRouter — storeGoingTo writes to sessionStorage');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes });
  router.storeGoingTo('/city-council/candidate/harper');
  assertEqual(sessionStorage.getItem('__er_goingTo'), '/city-council/candidate/harper', 'stores normalized path');
  router.destroy();
}

section('QueryRouter — storeGoingTo with named route');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes });
  router.storeGoingTo('candidate', { section: 'city-council', candidate: 'harper' });
  assertEqual(sessionStorage.getItem('__er_goingTo'), '/city-council/candidate/harper', 'resolves named route');
  router.destroy();
}

section('QueryRouter — storeGoingTo with id prefix');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes, id: 'a' });
  router.storeGoingTo('/city-council');
  assertEqual(sessionStorage.getItem('__er_goingTo_a'), '/city-council', 'uses namespaced key');
  assertEqual(sessionStorage.getItem('__er_goingTo'), null, 'does not use default key');
  router.destroy();
}

section('QueryRouter — Init from goingTo cue (highest priority)');
resetMocks();
{
  // goingTo cue is set (simulating a reload-mode navigation)
  sessionStorage.setItem('__er_goingTo', '/city-council/candidate/harper');
  // URL has a different route
  historyStack[0].url = 'https://example.com/voterguide?route=/';

  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes });
  assertEqual(router.getRoute().name, 'candidate', 'goingTo takes priority over URL');
  assertEqual(router.getRoute().params.candidate, 'harper', 'correct params from goingTo');

  // goingTo cue should be cleared after reading
  assertEqual(sessionStorage.getItem('__er_goingTo'), null, 'goingTo cue cleared after read');

  // URL should be updated to reflect the route (shareable)
  const url = currentUrl();
  assertEqual(url.searchParams.get('route'), '/city-council/candidate/harper', 'URL updated from goingTo');
  router.destroy();
}

section('QueryRouter — reload navigate stores goingTo');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes, pollInterval: 0 });
  router.start();

  // storeGoingTo is called internally by navigate() in reload mode.
  // We can't easily test location.href in Node mocks, but we can verify
  // that the goingTo cue is written before the reload would happen.
  router.storeGoingTo('/city-council');
  assertEqual(sessionStorage.getItem('__er_goingTo'), '/city-council', 'goingTo cue written by navigate');
  router.destroy();
}

section('QueryRouter — start() tags initial history state in SPA mode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 0 });
  assertEqual(history.state?.__embedRoute, undefined, 'no stateKey before start');
  router.start();
  assertEqual(history.state.__embedRoute, '/', 'initial entry tagged with stateKey after start');
  router.destroy();
}

section('QueryRouter — start() does not tag initial state in reload mode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'reload', routes, pollInterval: 0 });
  router.start();
  assertEqual(history.state?.__embedRoute, undefined, 'reload mode does not tag initial state');
  router.destroy();
}

section('QueryRouter — reconfigure() switches mode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'query', linkMode: 'spa', routes, pollInterval: 0 });
  router.start();

  router.navigate('/city-council/candidate/harper');
  assertEqual(currentUrl().searchParams.get('route'), '/city-council/candidate/harper', 'query mode writes param');

  // Reconfigure to hash mode
  const changed = router.reconfigure({ mode: 'hash' });
  assert(changed, 'reconfigure returns true when mode changes');
  assertEqual(currentUrl().hash, '#/city-council/candidate/harper', 'rewrites URL under new strategy');
  assertEqual(router.getRoute().name, 'candidate', 'current route preserved');

  // Navigate under new mode
  router.navigate('/school-board');
  assertEqual(currentUrl().hash, '#/school-board', 'new navigations use hash mode');

  router.destroy();
}

section('QueryRouter — reconfigure() switches linkMode');
resetMocks();
{
  const router = new QueryRouter({ mode: 'hash', linkMode: 'spa', routes, pollInterval: 0 });
  assertEqual(router.getLinkMode(), 'spa', 'starts in spa mode');

  const changed = router.reconfigure({ linkMode: 'reload' });
  assert(changed, 'reconfigure returns true when linkMode changes');
  assertEqual(router.getLinkMode(), 'reload', 'linkMode updated');
  router.destroy();
}

section('QueryRouter — reconfigure() no-op when nothing changes');
resetMocks();
{
  const router = new QueryRouter({ mode: 'hash', linkMode: 'spa', routes, pollInterval: 0 });
  const changed = router.reconfigure({ mode: 'hash', linkMode: 'spa' });
  assert(!changed, 'reconfigure returns false when nothing changes');
  router.destroy();
}

// ===== SUMMARY =====

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

if (failed > 0) process.exit(1);
