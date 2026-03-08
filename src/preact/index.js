/**
 * Preact bindings for embed-router.
 * 
 * Provides:
 *   <RouterProvider>  - context provider, wraps your app
 *   <Route>           - declarative route rendering
 *   <Link>            - click-navigates without page reload
 *   useRoute()        - current route state as a hook
 *   useNavigate()     - navigation function as a hook
 *   useAbortSignal()  - auto-cancelled AbortSignal per navigation
 *   useRouter()       - raw router instance (escape hatch)
 * 
 * USAGE:
 * 
 *   import { QueryRouter } from 'embed-router';
 *   import { RouterProvider, Route, Link, useRoute } from 'embed-router/preact';
 * 
 *   const router = new QueryRouter({ ... });
 * 
 *   function App() {
 *     return (
 *       <RouterProvider router={router}>
 *         <Route path="/" component={Home} />
 *         <Route path="/:section/candidate/:slug" component={CandidatePage} />
 *         <Route fallback component={NotFound} />
 *       </RouterProvider>
 *     );
 *   }
 * 
 *   function CandidatePage({ params }) {
 *     const { raceSlug, candidateSlug } = params;
 *     // ...
 *   }
 */

import { h, createContext } from 'preact';
import { useContext, useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { matchRoute, compileRoute } from '../matcher.js';

// --- Context ---

const RouterContext = createContext(null);

// --- Provider ---

/**
 * Provides the router instance to all descendant components.
 * Subscribes to route changes and triggers re-renders.
 * 
 * @param {{ router: QueryRouter, children: any }} props
 */
export function RouterProvider({ router, children }) {
  const [routeState, setRouteState] = useState(() => ({
    route: router.getRoute(),
    previous: null,
    source: 'init',
    state: null,
  }));

  useEffect(() => {
    // Start the router (idempotent — safe to call if already started)
    router.start();

    const unsub = router.on('route', (data) => {
      setRouteState({
        route: data.route,
        previous: data.previous,
        source: data.source,
        state: data.state ?? null,
      });
    });

    return () => {
      unsub();
    };
  }, [router]);

  const value = useMemo(
    () => ({ router, ...routeState }),
    [router, routeState]
  );

  return h(RouterContext.Provider, { value }, children);
}

// --- Hooks ---

/**
 * Get the current route state.
 * 
 * @returns {{ 
 *   path: string, 
 *   params: object, 
 *   name: string|null, 
 *   pattern: string|null, 
 *   notFound: boolean,
 *   previous: object|null,
 *   source: string 
 * }}
 */
export function useRoute() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('[embed-router] useRoute() must be used within <RouterProvider>');
  }
  const { route, previous, source, state } = ctx;
  return {
    path: route.path,
    params: route.params || {},
    name: route.name,
    pattern: route.pattern,
    notFound: !!route.notFound,
    previous,
    source,
    state,
  };
}

/**
 * Get the navigate function.
 * 
 * @returns {(pathOrName: string, paramsOrOptions?: object, options?: object) => boolean}
 */
export function useNavigate() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('[embed-router] useNavigate() must be used within <RouterProvider>');
  }
  return useCallback(
    (pathOrName, params, options) => ctx.router.navigate(pathOrName, params, options),
    [ctx.router]
  );
}

/**
 * Get an AbortSignal that is automatically cancelled when the route changes.
 * 
 * Use this for data fetching to avoid updating state after navigation:
 * 
 *   const signal = useAbortSignal();
 *   useEffect(() => {
 *     fetch(url, { signal })
 *       .then(r => r.json())
 *       .then(setData)
 *       .catch(err => { if (err.name !== 'AbortError') throw err; });
 *   }, [url, signal]);
 * 
 * @returns {AbortSignal}
 */
export function useAbortSignal() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('[embed-router] useAbortSignal() must be used within <RouterProvider>');
  }
  // Return the current signal — it changes on every navigation
  return ctx.router.getAbortSignal();
}

/**
 * Get the raw router instance. Escape hatch for advanced use cases.
 * 
 * @returns {QueryRouter}
 */
export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('[embed-router] useRouter() must be used within <RouterProvider>');
  }
  return ctx.router;
}

