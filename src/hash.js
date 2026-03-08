/**
 * Hash URL Strategy
 *
 * Reads/writes route paths from location.hash.
 *
 * Without prefix: #/city-council/candidate/harper
 * With prefix:    #evg:/city-council/candidate/harper
 *
 * The optional prefix prevents collisions with host page hash anchors
 * (e.g., #contact, #section-3) by only recognizing hashes that match
 * the prefix. Without a prefix, ANY hash is interpreted as an embed route.
 *
 * This is the simpler strategy — the hash is entirely ours and no host
 * application will interfere with it (unless the host also uses hash routing,
 * in which case you should use the query string strategy instead).
 */

import { safePushState, safeReplaceState } from './history.js';

export class HashStrategy {
  /**
   * @param {object} config
   * @param {string} [config.prefix] - optional namespace prefix (e.g., 'evg' → #evg:/path)
   * @param {string} [config.stateKey] - history.state key for backup storage
   */
  constructor(config) {
    this.needsInterferenceDetection = false;
    this.events = ['popstate', 'hashchange'];
    this._stateKey = config.stateKey || '__embedRoute';
    this._prefix = config.prefix || '';
  }

  /**
   * Read the current route path from the URL hash.
   * Returns null if no embed route is present.
   *
   * With prefix: only recognizes #prefix:/path format.
   * Without prefix: any non-empty hash is treated as a route.
   *
   * @returns {string|null}
   */
  read() {
    const hash = window.location.hash;
    if (!hash || hash === '#') return null;

    if (this._prefix) {
      const expected = `#${this._prefix}:`;
      if (!hash.startsWith(expected)) return null;
      const path = hash.slice(expected.length);
      if (!path) return null;
      return path.startsWith('/') ? path : '/' + path;
    }

    // No prefix — treat any hash as embed route
    if (hash === '#/') return null;
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
    const hash = this._prefix
      ? `#${this._prefix}:${path}`
      : `#${path}`;
    const url = window.location.pathname + window.location.search + hash;
    const state = { ...window.history.state, [this._stateKey]: path };

    if (mode === 'replace') {
      safeReplaceState(state, '', url);
    } else {
      safePushState(state, '', url);
    }
  }

  /**
   * Get the value we monitor for external changes.
   * We only watch the hash portion.
   * @returns {string}
   */
  getWatchValue() {
    return window.location.hash;
  }
}
