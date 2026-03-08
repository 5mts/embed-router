/**
 * embed-router
 * 
 * A routing library for embeddable widgets in hostile CMS environments.
 * 
 * Core (vanilla JS):
 *   import { QueryRouter, snapshotUrl } from 'embed-router';
 * 
 * Preact bindings:
 *   import { RouterProvider, Route, Link, useRoute, useNavigate, useAbortSignal } from 'embed-router/preact';
 */

export { QueryRouter, snapshotUrl } from './router.js';
export { compileRoute, compileRoutes, matchRoute, buildPath } from './matcher.js';
export { normalizePath, isPathSafe } from './normalize.js';
