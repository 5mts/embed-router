/**
 * Query String URL Strategy
 * 
 * Reads/writes route paths from a query parameter in location.search.
 * Example: ?route=/city-council/candidate/harper
 * 
 * This strategy exists because some host SPAs use hash routing themselves,
 * making hash-based embed routing impossible. Query params are an alternative
 * URL channel that doesn't conflict with host hash routing.
 * 
 * Key challenges this strategy handles:
 * - Preserving all other query params when writing ours
 * - Host SPA may clobber our param when it does its own pushState
 *   → We write a backup to history.state which survives back/forward
 * - Optional interference detection to warn when params are stripped
 */

import { safePushState, safeReplaceState } from './history.js';

export class QueryStringStrategy {
  /**
   * @param {object} config
   * @param {string} config.param - query parameter name (default: 'route')
   * @param {string|null} config.id - multi-embed prefix. If set, param becomes '{id}.{param}'
   * @param {string} config.stateKey - history.state key for backup storage
   */
  constructor(config) {
    const baseParam = config.param || 'route';
    this.param = config.id ? `${config.id}.${baseParam}` : baseParam;
    this.needsInterferenceDetection = true;
    this.events = ['popstate'];
    this._stateKey = config.stateKey || '__embedRoute';
    this._debug = config.debug || false;
  }

  /**
   * Read the current route path from the URL query string.
   * @returns {string|null} path if present, null if our param is missing
   */
  read() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(this.param);
    if (value == null || value === '') return null;
    // Ensure it starts with /
    return value.startsWith('/') ? value : '/' + value;
  }

  /**
   * Read the backup route from history.state (for back/forward recovery).
   * This is the critical recovery mechanism: when the host SPA does a pushState
   * that clobbers our query param, the history entry we created still has our
   * route in its state object. On back/forward, this state is restored.
   * 
   * @param {PopStateEvent} [event] - if called from a popstate handler
   * @returns {string|null}
   */
  readFromState(event) {
    const state = event?.state || window.history.state;
    return state?.[this._stateKey] || null;
  }

  /**
   * Write a route path to the URL and history state.
   * 
   * IMPORTANT: We always preserve existing query params from the host page.
   * We only touch our own param. This prevents us from breaking host-page
   * functionality that depends on its own query params.
   * 
   * We also write to history.state as a backup, because:
   * - The host SPA may do its own pushState later that clobbers our param
   * - history.state survives back/forward navigation per the HTML spec
   * - The host CMS we've tested preserves unknown keys in history.state
   * 
   * @param {string} path - route path to write
   * @param {'push'|'replace'} mode
   */
  write(path, mode) {
    const url = new URL(window.location.href);
    // Build param manually so slashes stay readable (?route=/a/b not ?route=%2Fa%2Fb)
    url.searchParams.delete(this.param);
    const sep = url.search ? '&' : '?';
    const href = url.toString() + sep + encodeURIComponent(this.param) + '=' + path;

    // Merge our state key into existing history.state (preserve host's state like psUrl)
    const state = { ...window.history.state, [this._stateKey]: path };

    if (mode === 'replace') {
      safeReplaceState(state, '', href);
    } else {
      safePushState(state, '', href);
    }
  }

  /**
   * Get the value we monitor for external changes.
   * We watch the full search string because any change to the query string
   * could mean our param was added, changed, or removed.
   * @returns {string}
   */
  getWatchValue() {
    return window.location.search;
  }

  /**
   * Verify that our param survived in the URL.
   * Called after a short delay post-pushState to detect host interference.
   * 
   * @param {string} expectedPath - what we wrote
   * @returns {{ survived: boolean, currentValue: string|null }}
   */
  verify(expectedPath) {
    const current = this.read();
    return {
      survived: current === expectedPath,
      currentValue: current,
    };
  }
}
