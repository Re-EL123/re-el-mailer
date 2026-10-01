/**
 * Sign-in bridge.
 *
 * The auth views know when the API accepted a password but nothing about the
 * mail shell. Rather than importing `app.js` from a view (a cycle: app imports
 * the views), they announce the transition here and the bootstrap reacts by
 * swapping the container the router renders into.
 */

const handlers = new Set();

/** Subscribe to successful sign-ins. Returns an unsubscribe function. */
export function onSignedIn(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function notifySignedIn() {
  for (const fn of handlers) {
    try {
      fn();
    } catch (err) {
      console.error('Sign-in handler failed', err);
    }
  }
}