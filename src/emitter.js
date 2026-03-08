/**
 * Minimal event emitter.
 * 
 * Supports on/off/emit with a simple listener map.
 * No fancy features — just what the router needs.
 */
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void} unsubscribe function
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    this._listeners.get(event)?.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        console.error(`[embed-router] Error in "${event}" listener:`, err);
      }
    });
  }

  /**
   * Remove all listeners for all events.
   */
  removeAll() {
    this._listeners.clear();
  }
}
