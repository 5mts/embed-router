/**
 * Hash URL Strategy
 *
 * Reads/writes route paths from location.hash.
 * Example: #/city-council/candidate/harper
 *
 * This is the simpler strategy — the hash is entirely ours and no host
 * application will interfere with it (unless the host also uses hash routing,
 * in which case you should use the query string strategy instead).
 */

import { safePushState, safeReplaceState } from './history.js';

export class HashStrategy {
  constructor(config) {
    this.needsInterferenceDetection = false;
    this.events = ['popstate', 'hashchange'];
    this._stateKey = config.stateKey || '__embedRoute';
  }

  /**
   * Read the current route path from the URL hash.
   * Returns null if no embed route is present (empty hash, bare #, or #/).
   * This allows the initial route resolution to fall through to other
   * sources (goingTo cue, history.state, default route).
   * @returns {string|null}
   */
  read() {
    const hash = window.location.hash;
    if (!hash || hash === '#' || hash === '#/') return null;
    // Strip leading # (and optional leading #/)
    const path = hash.slice(1);
    return path.startsWith('/') ? path : '/' + path;
  }

  /**
   * Read the backup route from history.state (for back/forward recovery).
   * @param {PopStateEvent} [event] - if called from a popstate handler
   * @returns {string|null}
   */
  readFromState(event) {
    const state = event?.state || window.history.state;
    return state?.[this._stateKey] || null;
  }

  /**
   * Write a route path to the URL.
   * @param {string} path
   * @param {'push'|'replace'} mode
   */
  write(path, mode) {
    const hash = '#' + path;
    const url = window.location.pathname + window.location.search + hash;
    const state = { ...window.history.state, [this._stateKey]: path };

    if (mode === 'replace') {
      safeReplaceState(state, '', url);
    } else {
      safePushState(state, '', url);
    }
  }

  /**
   * Get the full current URL string (for change detection).
   * We only watch the hash portion.
   * @returns {string}
   */
  getWatchValue() {
    return window.location.hash;
  }
}
