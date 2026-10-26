/**
 * dsh-mini-window — 浏览器侧实现（手写，无打包器）。
 *
 * 三个 slot 条目：
 *  - `shell.overlay` / id `mini-window.launcher`  → 常驻的圆形入口按钮（可拖拽、位置记忆），
 *     单击 = 打开/关闭「屏幕级小窗」，右键 = 打开/关闭「页内小窗」。
 *  - `shell.overlay` / id `mini-window.inline`    → 页内小窗（不想动窗口时的轻量形态）。
 *  - `shell.overlay` / id `mini-window.toast`     → 轻提示。
 *  - `conversation.composer.dock` / id `mini-window.bridge`
 *      → 会话内不可见的桥：把 sessionId、inputActions（发消息的动作面）、
 *        以及 Chat 快照里的最后一条用户/助手文本发布到模块级 store，
 *        供入口按钮 / 页内小窗读取。overlay 是 root 作用域，拿不到会话级 props，
 *        因此用这个桥把会话能力转递给常驻浮层。
 *
 * 「屏幕级小窗」由 Host 半边完成：浏览器侧只能改页面内部，而 Harness 的浮层、
 * 连 Document PiP 窗口都被合成在主窗口里，切走其它应用就会被盖住。所以这里只负责
 * 请求 Host 把主窗口切成置顶小窗（Win32），并把页面切进 `dsh-mini-mode` 形态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mini-window',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useSyncExternalStore } = React;

    /* ────────────────────────── 文案 ────────────────────────── */

    const NS = 'mini-window';

    const DICT = {
      zh: {
        title: 'DSH 小窗',
        placeholder: '给小窗发消息…（Enter 发送，Shift+Enter 换行）',
        send: '发送',
        collapse: '收起成条',
        expand: '展开',
        noSession: '未连接到会话：先在 Harness 里打开一个会话。',
        you: '你',
        assistant: '模型',
        empty: '这里会显示当前会话的最新回复。',
        running: '生成中…',
        open: '打开小窗',
        close: '关闭小窗',
        openInline: '页内小窗',
        listed: '小窗已置顶，可切到其它应用继续用',
        restored: '已退出小窗',
        failed: '窗口控制服务不可用：重启一次 dsh 后即可让小窗置顶。',
        hint: '单击开关屏幕小窗 · 右键开关页内小窗 · 可拖动',
      },
      en: {
        title: 'DSH Mini Window',
        placeholder: 'Message the mini window… (Enter to send)',
        send: 'Send',
        collapse: 'Collapse',
        expand: 'Expand',
        noSession: 'No session connected: open a session in Harness first.',
        you: 'You',
        assistant: 'Model',
        empty: 'The latest reply of the current session shows here.',
        running: 'Generating…',
        open: 'Open mini window',
        close: 'Close mini window',
        openInline: 'In-page window',
        listed: 'Mini window is on top — keep working in other apps',
        restored: 'Mini window closed',
        failed: 'Window control service unavailable: restart dsh once to pin the mini window.',
        hint: 'Click: screen mini window · Right-click: in-page window · Draggable',
      },
    };

    let t = (key) => DICT.zh[key] ?? key;

    /* ────────────────────────── store ────────────────────────── */

    const createStore = (initial) => {
      let state = initial;
      const subs = new Set();
      return {
        get: () => state,
        set: (patch) => {
          let changed = false;
          const next = { ...state };
          for (const key of Object.keys(patch)) {
            if (state[key] !== patch[key]) {
              next[key] = patch[key];
              changed = true;
            }
          }
          if (changed) {
            state = next;
            for (const fn of Array.from(subs)) fn();
          }
        },
        subscribe: (fn) => {
          subs.add(fn);
          return () => {
            subs.delete(fn);
          };
        },
      };
    };

    const bridge = createStore({
      sessionId: undefined,
      inputActions: undefined,
      phase: 'idle',
      running: false,
      lastUser: '',
      lastAssistant: '',
    });

    /** `mini` = 主窗口已切成屏幕级置顶小窗；`inline` = 页内小窗已打开。 */
    const ui = createStore({ mini: false, inline: false, toast: '' });

    const useStore = (store) => useSyncExternalStore(store.subscribe, store.get, store.get);

    /* ────────────────────── 持久化 ────────────────────── */

    const K = {
      pos: 'dsh.mini-window.pos',
      size: 'dsh.mini-window.size',
      collapsed: 'dsh.mini-window.collapsed',
      ball: 'dsh.mini-window.ball',
      inline: 'dsh.mini-window.inlineOpen',
    };

    const readJSON = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
      } catch (error) {
        return fallback;
      }
    };

    const writeJSON = (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* 存储不可写时只影响位置记忆，不影响小窗本身。 */
      }
    };

    /* ────────────────── 会话桥（dock → 浮层） ────────────────── */

    const NOOP_HOOK = () => undefined;

    /** 拼接 blocks 里所有纯文本块；用户节点用 `type`，助手节点用 `kind`。 */
    const textOf = (blocks, kindKey) => {
      if (!Array.isArray(blocks)) return '';
      let out = '';
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block[kindKey] === 'text' && typeof block.text === 'string') {
          out += block.text;
        }
      }
      return out;
    };

    const lastMatching = (snapshot, kind, kindKey, field) => {
      const order = snapshot?.order;
      const nodes = snapshot?.nodes;
      if (!Array.isArray(order) || typeof nodes?.get !== 'function') return '';
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const node = nodes.get(order[i]);
        if (node === undefined || node.kind !== kind) continue;
        const text = textOf(node.data?.[field], kindKey);
        if (text.trim() !== '') return text;
      }
      return '';
    };

    const selectLastUser = (snapshot) => lastMatching(snapshot, 'user', 'type', 'content');
    const selectLastAssistant = (snapshot) => lastMatching(snapshot, 'assistant-step', 'kind', 'blocks');
    const selectPhase = (snapshot) => snapshot?.phase ?? 'idle';
    const selectRunning = (snapshot) => snapshot?.running === true;

    /**
     * 会话内不可见的桥：只订阅它关心的最小切片，把会话能力发布给常驻浮层。
     * 组件卸载后 store 保留最后一份引用，因此宿主 composer 换成非会话页面时
     * 小窗依然能继续发送。
     */
    function SessionBridge(props) {
      const useChat = typeof props.useChat === 'function' ? props.useChat : NOOP_HOOK;
      const useInput = typeof props.useInput === 'function' ? props.useInput : NOOP_HOOK;
      const useSession = typeof props.useSession === 'function' ? props.useSession : NOOP_HOOK;

      const lastUser = useChat(selectLastUser);
      const lastAssistant = useChat(selectLastAssistant);
      const phase = useInput(selectPhase);
      const running = useSession(selectRunning);

      useEffect(() => {
        bridge.set({
          sessionId: props.sessionId,
          inputActions: props.inputActions,
          phase: phase ?? 'idle',
          running: running === true,
          lastUser: typeof lastUser === 'string' ? lastUser : '',
          lastAssistant: typeof lastAssistant === 'string' ? lastAssistant : '',
        });
      });

      return null;
    }

    /* ────────────────── 屏幕级小窗（Host 控制通道） ────────────────── */

    /** 小窗目标尺寸，单位为 CSS 像素；Host 侧按 DPR 换算成物理像素，并按窗口最小尺寸回正。 */
    const MINI_SIZE = { w: 560, h: 640 };

    const CONTROL_PATHS = ['/api/mini-window/state', 'http://127.0.0.1:19731/state'];

    const requestControl = async (init) => {
      for (const url of CONTROL_PATHS) {
        try {
          const response = await fetch(url, init);
          if (!response.ok) continue;
          const payload = await response.json();
          if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload;
        } catch (error) {
          /* 换下一条通道。 */
        }
      }
      return null;
    };

    const toggleMiniClass = (on) => {
      try {
        document.documentElement.classList.toggle('dsh-mini-mode', on);
      } catch (error) {
        /* 文档不可用时忽略。 */
      }
    };

    /**
     * 切换屏幕级小窗。
     *
     * @param on - true 进入小窗（置顶 + 固定尺寸），false 恢复原窗口。
     * @returns 是否成功驱动 Host。
     */
    const applyMini = async (on) => {
      const dpr = window.devicePixelRatio || 1;
      const payload = {
        mode: on ? 'enter' : 'exit',
        width: Math.round(MINI_SIZE.w * dpr),
        height: Math.round(MINI_SIZE.h * dpr),
      };
      const result = await requestControl({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return result !== null;
    };

    const toggleMini = async () => {
      const on = !ui.get().mini;
      ui.set({ mini: on, inline: on ? false : ui.get().inline });
      toggleMiniClass(on);
      if (on) writeJSON(K.inline, false);
      const ok = await applyMini(on);
      if (!ok) {
        toggleMiniClass(false);
        ui.set({ mini: false, toast: t('failed') });
        return;
      }
      ui.set({ toast: on ? t('listed') : t('restored') });
    };

    /** 页面重新加载后，按 Host 的真实模式校准页面形态。 */
    const syncFromHost = async () => {
      const result = await requestControl({ method: 'GET' });
      if (result === null) return;
      const on = result.mode === 'enter' || result.host?.minified === true;
      ui.set({ mini: on });
      toggleMiniClass(on);
    };

    /* ────────────────── 消息 / 输入（两种形态共用） ────────────────── */

    const useSessionData = () => {
      const snapshot = useStore(bridge);
      const actions = snapshot.inputActions;
      const connected = typeof actions?.setDraft === 'function' && typeof actions?.submit === 'function';
      return { snapshot, actions, connected };
    };

    function MessageList({ snapshot, echo, scrollerRef }) {
      const shownUser = snapshot.lastUser !== '' ? snapshot.lastUser : echo;
      const shownAssistant = snapshot.lastAssistant;

      return h('div', { className: 'dsh-mw-body', ref: scrollerRef }, [
        shownUser === ''
          ? null
          : h('div', { key: 'u', className: 'dsh-mw-msg is-user' }, [
              h('div', { key: 'l', className: 'dsh-mw-label' }, t('you')),
              h('div', { key: 't', className: 'dsh-mw-text' }, shownUser),
            ]),
        h('div', { key: 'a', className: 'dsh-mw-msg is-assistant' }, [
          h(
            'div',
            { key: 'l', className: 'dsh-mw-label' },
            snapshot.running ? t('assistant') + ' · ' + t('running') : t('assistant'),
          ),
          h('div', { key: 't', className: 'dsh-mw-text' }, shownAssistant !== '' ? shownAssistant : t('empty')),
        ]),
      ]);
    }

    function Composer({ connected, sessionId, onSend }) {
      const [draft, setDraft] = useState('');

      const submit = () => {
        const content = draft.trim();
        if (content === '' || !connected) return;
        onSend(content);
        setDraft('');
      };

      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (event.nativeEvent?.isComposing === true || event.isComposing === true) return;
        event.preventDefault();
        submit();
      };

      return h('div', { className: 'dsh-mw-foot' }, [
        h('textarea', {
          key: 'input',
          className: 'dsh-mw-input',
          rows: 2,
          value: draft,
          placeholder: connected ? t('placeholder') : t('noSession'),
          onChange: (event) => setDraft(event.target.value),
          onKeyDown,
        }),
        h('div', { key: 'row', className: 'dsh-mw-actions' }, [
          h(
            'span',
            { key: 'hint', className: 'dsh-mw-hint' },
            connected ? String(sessionId ?? '').slice(0, 14) : t('noSession'),
          ),
          h(
            'button',
            {
              key: 'send',
              type: 'button',
              className: 'dsh-mw-send',
              disabled: !connected || draft.trim() === '',
              onClick: submit,
            },
            t('send'),
          ),
        ]),
      ]);
    }

    /* ────────────────────────── 入口按钮 ────────────────────────── */

    const BALL_SIZE = 44;

    const clampBall = (next) => {
      const maxX = Math.max(0, window.innerWidth - BALL_SIZE);
      const maxY = Math.max(0, window.innerHeight - BALL_SIZE);
      return { x: Math.min(Math.max(0, next.x), maxX), y: Math.min(Math.max(0, next.y), maxY) };
    };

    function Launcher() {
      const state = useStore(ui);
      const [pos, setPos] = useState(() => {
        const saved = readJSON(K.ball, null);
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return clampBall({ x: saved.x, y: saved.y });
        return clampBall({ x: window.innerWidth - BALL_SIZE - 24, y: window.innerHeight - BALL_SIZE - 150 });
      });
      const posRef = useRef(pos);
      posRef.current = pos;
      const dragRef = useRef(null);

      useEffect(() => {
        void syncFromHost();
      }, []);

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        dragRef.current = { dx: event.clientX - posRef.current.x, dy: event.clientY - posRef.current.y, moved: false };
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const dx = event.clientX - drag.dx;
        const dy = event.clientY - drag.dy;
        if (!drag.moved && Math.abs(dx - posRef.current.x) + Math.abs(dy - posRef.current.y) > 4) drag.moved = true;
        setPos(clampBall({ x: dx, y: dy }));
      };

      const onPointerUp = (event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (typeof event.currentTarget.releasePointerCapture === 'function') {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* 指针已释放。 */
          }
        }
        if (drag === null) return;
        writeJSON(K.ball, posRef.current);
        if (drag.moved) return;
        void toggleMini();
      };

      return h(React.Fragment, null, [
        h('style', { key: 'css' }, GLOBAL_CSS),
        h(
          'button',
          {
            key: 'ball',
            type: 'button',
            className: 'dsh-mw-ball' + (state.mini ? ' is-open' : '') + (state.inline ? ' has-inline' : ''),
            title: t('open') + ' — ' + t('hint'),
            style: { left: pos.x + 'px', top: pos.y + 'px' },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onContextMenu: (event) => {
              event.preventDefault();
              const next = !ui.get().inline;
              ui.set({ inline: next });
              writeJSON(K.inline, next);
            },
          },
          [
            h(
              'svg',
              { key: 'icon', viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true },
              h('path', {
                d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8A2.5 2.5 0 0 1 17.5 17H9l-4.2 3.2A.75.75 0 0 1 3.5 19.6V17.6A2.5 2.5 0 0 1 4 15.9Z',
                fill: 'currentColor',
                opacity: 0.9,
              }),
            ),
          ],
        ),
      ]);
    }

    /* ────────────────────────── 页内小窗 ────────────────────────── */

    const MIN_W = 260;
    const MIN_H = 170;
    const COLLAPSED_H = 34;

    const clampPos = (next, size) => {
      const maxX = Math.max(0, window.innerWidth - 60);
      const maxY = Math.max(0, window.innerHeight - COLLAPSED_H);
      return {
        x: Math.min(Math.max(80 - size.w, next.x), maxX),
        y: Math.min(Math.max(0, next.y), maxY),
      };
    };

    function InlineWindow() {
      const state = useStore(ui);
      const { snapshot, actions, connected } = useSessionData();
      const [pos, setPos] = useState(() => {
        const saved = readJSON(K.pos, null);
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return { x: saved.x, y: saved.y };
        return { x: Math.max(16, window.innerWidth - 380), y: Math.max(16, window.innerHeight - 520) };
      });
      const [size, setSize] = useState(() => {
        const saved = readJSON(K.size, null);
        if (Number.isFinite(saved?.w) && Number.isFinite(saved?.h)) {
          return { w: Math.max(MIN_W, saved.w), h: Math.max(MIN_H, saved.h) };
        }
        return { w: 340, h: 420 };
      });
      const [collapsed, setCollapsed] = useState(() => readJSON(K.collapsed, false) === true);
      const [echo, setEcho] = useState('');

      const posRef = useRef(pos);
      posRef.current = pos;
      const sizeRef = useRef(size);
      sizeRef.current = size;
      const dragRef = useRef(null);
      const resizeRef = useRef(null);
      const scrollerRef = useRef(null);

      useEffect(() => {
        const node = scrollerRef.current;
        if (node !== null) node.scrollTop = node.scrollHeight;
      }, [snapshot.lastAssistant, snapshot.lastUser, echo, collapsed]);

      if (!state.inline) return null;

      const send = (content) => {
        if (actions === undefined) return;
        actions.setDraft(content);
        actions.submit();
        setEcho(content);
      };

      const startDrag = (event) => {
        if (event.button !== 0) return;
        dragRef.current = { dx: event.clientX - posRef.current.x, dy: event.clientY - posRef.current.y };
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      };
      const moveDrag = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        setPos(clampPos({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, sizeRef.current));
      };
      const endDrag = (event) => {
        if (dragRef.current === null) return;
        dragRef.current = null;
        if (typeof event.currentTarget.releasePointerCapture === 'function') {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* 指针已释放。 */
          }
        }
        writeJSON(K.pos, posRef.current);
      };

      const startResize = (event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        resizeRef.current = { sx: event.clientX, sy: event.clientY, w: sizeRef.current.w, h: sizeRef.current.h };
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      };
      const moveResize = (event) => {
        const resize = resizeRef.current;
        if (resize === null) return;
        setSize({
          w: Math.max(MIN_W, resize.w + (event.clientX - resize.sx)),
          h: Math.max(MIN_H, resize.h + (event.clientY - resize.sy)),
        });
      };
      const endResize = (event) => {
        if (resizeRef.current === null) return;
        resizeRef.current = null;
        if (typeof event.currentTarget.releasePointerCapture === 'function') {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* 指针已释放。 */
          }
        }
        writeJSON(K.size, sizeRef.current);
      };

      return h(
        'div',
        {
          className: 'dsh-mw-root is-inline',
          style: {
            left: pos.x + 'px',
            top: pos.y + 'px',
            width: size.w + 'px',
            height: collapsed ? COLLAPSED_H : size.h + 'px',
          },
        },
        [
          h('style', { key: 'css' }, INLINE_CSS),
          h(
            'div',
            {
              key: 'head',
              className: 'dsh-mw-head',
              onPointerDown: startDrag,
              onPointerMove: moveDrag,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
            },
            [
              h('span', { key: 'dot', className: 'dsh-mw-dot' + (snapshot.running ? ' is-running' : '') }),
              h('span', { key: 'title', className: 'dsh-mw-title' }, t('title')),
              h('span', { key: 'spacer', className: 'dsh-mw-spacer' }),
              h(
                'button',
                {
                  key: 'toggle',
                  type: 'button',
                  className: 'dsh-mw-btn',
                  title: collapsed ? t('expand') : t('collapse'),
                  onPointerDown: (event) => event.stopPropagation(),
                  onClick: () => {
                    const next = !collapsed;
                    setCollapsed(next);
                    writeJSON(K.collapsed, next);
                  },
                },
                collapsed ? '▢' : '—',
              ),
              h(
                'button',
                {
                  key: 'close',
                  type: 'button',
                  className: 'dsh-mw-btn',
                  title: t('close'),
                  onPointerDown: (event) => event.stopPropagation(),
                  onClick: () => {
                    ui.set({ inline: false });
                    writeJSON(K.inline, false);
                  },
                },
                '✕',
              ),
            ],
          ),
          collapsed ? null : h(MessageList, { key: 'body', snapshot, echo, scrollerRef }),
          collapsed ? null : h(Composer, { key: 'foot', connected, sessionId: snapshot.sessionId, onSend: send }),
          collapsed
            ? null
            : h('div', {
                key: 'grip',
                className: 'dsh-mw-resize',
                onPointerDown: startResize,
                onPointerMove: moveResize,
                onPointerUp: endResize,
                onPointerCancel: endResize,
              }),
        ],
      );
    }

    /* ────────────────────────── 提示条 ────────────────────────── */

    function Toast() {
      const state = useStore(ui);
      useEffect(() => {
        if (state.toast === '') return undefined;
        const timer = window.setTimeout(() => ui.set({ toast: '' }), 4000);
        return () => window.clearTimeout(timer);
      }, [state.toast]);
      if (state.toast === '') return null;
      return h('div', { className: 'dsh-mw-toast' }, state.toast);
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    const BASE_CSS = `
.dsh-mw-root{box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;
background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1c1c1c);
font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;line-height:1.55}
.dsh-mw-head{flex:none;display:flex;align-items:center;gap:8px;height:34px;box-sizing:border-box;padding:0 8px 0 10px;
user-select:none;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));
background:var(--dsw-alias-bg-layer-2,transparent)}
.dsh-mw-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#b9b9b9)}
.dsh-mw-dot.is-running{background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-mw-title{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mw-spacer{flex:1 1 auto}
.dsh-mw-btn{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;
color:var(--dsw-alias-label-secondary,#666666);cursor:pointer;font-size:12px;line-height:1}
.dsh-mw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-mw-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.dsh-mw-msg{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-mw-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dsh-mw-text{white-space:pre-wrap;word-break:break-word}
.dsh-mw-msg.is-user .dsh-mw-text{color:var(--dsw-alias-label-secondary,#555555)}
.dsh-mw-foot{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px;
border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#ffffff)}
.dsh-mw-input{width:100%;box-sizing:border-box;resize:none;padding:6px 8px;font:inherit;color:inherit;outline:none;
border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,8px);
background:var(--dsw-alias-bg-layer-2,transparent)}
.dsh-mw-input:focus{border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.28))}
.dsh-mw-actions{display:flex;align-items:center;gap:8px}
.dsh-mw-hint{flex:1 1 auto;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mw-send{flex:none;height:26px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md,8px);font:inherit;cursor:pointer;
background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#ffffff)}
.dsh-mw-send:hover{background:var(--dsw-alias-button-primary-hover,#3d59e0)}
.dsh-mw-send:disabled{opacity:.5;cursor:default}
`;

    const INLINE_CSS = `
${BASE_CSS}
.dsh-mw-root.is-inline{position:fixed;z-index:60;pointer-events:auto;
border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-lg,12px);
box-shadow:var(--dsw-elevation-prominent,0 10px 32px rgba(0,0,0,.18))}
.dsh-mw-root.is-inline .dsh-mw-head{cursor:grab}
.dsh-mw-root.is-inline .dsh-mw-head:active{cursor:grabbing}
.dsh-mw-root.is-inline .dsh-mw-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;
background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-border-l3,rgba(0,0,0,.22)) 50%)}
`;

    /**
     * 常驻入口按钮、提示条与小窗形态的样式。
     *
     * 入口按钮必须**始终**存在，所以这份样式由 Launcher 自己注入，
     * 不依赖页内小窗是否打开。
     */
    const BALL_CSS = `
.dsh-mw-ball{position:fixed;z-index:61;box-sizing:border-box;width:44px;height:44px;padding:0;display:flex;
align-items:center;justify-content:center;pointer-events:auto;cursor:grab;border-radius:50%;border:none;
background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#ffffff);
box-shadow:var(--dsw-elevation-prominent,0 6px 18px rgba(0,0,0,.24));transition:transform .12s ease}
.dsh-mw-ball:hover{transform:scale(1.06)}
.dsh-mw-ball:active{cursor:grabbing;transform:scale(.97)}
.dsh-mw-ball.is-open{background:var(--dsw-alias-state-business-primary,#3d59e0)}
.dsh-mw-ball.has-inline::after{content:"";position:absolute;right:3px;bottom:3px;width:9px;height:9px;border-radius:50%;
background:var(--dsw-alias-state-idle-primary,#b9b9b9);border:2px solid var(--dsw-alias-bg-layer-1,#ffffff)}
.dsh-mw-toast{position:fixed;z-index:62;left:50%;bottom:88px;transform:translateX(-50%);pointer-events:auto;
max-width:60vw;padding:8px 14px;border-radius:8px;font:13px/1.5 var(--dsw-font-family,system-ui,sans-serif);
background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1c1c1c);
border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.18))}
/* 小窗形态：窗口只剩几百像素宽，去掉顶部菜单条与页内浮窗，只留对话与输入。 */
html.dsh-mini-mode [data-windows-menu]{display:none !important}
html.dsh-mini-mode .dsh-mw-root.is-inline{display:none !important}
`;

    const GLOBAL_CSS = BASE_CSS + BALL_CSS;

    /* ────────────────────────── 插件 ────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, DICT.zh);
          ctx.locale.register(NS, 'en', DICT.en);
          const bound = ctx.locale.bind(NS);
          const fallback = t;
          t = (key, vars) => {
            const value = bound(key, vars);
            return value === key ? fallback(key) : value;
          };
        } catch (error) {
          /* 词典注册不可用时退回内置中文文案，不影响小窗。 */
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'mini-window.launcher', order: 300 }, Launcher),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'mini-window.inline', order: 301 }, InlineWindow),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'mini-window.toast', order: 302 }, Toast),
        );

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'mini-window.bridge', order: 900 }, SessionBridge),
        );

        /* 记住页内小窗的开合，刷新后回到上次状态。 */
        ui.set({ inline: readJSON(K.inline, false) === true });
      },
    };
  },
});