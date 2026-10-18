/* One entry point, with each renderer retaining its camera and mesh cache. */
(() => {
  const app = document.getElementById('app');
  const frame = document.getElementById('parts-frame');
  const panel = document.getElementById('parts-workspace');
  const assetsTab = document.getElementById('assets-tab');
  const partsTab = document.getElementById('parts-tab');
  const parts = new Set(['v8_engine', 'torsen_differential', 'tremec_transmission', 'k1_structural_frame']);
  let selection = { part: 'v8_engine', item: '' };
  let initialized = false;

  function normalized(part, item = '') {
    return { part: parts.has(part) ? part : 'v8_engine', item: /^variation_\d{2}_seed_\d+$/.test(item) ? item : '' };
  }
  function send(message) {
    if (initialized) frame.contentWindow.postMessage(message, location.origin);
  }
  function show(workspace, next, push = false) {
    if (next) selection = normalized(next.part, next.item);
    const isParts = workspace === 'parts';
    app.dataset.workspace = workspace;
    panel.hidden = !isParts;
    assetsTab.setAttribute('aria-pressed', String(!isParts));
    partsTab.setAttribute('aria-pressed', String(isParts));
    document.getElementById('parts-heading').hidden = !isParts;
    document.title = `${isParts ? 'Part alternatives' : 'Assets'} · IDFM Marketing`;
    window.dispatchEvent(new CustomEvent('idfm-workspace', { detail: workspace }));
    if (isParts && !initialized) {
      initialized = true;
      frame.src = `alternatives.html?embed=1#${selection.part}/${selection.item}`;
    } else if (isParts && next) {
      send({ type: 'idfm-select-part', ...selection });
    }
    send({ type: 'idfm-visibility', visible: isParts });
    if (push) {
      const url = new URL(location.href);
      url.hash = isParts ? `parts/${selection.part}/${selection.item}` : 'assets';
      if (url.href !== location.href) history.pushState(null, '', url);
    }
  }
  function route() {
    const [workspace, part, item] = location.hash.slice(1).split('/');
    show(workspace === 'parts' ? 'parts' : 'assets', workspace === 'parts' ? normalized(part, item) : null);
  }
  frame.addEventListener('load', () => {
    send({ type: 'idfm-visibility', visible: app.dataset.workspace === 'parts' });
    send({ type: 'idfm-select-part', ...selection });
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (message?.type !== 'idfm-part-selection' || !parts.has(message.part)) return;
    selection = normalized(message.part, message.item);
    if (app.dataset.workspace !== 'parts') return;
    const url = new URL(location.href);
    url.hash = `parts/${selection.part}/${selection.item}`;
    history.replaceState(null, '', url);
  });
  assetsTab.addEventListener('click', () => show('assets', null, true));
  partsTab.addEventListener('click', () => show('parts', null, true));
  window.addEventListener('idfm-open-alternatives', event => {
    if (parts.has(event.detail?.part)) show('parts', { part: event.detail.part }, true);
  });
  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', route);
  route();
})();
