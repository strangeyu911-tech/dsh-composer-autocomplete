window.__ModuleLoader__.load({
  id: 'dsh-composer-autocomplete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    const ROUTE = '/plugins/dsh-composer-predict/predict';

    let localeId = 'zh';
    function isZh() { return localeId === 'zh'; }

    const PHRASES = [
      '帮我看看这个报错', '帮我优化一下这段代码', '帮我改一下这个功能', '帮我写一个',
      '帮我分析一下', '把这个功能实现一下', '继续', '再详细一点', '再补充一下细节',
      '换成中文', '用更简单的说法', '改成用另一种方案', '先这样吧', '我想做一个插件',
      '这个怎么用', '麻烦帮我', '谢谢',
    ];

    function readNodes(chat) {
      const nodes = chat && chat.nodes;
      if (!nodes) return [];
      let arr;
      if (typeof nodes.values === 'function') arr = Array.from(nodes.values());
      else if (Array.isArray(nodes)) arr = nodes.slice();
      else arr = Object.keys(nodes).map((k) => nodes[k]);
      arr.sort((a, b) => ((a && a.anchorSeq) || 0) - ((b && b.anchorSeq) || 0));
      return arr;
    }

    function historyFromChat(chat) {
      const out = [];
      for (const node of readNodes(chat)) {
        if (!node || typeof node.kind !== 'string') continue;
        const data = node.data || {};
        if (node.kind === 'user') {
          const content = Array.isArray(data.content) ? data.content : [];
          const text = content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
          if (text.trim()) out.push({ role: 'user', text });
        } else if (node.kind === 'assistant-step') {
          const blocks = Array.isArray(data.blocks) ? data.blocks : [];
          const text = blocks.filter((b) => b && b.kind === 'text').map((b) => b.text || '').join('');
          if (text.trim()) out.push({ role: 'assistant', text });
        }
      }
      return out;
    }

    function localSuggestion(draft, history) {
      if (typeof draft !== 'string' || !draft.trim()) return '';
      let best = '';
      for (const message of history) {
        if (message.role !== 'user') continue;
        const text = message.text;
        if (text.length > draft.length && text.startsWith(draft)) {
          const remainder = text.slice(draft.length);
          if (remainder.trim() && remainder.length <= 80 && (!best || remainder.length < best.length)) best = remainder;
        }
      }
      if (best) return best;
      for (const phrase of PHRASES) {
        if (phrase.length > draft.length && phrase.startsWith(draft)) return phrase.slice(draft.length);
      }
      return '';
    }

    function buildContext(history) {
      return history.slice(-8)
        .map((m) => (m.role === 'user' ? '用户' : '助手') + '：' + m.text.replace(/\s+/gu, ' ').slice(0, 400))
        .join('\n');
    }

    function composerCard() {
      return typeof document !== 'undefined' ? document.querySelector('[data-composer-card]') : null;
    }
    function editorEl() {
      const card = composerCard();
      return card ? card.querySelector('[contenteditable="true"]') : null;
    }
    function lastTextNode(root) {
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node;
      let last = null;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.length) last = node;
      }
      return last;
    }

    // Box right AFTER the last character of the input, clamped inside the card.
    function endOfTextInfo() {
      const card = composerCard();
      const el = editorEl();
      if (!card || !el) return null;
      const cardRect = card.getBoundingClientRect();
      const elCs = window.getComputedStyle(el);
      const padL = parseFloat(elCs.paddingLeft) || 0;
      const padR = parseFloat(elCs.paddingRight) || 0;
      const padT = parseFloat(elCs.paddingTop) || 0;

      let rect = null;
      let fontEl = el;
      const last = lastTextNode(el);
      if (last) {
        try {
          const range = document.createRange();
          range.setStart(last, last.nodeValue.length);
          range.collapse(true);
          rect = range.getBoundingClientRect();
          if ((!rect || (rect.width === 0 && rect.height === 0)) && range.getClientRects) {
            const rects = range.getClientRects();
            if (rects && rects.length) rect = rects[rects.length - 1];
          }
        } catch (e) { rect = null; }
      }
      if (!rect) {
        const ph = card.querySelector('[data-composer-placeholder]');
        if (ph) {
          const pr = ph.getBoundingClientRect();
          if (pr && (pr.width || pr.height)) { rect = pr; fontEl = ph; }
        }
      }
      const fs = window.getComputedStyle(fontEl);
      const lineH = parseFloat(fs.lineHeight) || parseFloat(fs.fontSize) * 1.4 || 20;

      let left = rect ? rect.left : cardRect.left + padL + 2;
      let top = rect ? rect.top : cardRect.top + padT + 2;
      const height = (rect && rect.height) || lineH;

      const maxRight = cardRect.right - Math.max(padR, 6);
      let maxWidth = maxRight - left;
      if (maxWidth < 48) {
        left = cardRect.left + padL + 2;
        top = top + height;
        maxWidth = maxRight - left;
      }
      const maxBottom = cardRect.bottom - 4;
      if (top + height > maxBottom) top = maxBottom - height;
      if (maxWidth < 12) maxWidth = 12;

      return {
        left, top, height, maxWidth,
        fontFamily: fs.fontFamily,
        fontSize: fs.fontSize,
        fontWeight: fs.fontWeight,
        fontStyle: fs.fontStyle,
        letterSpacing: fs.letterSpacing,
      };
    }

    function editorFocused() {
      const el = typeof document !== 'undefined' ? document.activeElement : null;
      return !!el && el.isContentEditable === true;
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (this.state.error) {
          const message = String((this.state.error && this.state.error.message) || this.state.error);
          return h('div', {
            'data-composer-predict': 'error',
            style: { position: 'fixed', left: 8, bottom: 8, zIndex: 9999, background: '#5a1f1f', color: '#ffd7d7', fontSize: 12, padding: '2px 8px', borderRadius: 6 },
          }, (isZh() ? '预测组件出错：' : 'Predict error: ') + message);
        }
        return this.props.children;
      }
    }

    function PredictBar(props) {
      const { useInput, inputActions, useChat } = props;
      const hasInput = typeof useInput === 'function';
      const draft = hasInput ? useInput((s) => (s ? s.draft : undefined)) : '';
      const chat = typeof useChat === 'function' ? useChat((s) => s) : undefined;

      const history = useMemo(() => { try { return historyFromChat(chat); } catch (e) { return []; } }, [chat]);
      const hasAssistant = useMemo(() => history.some((m) => m.role === 'assistant'), [history]);
      const local = useMemo(() => (typeof draft === 'string' ? localSuggestion(draft, history) : ''), [draft, history]);

      const [ai, setAi] = useState({ base: null, text: '', loading: false });
      const [dismissed, setDismissed] = useState(null);
      const [, setTick] = useState(0);
      const seq = useRef(0);
      const lastAuto = useRef('');
      const lastEmpty = useRef('');
      const inflight = useRef(null);

      const triggerAi = useCallback((allowEmpty) => {
        const d = typeof draft === 'string' ? draft : '';
        if (d.trim() === '' && !allowEmpty) return;
        const run = ++seq.current;
        if (inflight.current) { try { inflight.current.abort(); } catch (e) { /* ignore */ } }
        const controller = new AbortController();
        inflight.current = controller;
        const timer = setTimeout(() => { try { controller.abort(); } catch (e) { /* ignore */ } }, 8000);
        setAi((prev) => ({ ...prev, loading: true }));
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-composer-predict': '1' },
          body: JSON.stringify({ draft: d, context: buildContext(history), locale: localeId }),
          signal: controller.signal,
        })
          .then((r) => r.json())
          .then((data) => {
            if (run !== seq.current) return;
            const text = data && data.ok && typeof data.suggestion === 'string' ? data.suggestion : '';
            setAi({ base: d, text, loading: false });
          })
          .catch(() => { if (run === seq.current) setAi((prev) => ({ ...prev, loading: false })); })
          .finally(() => clearTimeout(timer));
      }, [draft, history]);

      // Auto-predict on pause when local heuristics cannot continue. No hotkey needed.
      useEffect(() => {
        if (typeof draft !== 'string') return undefined;
        const d = draft;
        if (d.trim().length < 2) return undefined;
        if (local) return undefined;
        if (!hasAssistant) return undefined;
        if (ai.loading) return undefined;
        if (ai.base === d && ai.text) return undefined;
        if (lastAuto.current === d) return undefined;
        const timer = setTimeout(() => { lastAuto.current = d; triggerAi(); }, 200);
        return () => clearTimeout(timer);
      }, [draft, local, hasAssistant, ai, triggerAi]);

      // 0-character prediction: from round 2+, before typing, predict the likely next reply
      // (e.g., which option the user will pick when the assistant asked a question).
      useEffect(() => {
        if (typeof draft !== 'string' || draft.length !== 0) return undefined;
        if (!hasAssistant) return undefined;
        if (ai.loading) return undefined;
        const last = history.length ? history[history.length - 1] : undefined;
        if (!last || last.role !== 'assistant') return undefined;
        const key = String(history.length) + '|' + last.text.slice(0, 80);
        if (!key || lastEmpty.current === key) return undefined;
        const timer = setTimeout(() => { lastEmpty.current = key; triggerAi(true); }, 400);
        return () => clearTimeout(timer);
      }, [draft, hasAssistant, history, ai, triggerAi]);

      const active = useMemo(() => {
        if (typeof draft !== 'string') return '';
        if (dismissed === draft) return '';
        if (ai.base === draft && ai.text) return ai.text;
        return local;
      }, [draft, dismissed, ai, local]);

      const accept = useCallback(() => {
        if (!active) return;
        const d = typeof draft === 'string' ? draft : '';
        if (inputActions && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(d + active);
        } else {
          const span = inputActions && inputActions.captureInsertion ? inputActions.captureInsertion() : null;
          if (span && inputActions && inputActions.insertText) inputActions.insertText(active, span);
        }
        setAi({ base: null, text: '', loading: false });
        setDismissed(null);
      }, [active, draft, inputActions]);

      useEffect(() => {
        const onKey = (event) => {
          if (!editorFocused()) return;
          if (event.key === 'Tab' && active) { event.preventDefault(); event.stopPropagation(); accept(); return; }
          if (event.key === 'Escape' && active) { setDismissed(typeof draft === 'string' ? draft : null); return; }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [active, draft, accept]);

      useEffect(() => {
        let raf = 0;
        const bump = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick((t) => t + 1)); };
        document.addEventListener('selectionchange', bump);
        window.addEventListener('scroll', bump, true);
        window.addEventListener('resize', bump);
        const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(bump) : null;
        const card = composerCard();
        if (mo && card) mo.observe(card, { childList: true, subtree: true, characterData: true });
        return () => {
          document.removeEventListener('selectionchange', bump);
          window.removeEventListener('scroll', bump, true);
          window.removeEventListener('resize', bump);
          if (mo) mo.disconnect();
          cancelAnimationFrame(raf);
        };
      }, []);

      // Hide the composer placeholder while a 0-character prediction is shown at the same spot.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        if (draft !== '' || !active) return undefined;
        const card = composerCard();
        const ph = card ? card.querySelector('[data-composer-placeholder]') : null;
        if (!ph) return undefined;
        const prev = ph.style.visibility;
        ph.style.visibility = 'hidden';
        return () => { ph.style.visibility = prev; };
      }, [draft, active]);

      if (!hasInput) return null;
      if (typeof draft !== 'string') return null;
      if (dismissed === draft) return null;

      const ghostText = active || (ai.loading && draft.length >= 1 ? '…' : '');
      if (!ghostText) return null;
      const info = endOfTextInfo();
      if (!info) return null;

      return h('span', {
        'data-composer-predict': 'ghost',
        'aria-hidden': true,
        style: {
          position: 'fixed',
          left: info.left,
          top: info.top,
          height: info.height,
          maxWidth: info.maxWidth,
          lineHeight: info.height + 'px',
          fontFamily: info.fontFamily,
          fontSize: info.fontSize,
          fontWeight: info.fontWeight,
          fontStyle: info.fontStyle,
          letterSpacing: info.letterSpacing,
          color: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
          opacity: 0.72,
          whiteSpace: 'pre',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
          zIndex: 9999,
          userSelect: 'none',
          margin: 0,
          padding: 0,
          display: 'inline-block',
          verticalAlign: 'top',
        },
      }, ghostText);
    }

    function SafePredictBar(props) {
      return h(Boundary, null, h(PredictBar, props));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          const read = () => {
            const loc = ctx.locale && ctx.locale.getLocale ? ctx.locale.getLocale() : null;
            const id = loc && (loc.id || loc.locale) ? String(loc.id || loc.locale) : 'zh';
            localeId = id.startsWith('zh') ? 'zh' : 'en';
          };
          read();
          if (ctx.locale && ctx.locale.subscribe) ctx.effect(() => ctx.locale.subscribe(read));
        } catch (error) { /* locale best-effort */ }
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'composer-predict', order: 10 },
            SafePredictBar,
          ),
        );
      },
    };
  },
});