// --- Components ---

/**
 * Declarative route rendering.
 * 
 * Renders its component when the current path matches, passing extracted
 * params as a `params` prop. The matched route state is also passed as
 * a `route` prop for full access.
 * 
 * Props:
 *   path      - route pattern to match (e.g. "/:section/candidate/:slug")
 *   component - component to render when matched
 *   fallback  - if true, renders when no other Route matched (404)
 * 
 * The Route component does its OWN matching against the raw path, independent
 * of the router's route table. This means you can have Route components that
 * match patterns not in the router's route config (though that's unusual).
 * 
 * @param {{ path?: string, component: Function, fallback?: boolean }} props
 */
export function Route({ path, component, fallback = false }) {
  const { route } = useContext(RouterContext);

  if (fallback) {
    // Render only if current route is not found
    return route.notFound ? h(component, { route, params: {} }) : null;
  }

  if (!path) return null;

  // Compile and match this Route's pattern against the current path
  // We cache the compiled route in a ref to avoid recompiling on every render
  const compiledRef = useRef(null);
  if (!compiledRef.current || compiledRef.current._path !== path) {
    compiledRef.current = compileRoute({ path });
    compiledRef.current._path = path;
  }

  const currentPath = route.path;
  if (!currentPath) return null;

  const match = currentPath.match(compiledRef.current.regex);
  if (!match) return null;

  // Extract params
  const params = {};
  compiledRef.current.paramNames.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]);
  });

  return h(component, { params, route });
}

/**
 * Navigation link component.
 * 
 * Renders an <a> tag with the correct href for accessibility and right-click
 * behavior, but intercepts clicks to use the router's navigate() method
 * (no page reload).
 * 
 * Supports both path strings and named routes:
 * 
 *   <Link to="/city-council/candidate/harper">View</Link>
 *   <Link to="candidate" params={{ section: 'city-council', candidate: 'harper' }}>View</Link>
 * 
 * Adds an `aria-current="page"` attribute when the link matches the current route.
 * 
 * @param {{ to: string, params?: object, replace?: boolean, class?: string, activeClass?: string, children: any, [key: string]: any }} props
 */
export function Link({ to, params: linkParams, replace = false, class: className, activeClass, children, ...rest }) {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('[embed-router] <Link> must be used within <RouterProvider>');
  }
  const { router, route: currentRoute } = ctx;

  // Build href for the <a> tag
  const href = linkParams
    ? router.buildUrl(to, linkParams)
    : router.buildUrl(to);

  // Determine if this link is "active" (matches current route)
  const targetPath = linkParams
    ? (() => {
        try { return router.buildUrl(to, linkParams); } catch { return to; }
      })()
    : to;

  // Normalize for comparison
  const isActive = currentRoute.path &&
    currentRoute.path.toLowerCase() === (
      linkParams
        ? buildPathFromNameSafe(router, to, linkParams)
        : to.toLowerCase().replace(/\/$/, '') || '/'
    );

  const classes = [className, isActive && activeClass].filter(Boolean).join(' ') || undefined;

  function handleClick(e) {
    // Let the browser handle: ctrl+click, middle click, etc.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();

    const options = replace ? { historyMode: 'replace' } : {};
    if (linkParams) {
      router.navigate(to, linkParams, options);
    } else {
      router.navigate(to, options);
    }
  }

  return h(
    'a',
    {
      href,
      onClick: handleClick,
      class: classes,
      'aria-current': isActive ? 'page' : undefined,
      ...rest,
    },
    children
  );
}

// --- Utilities ---

function buildPathFromNameSafe(router, name, params) {
  try {
    // We need the normalized path, not the full URL
    // Extract it by using the internal method
    const url = router.buildUrl(name, params);
    // For query mode, parse out the route param
    if (url.includes('?')) {
      const u = new URL(url, window.location.origin);
      return u.searchParams.get(router._strategy?.param || 'route')?.toLowerCase() || '/';
    }
    // For hash mode, strip the #
    if (url.startsWith('#')) {
      return url.slice(1).toLowerCase();
    }
    return url.toLowerCase();
  } catch {
    return '';
  }
}
