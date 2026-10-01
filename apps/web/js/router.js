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

  try {
    // `name` is part of the documented context shape; views that already know
    // where they are ignore it, and it saves them re-parsing the hash.
    currentCleanup = await match.render(container, { name, params, query });
  } catch (err) {
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