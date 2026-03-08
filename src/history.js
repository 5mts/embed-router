/**
 * Captured native History API references.
 *
 * Host frameworks (React Router, Vue Router, Next.js, analytics tools like GTM)
 * commonly monkey-patch history.pushState and history.replaceState. If we call
 * the patched versions, our URL writes trigger the host's navigation wrapper,
 * causing crashes, duplicate renders, or URL corruption.
 *
 * This module grabs clean references as early as possible — at import time,
 * before host frameworks load. If the prototype is already patched (embed script
 * loaded after the host framework), we fall back to extracting clean references
 * from a temporary hidden iframe.
 *
 * Usage:
 *   import { safePushState, safeReplaceState } from './history.js';
 *   safePushState(state, '', url);  // bypasses host patches
 */

let _pushState;
let _replaceState;

/**
 * Check if a function looks like a native browser implementation.
 * Patched functions typically have a different toString() output.
 */
function isNative(fn) {
  try {
    return Function.prototype.toString.call(fn).includes('[native code]');
  } catch {
    return false;
  }
}

/**
 * Capture native pushState/replaceState references.
 * Called automatically on module load. Exported for the rare case where
 * the consumer needs to re-trigger (e.g., module loaded before document.body
 * existed and the iframe fallback failed on first attempt).
 */
export function capture() {
  // Attempt 1: grab from prototype (survives instance-level patches)
  if (typeof History !== 'undefined') {
    _pushState = History.prototype.pushState;
    _replaceState = History.prototype.replaceState;
  } else if (typeof history !== 'undefined') {
    // Fallback: grab from instance (test environments, unusual setups)
    _pushState = history.pushState;
    _replaceState = history.replaceState;
  }

  // If the prototype is already patched, try the iframe fallback
  if (_pushState && (!isNative(_pushState) || !isNative(_replaceState))) {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      _pushState = iframe.contentWindow.History.prototype.pushState;
      _replaceState = iframe.contentWindow.History.prototype.replaceState;
      document.body.removeChild(iframe);
    } catch {
      // iframe approach may fail due to CSP, sandboxed context, or
      // document.body not existing yet. Keep what we have.
    }
  }
}

// Capture immediately on module load
if (typeof window !== 'undefined') {
  capture();
}

/**
 * Call the native (unpatched) history.pushState.
 * @param {*} state
 * @param {string} title
 * @param {string} url
 */
export function safePushState(state, title, url) {
  if (_pushState) {
    _pushState.call(history, state, title, url);
  } else {
    history.pushState(state, title, url);
  }
}

/**
 * Call the native (unpatched) history.replaceState.
 * @param {*} state
 * @param {string} title
 * @param {string} [url]
 */
export function safeReplaceState(state, title, url) {
  if (_replaceState) {
    _replaceState.call(history, state, title, url);
  } else {
    history.replaceState(state, title, url);
  }
}
