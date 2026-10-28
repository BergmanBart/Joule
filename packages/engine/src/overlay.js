// Injected into every page of the browser view (plain JS: it is serialized as text).
// Draws step outlines + order badges and, in record mode, turns clicks into element picks.
(() => {
  if (window.__uitester) return;

  const state = { mode: 'interact', items: [], hover: null };
  let host = null;
  let root = null;
  let pool = [];
  let frame = 0;

  const COLORS = { normal: '#ff4d4f', selected: '#ff4d4f', dim: '#ff4d4f', extra: '#faad14', running: '#36cfc9', hover: '#4096ff' };

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('uitester-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    pool = [];
    document.documentElement.appendChild(host);
  }

  function box(i) {
    if (!pool[i]) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;border-radius:3px;';
      const badge = document.createElement('span');
      badge.style.cssText =
        'position:absolute;left:-2px;top:-18px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;' +
        'font:600 11px/16px system-ui,sans-serif;color:#fff;text-align:center;box-sizing:border-box;';
      el.appendChild(badge);
      root.appendChild(el);
      pool[i] = el;
    }
    return pool[i];
  }

  function draw() {
    frame = 0;
    if (!document.documentElement) return;
    ensureHost();
    const boxes = [];
    for (const item of state.items) {
      item.els.forEach((el, idx) => boxes.push({ el, n: idx === 0 ? item.n : null, kind: idx === 0 ? item.kind : 'extra' }));
    }
    if (state.mode === 'record' && state.hover) boxes.push({ el: state.hover, n: null, kind: 'hover' });
    let used = 0;
    for (const b of boxes) {
      if (!b.el || !b.el.isConnected) continue;
      const r = b.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const d = box(used++);
      const color = COLORS[b.kind];
      const width = b.kind === 'selected' ? 3 : 2;
      d.style.display = 'block';
      d.style.left = r.left - width + 'px';
      d.style.top = r.top - width + 'px';
      d.style.width = r.width + width * 2 + 'px';
      d.style.height = r.height + width * 2 + 'px';
      d.style.border = `${width}px ${b.kind === 'extra' || b.kind === 'hover' ? 'dashed' : 'solid'} ${color}`;
      d.style.opacity = b.kind === 'dim' ? '0.3' : '1';
      d.style.background = b.kind === 'selected' ? 'rgba(255,77,79,0.08)' : 'transparent';
      const badge = d.firstChild;
      badge.style.display = b.n == null ? 'none' : 'block';
      badge.style.background = color;
      badge.textContent = b.n == null ? '' : String(b.n);
    }
    for (let i = used; i < pool.length; i++) pool[i].style.display = 'none';
    if (boxes.length) schedule(); // keep following scroll/animations
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  // ---------- element description ----------

  function uniqueId(id) {
    try {
      return document.querySelectorAll('#' + CSS.escape(id)).length === 1;
    } catch {
      return false;
    }
  }

  function xpath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && uniqueId(n.id) && !n.id.includes('"')) {
        parts.unshift(`//*[@id="${n.id}"]`);
        return parts.join('/');
      }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    }
    return '/' + parts.join('/');
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && uniqueId(n.id)) {
        parts.unshift('#' + CSS.escape(n.id));
        return parts.join(' > ');
      }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const attributes = {};
    for (const a of el.attributes) {
      if (a.name === 'style') continue;
      attributes[a.name] = a.value.length > 300 ? a.value.slice(0, 300) : a.value;
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: [...el.classList],
      attributes,
      text: text && text.length <= 200 ? text : undefined,
      role: el.getAttribute('role') || undefined,
      xpath: xpath(el),
      cssPath: cssPath(el),
    };
  }

  const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick], [contenteditable]';

  function pickTarget(t) {
    if (!(t instanceof Element) || t === host) return null;
    return t.closest(INTERACTIVE) || t;
  }

  // ---------- record mode input capture ----------

  function block(e) {
    if (state.mode !== 'record') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick', 'submit', 'touchstart', 'touchend']) {
    window.addEventListener(type, block, true);
  }
  window.addEventListener(
    'click',
    (e) => {
      if (state.mode !== 'record') return;
      block(e);
      const el = pickTarget(e.target);
      if (el && window.__uitesterPick) window.__uitesterPick(describe(el));
    },
    true,
  );
  window.addEventListener(
    'mousemove',
    (e) => {
      if (state.mode !== 'record') return;
      const el = pickTarget(e.target);
      if (el !== state.hover) {
        state.hover = el;
        schedule();
      }
    },
    true,
  );

  // ---------- page changes → ask node to re-resolve outlines ----------

  let changeTimer = 0;
  function onMutations(records) {
    if (records.every((r) => host && (r.target === host || host.contains(r.target)))) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => window.__uitesterChanged && window.__uitesterChanged(), 400);
  }
  function observe() {
    new MutationObserver(onMutations).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe);

  window.__uitester = {
    setMode(mode) {
      state.mode = mode;
      if (mode !== 'record') state.hover = null;
      schedule();
    },
    setItems(items) {
      state.items = items;
      schedule();
    },
    describe,
  };

  if (window.__uitesterHello) {
    window.__uitesterHello().then((s) => s && window.__uitester.setMode(s.mode));
  }
})();
