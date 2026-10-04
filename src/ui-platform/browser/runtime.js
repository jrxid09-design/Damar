'use strict';
const { Router, routeFor } = require('../routing');
const { tokenStyle } = require('../tokens');
const { bindVisualState } = require('../stateBinding');
const { mountShell } = require('../shells');
const { ApiClient } = require('../apiClient');

// Own only browser event attachment. Matching, registry, history and current state
// belong to the shared Router. Public navigation after unmount is a safe no-op.
function createRouter(window, render, options = {}) {
  const router = new Router({ ...options, history: window.history, onNavigate: render });
  const navigate = router.navigate.bind(router);
  let mounted = false;
  router.navigate = (path, options = {}) => mounted ? navigate(path, typeof options === 'boolean' ? { replace: options } : options) : router.current;
  const handlePopState = () => router.navigate(window.location.pathname, { replace: true });
  router.mount = () => { if (mounted) return; mounted = true; window.addEventListener('popstate', handlePopState); };
  router.unmount = () => { if (!mounted) return; mounted = false; window.removeEventListener('popstate', handlePopState); };
  Object.defineProperty(router, 'mounted', { get: () => mounted });
  return router;
}
function boot(document = globalThis.document, window = globalThis.window, options = {}) {
  if (!document || !window) throw new Error('browser globals required');
  const app = document.querySelector('#app'); if (!app) throw new Error('missing #app root');
  let shell = null; let disposeShell = null;
  const runtime = {
    visualState: bindVisualState({}).visualState, router: null, mounted: false,
    applyTokens(values) {
      if (!runtime.mounted) return;
      for (const [name, value] of Object.entries(tokenStyle('dark', values))) document.documentElement.style.setProperty(name, value);
    },
    setState(projection) {
      if (!runtime.mounted) return;
      const binding = bindVisualState(projection);
      runtime.visualState = binding.visualState;
      const live = shell?.querySelector('.damar-state'); if (live) live.textContent = binding.visualState;
      return binding;
    }
  };
  const removeShell = () => { disposeShell?.(); disposeShell = null; shell = null; };
  const render = ({ route }) => {
    if (!runtime.mounted) return; removeShell();
    disposeShell = mountShell(app, { kind: route.surface, router: runtime.router, route, state: { label: runtime.visualState }, onNavigate: ({ root }) => { shell = root; } });
  };
  runtime.router = createRouter(window, render, options);
  runtime.mount = () => {
    if (runtime.mounted) return;
    runtime.mounted = true; runtime.applyTokens(options.tokenValues); runtime.router.mount();
    const path = window.location.pathname;
    runtime.router.navigate(routeFor(path, runtime.router.routes) ? path : '/s/web_dashboard', { replace: true });
  };
  runtime.unmount = () => { if (!runtime.mounted) return; runtime.mounted = false; runtime.router.unmount(); removeShell(); };
  runtime.mount(); return runtime;
}
module.exports = { boot, route: routeFor, semanticTokens: tokenStyle, ApiClient };
