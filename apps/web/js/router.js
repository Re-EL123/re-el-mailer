/**
 * Hash router.
 *
 * Routes look like `#/inbox`, `#/message/<id>`, `#/compose?to=…`. The router
 * parses the hash into `{ name, params, query }`, matches it against the route
 * table, and calls the matched view's `render(container, context)`. Views
 * return an optional cleanup function that runs before the next navigation.
 */

const routes = [];
let currentCleanup = null;
let container = null;
let listening = false;
let rendered = false;

/**
 * Monotonic render token.
 *
 * `render()` awaits each view, and views are allowed to be async — the composer
 * waits on a dynamic import before it finishes mounting. A user who clicks
 * another link while that is in flight starts a second render, which can settle
 * first. Without a token the slow render then wins: it overwrites the newer
 * view's DOM *and* replaces `currentCleanup` with its own, so the next
 * navigation tears down the wrong view and leaks the other one's listeners.
 *
 * Every render takes a token before awaiting and checks it afterwards; a stale
 * one disposes of what it built and returns without touching shared state.
 */
let renderToken = 0;

/** Register a route. `name` is the first path segment. */
export function route(name, render, { title } = {}) {
  routes.push({ name, render, title });
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  }
  return { name: segments[0] || '', params: segments.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

export function currentRoute() {
  return parseHash();
}

/**
 * Move focus somewhere sensible after a route change.
 *
 * Without this, a keyboard or screen-reader user who activates a link is left
 * with focus on a link that no longer exists: the next Tab drops them back to
 * the top of the sidebar, and nothing announces the new page. The router is the
 * one place that knows a render just happened, so it owns this.
 *
 * The target is the first heading in the view when there is one, because that
 * is what a screen reader should read next; otherwise the container itself, made
 * programmatically focusable for exactly this purpose.
 */
export function moveFocusToView(container) {
  if (!container || !container.isConnected) return;

  const heading = container.querySelector('h1, h2, [data-route-heading]');
  const target = heading || container;

  // A heading is not focusable by default, so focusing one is a no-op and focus
  // stays on the link that was clicked. `tabindex="-1"` takes it out of the tab
  // order while making it a programmatic focus target, which is what a screen
  // reader needs in order to announce the new page. Any tabindex the view set
  // deliberately is left alone.
  if (!target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });

  // Focus alone does not move the viewport when it is set programmatically with
  // preventScroll, and landing halfway down a long page with the scrollbar at the
  // top is its own disorientation.
  container.scrollIntoView?.({ block: 'start' });
}

async function render() {
  const { name, params, query } = parseHash();

  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (err) {
      console.error('View cleanup failed', err);
    }
    currentCleanup = null;
  }

  const match = routes.find((r) => r.name === name) || routes[0];
  if (match?.title) document.title = `${match.title} · Re-EL Mailer`;
  if (!container || !match) return;

  const token = (renderToken += 1);

  try {
    // `name` is part of the documented context shape; views that already know
    // where they are ignore it, and it saves them re-parsing the hash.
    const cleanup = await match.render(container, { name, params, query });

    // A newer navigation started while this view was awaiting something. Its
    // DOM is already on screen, so this render is pure garbage: dispose of it
    // without touching `currentCleanup`, which belongs to the newer view.
    if (token !== renderToken) {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (err) {
          console.error('Stale view cleanup failed', err);
        }
      }
      return;
    }

    currentCleanup = cleanup;
    moveFocusToView(container);
  } catch (err) {
    if (token !== renderToken) return;
    console.error('View render failed', err);
    container.textContent = 'Something went wrong rendering this page.';
  }
}

/**
 * Start routing into `root`.
 *
 * Safe to call more than once: the hashchange listener is attached exactly once
 * for the lifetime of the page, and a repeat call just retargets the container.
 * The app swaps between the auth container and the mail shell container, and a
 * duplicate listener would render each view twice.
 */
export function startRouter(root) {
  const changed = root !== container;
  container = root;
  if (!listening) {
    listening = true;
    window.addEventListener('hashchange', render);
  }
  // A repeat call with the same container has nothing new to paint; re-rendering
  // would throw away view state for no reason.
  if (!changed && rendered) return;
  rendered = true;
  if (!window.location.hash) {
    // A bare load has no hash yet. Only a signed-in shell should default to the
    // inbox; leaving it empty lets the auth container show the sign-in screen.
    if (container.closest('.shell')) navigate('inbox', { replace: true });
    else render();
  } else {
    render();
  }
}

/**
 * Retarget the router at a new container without re-attaching listeners.
 *
 * Before `startRouter` runs there is nothing to render into yet, so the swap is
 * just recorded and `startRouter` picks it up; otherwise the new container is
 * filled with the current route.
 */
export function setRouterContainer(root) {
  const changed = root !== container;
  container = root;
  if (listening && (changed || !rendered)) {
    rendered = true;
    render();
  }
}

/** Force a re-render of the current route (after a mutation). */
export function refresh() {
  return render();
}