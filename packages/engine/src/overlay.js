// Injected into every page of the browser view (plain JS: it is serialized as text).
// Draws step outlines + order badges and, in record mode, turns clicks into element picks.
(() => {
  if (window.__joule) return;

  // constraint: while picking a scope, only ancestors / descendants of the anchor elements can be picked.
  const state = { mode: 'interact', items: [], hover: null, constraint: null };
  let host = null;
  let root = null;
  let pool = [];
  // What each pooled box shows, so a draw only touches the DOM when an outline moved or changed.
  let shown = [];
  let frame = 0;
  let poll = 0;
  // Until then outlines follow the page every animation frame (scrolling, resizing, animations).
  let activeUntil = 0;

  const COLORS = { normal: '#ff4d4f', selected: '#ff4d4f', dim: '#ff4d4f', extra: '#faad14', running: '#36cfc9', hover: '#4096ff', anchor: '#b37feb' };

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('joule-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    pool = [];
    shown = [];
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
    if (state.constraint) for (const el of state.constraint.els) boxes.push({ el, n: null, kind: 'anchor' });
    if (state.mode === 'record' && state.hover) boxes.push({ el: state.hover, n: null, kind: 'hover' });
    let used = 0;
    for (const b of boxes) {
      if (!b.el || !b.el.isConnected) continue;
      const r = b.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const i = used++;
      const d = box(i);
      // Rewriting the same styles still repaints the page, and every repaint is streamed to the app as a frame.
      const key = `${r.left},${r.top},${r.width},${r.height},${b.kind},${b.n}`;
      if (shown[i] === key) continue;
      shown[i] = key;
      const color = COLORS[b.kind];
      const width = b.kind === 'selected' ? 3 : 2;
      d.style.display = 'block';
      d.style.left = r.left - width + 'px';
      d.style.top = r.top - width + 'px';
      d.style.width = r.width + width * 2 + 'px';
      d.style.height = r.height + width * 2 + 'px';
      d.style.border = `${width}px ${b.kind === 'extra' || b.kind === 'hover' || b.kind === 'anchor' ? 'dashed' : 'solid'} ${color}`;
      d.style.opacity = b.kind === 'dim' ? '0.3' : '1';
      d.style.background = b.kind === 'selected' ? 'rgba(255,77,79,0.08)' : 'transparent';
      const badge = d.firstChild;
      badge.style.display = b.n == null ? 'none' : 'block';
      badge.style.background = color;
      badge.textContent = b.n == null ? '' : String(b.n);
    }
    for (let i = used; i < pool.length; i++) {
      if (shown[i] === '') continue;
      shown[i] = '';
      pool[i].style.display = 'none';
    }
    if (!boxes.length) return;
    // keep following the page: every frame while it scrolls or animates, otherwise a few times per second
    if (performance.now() < activeUntil) schedule();
    else if (!poll) {
      poll = setTimeout(() => {
        poll = 0;
        schedule();
      }, 250);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function wake() {
    activeUntil = performance.now() + 1000;
    schedule();
  }
  window.addEventListener('scroll', wake, true); // capture: also scrolling inside elements
  window.addEventListener('resize', wake);
  window.addEventListener('animationstart', wake, true);
  window.addEventListener('transitionrun', wake, true);
  // hover styles and late images can move elements too
  window.addEventListener('mouseover', schedule, true);
  window.addEventListener('load', schedule, true);

  // ---------- shadow DOM ----------
  // Playwright's css engine pierces open shadow roots (also with `>` from a host to its shadow children) and
  // xpath does not. So walk the composed tree: up through shadow hosts, and count matches in every open root.

  /** Parent element, or the shadow host for a top-level element inside a shadow root. */
  function parentOrHost(n) {
    if (n.parentElement) return n.parentElement;
    const root = n.parentNode;
    return root instanceof ShadowRoot ? root.host : null;
  }

  function containsDeep(ancestor, n) {
    for (; n; n = parentOrHost(n)) if (n === ancestor) return true;
    return false;
  }

  function closestDeep(el, selector) {
    for (let n = el; n; n = parentOrHost(n)) if (n.matches(selector)) return n;
    return null;
  }

  /** Every open shadow root in the page (closed ones are out of reach for Playwright too). */
  function shadowRoots() {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          out.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return out;
  }

  // ---------- element description ----------

  function uniqueId(id, roots) {
    try {
      const sel = '#' + CSS.escape(id);
      let n = document.querySelectorAll(sel).length;
      for (const r of roots) n += r.querySelectorAll(sel).length;
      return n === 1;
    } catch {
      return false;
    }
  }

  function xpath(el, roots) {
    if (el.getRootNode() !== document) return undefined; // xpath can't reach into a shadow root
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && uniqueId(n.id, roots) && !n.id.includes('"')) {
        parts.unshift(`//*[@id="${n.id}"]`);
        return parts.join('/');
      }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    }
    return '/' + parts.join('/');
  }

  function cssPath(el, roots) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = parentOrHost(n)) {
      if (n.id && uniqueId(n.id, roots)) {
        parts.unshift('#' + CSS.escape(n.id));
        return parts.join(' > ');
      }
      let part = n.tagName.toLowerCase();
      const siblings = n.parentElement ? n.parentElement.children : n.parentNode instanceof ShadowRoot ? n.parentNode.children : null;
      if (siblings) {
        const same = [...siblings].filter((c) => c.tagName === n.tagName);
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
    // light DOM text only: Playwright's :text-is() doesn't see text inside a host's shadow root either
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const roots = shadowRoots();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: [...el.classList],
      attributes,
      text: text && text.length <= 200 ? text : undefined,
      role: el.getAttribute('role') || undefined,
      xpath: xpath(el, roots),
      cssPath: cssPath(el, roots),
    };
  }

  const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick], [contenteditable]';

  /** The real element under the pointer: events seen on window are retargeted to the outermost shadow host. */
  function eventTarget(e) {
    const t = e.composedPath()[0];
    return t instanceof Element ? t : e.target;
  }

  function pickTarget(t) {
    if (!(t instanceof Element) || t === host) return null;
    const c = state.constraint;
    if (c && c.relation === 'ancestor') {
      // the smallest ancestor of an anchor under the cursor
      for (let n = t; n; n = parentOrHost(n)) if (c.els.some((el) => n !== el && containsDeep(n, el))) return n;
      return null;
    }
    if (c && c.relation === 'descendant') {
      const inside = (n) => n && c.els.some((el) => n !== el && containsDeep(el, n));
      const el = closestDeep(t, INTERACTIVE);
      return inside(el) ? el : inside(t) ? t : null;
    }
    return closestDeep(t, INTERACTIVE) || t;
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
      const el = pickTarget(eventTarget(e));
      if (el && window.__joulePick) window.__joulePick(describe(el));
    },
    true,
  );
  window.addEventListener(
    'mousemove',
    (e) => {
      if (state.mode !== 'record') return;
      const el = pickTarget(eventTarget(e));
      if (el !== state.hover) {
        state.hover = el;
        schedule();
      }
    },
    true,
  );

  // ---------- page changes → ask node to re-resolve outlines ----------

  let changeTimer = 0;
  let changingSince = 0;
  function onMutations(records) {
    if (records.every((r) => host && (r.target === host || host.contains(r.target)))) return;
    schedule();
    // 400 ms after the page settles, and at least every 2 s while it keeps changing (a ticking clock)
    const now = performance.now();
    if (!changeTimer) changingSince = now;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = 0;
      if (window.__jouleChanged) window.__jouleChanged();
    }, Math.max(0, Math.min(400, changingSince + 2000 - now)));
  }
  const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
  const observer = new MutationObserver(onMutations);
  // A document observer doesn't see changes inside shadow roots: observe every open root as it is attached.
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    if (init && init.mode === 'open') observer.observe(root, OBSERVE);
    return root;
  };
  function observe() {
    observer.observe(document, OBSERVE);
  }
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe);

  let staged = [];
  window.__joule = {
    setMode(mode) {
      state.mode = mode;
      if (mode !== 'record') state.hover = null;
      schedule();
    },
    /** Matches of highlight item `i`, sent per selector; `commitItems` then shows all of them at once. */
    stageItem(i, item) {
      staged[i] = item;
    },
    commitItems(count) {
      state.items = staged.slice(0, count).filter(Boolean);
      staged = [];
      schedule();
    },
    setConstraint(els, relation) {
      state.constraint = els && els.length ? { els, relation } : null;
      state.hover = null;
      schedule();
    },
    describe,
    /** Description of the parent (or shadow host) of `el`; undefined at the top of the page. */
    describeParent(el) {
      const p = parentOrHost(el);
      return p && p !== document.documentElement ? describe(p) : undefined;
    },
  };

  if (window.__jouleHello) {
    window.__jouleHello().then((s) => s && window.__joule.setMode(s.mode));
  }
})();
