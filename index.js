/**
 * dsh-mini-window —— Host 半边。
 *
 * 浏览器半边只能改页面内部：`shell.overlay` 的浮层、Document PiP 全都在 Harness
 * 主窗口里合成，跨应用切走就被盖住。真正的「常驻在屏幕最上层」必须动原生窗口，
 * 所以这里在 Host 进程里暴露一个控制端点，由浏览器半边的入口按钮触发，调用
 * Win32 把 Harness 主窗口切成置顶小窗（或恢复原状）。
 *
 * 端点：
 *   GET  /state   → 当前状态与屏幕信息
 *   POST /state   → { mode: 'enter' | 'exit', width?, height? }（物理像素）
 *   GET  /health  → { ok: true }
 *
 * 两条通道同时提供：
 *   1. dsh 自带 webServer 的 `/api/mini-window`（页面用相对路径访问 → 同源，
 *      自定义 `dsh-app://` 协议下不会撞跨源与混合内容限制）；
 *   2. 回环端口 127.0.0.1:19731（webServer 服务不可用时的兜底），带 CORS 头。
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 兜底控制服务端口；只绑回环，不对外。 */
const PORT = 19731;
const HOST = '127.0.0.1';

/** dsh webServer 上的同源前缀。 */
const ROUTE_PREFIX = '/api/mini-window';

/** 小窗默认尺寸（物理像素；150% 缩放下约合 400×600 CSS 像素）。 */
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 900;

const SCRIPT = fileURLToPath(new URL('./scripts/win-mini-window.ps1', import.meta.url));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/** 运行窗口控制脚本并解析它输出的单行 JSON。 */
const runScript = (action, extra = []) =>
  new Promise((resolve) => {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Action',
      action,
      ...extra,
    ];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      const text = String(stdout ?? '').trim();
      const line = text
        .split(/\r?\n/)
        .filter((row) => row.trim().startsWith('{'))
        .pop();
      let parsed;
      if (line !== undefined) {
        try {
          parsed = JSON.parse(line);
        } catch (parseError) {
          parsed = undefined;
        }
      }
      resolve({
        ok: error === null && parsed?.ok !== false,
        result: parsed ?? null,
        error: error === null ? String(stderr ?? '').trim() : String(error.message ?? error),
      });
    });
  });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 16384) req.destroy();
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        const value = JSON.parse(raw);
        resolve(value !== null && typeof value === 'object' ? value : {});
      } catch (error) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

export const name = 'mini-window';

export function apply(ctx) {
  /** 小窗模式是否已生效（幂等与退出清理用）。 */
  let mode = 'full';

  const send = (res, status, payload, withCors) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(withCors ? CORS : {}),
    });
    res.end(JSON.stringify(payload));
  };

  /**
   * 控制端点的唯一实现；`withCors` 只在回环端口那侧打开（同源路由不需要）。
   */
  const handle = async (req, res, base, withCors) => {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, withCors ? CORS : {});
      res.end();
      return;
    }

    if (path === '/health') {
      send(res, 200, { ok: true, mode, route: ROUTE_PREFIX }, withCors);
      return;
    }

    if (path === '/state') {
      if (req.method === 'GET') {
        const probe = await runScript('status');
        send(res, 200, { ok: probe.ok, mode, host: probe.result, error: probe.error }, withCors);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const target = body.mode === 'exit' ? 'exit' : 'enter';
        if (target === mode) {
          send(res, 200, { ok: true, mode, unchanged: true }, withCors);
          return;
        }
        const width = Number.isFinite(body.width) ? Math.max(320, Math.round(body.width)) : DEFAULT_WIDTH;
        const height = Number.isFinite(body.height) ? Math.max(320, Math.round(body.height)) : DEFAULT_HEIGHT;
        const run =
          target === 'enter'
            ? await runScript('enter', ['-Width', String(width), '-Height', String(height)])
            : await runScript('exit');
        if (run.ok) mode = target;
        send(res, run.ok ? 200 : 500, { ok: run.ok, mode, result: run.result, error: run.error }, withCors);
        return;
      }
    }

    send(res, 404, { ok: false, error: 'not-found' }, withCors);
  };

  /* 通道 1：挂在 dsh 自己的 webServer 上（同源）。 */
  try {
    const webServer =
      (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer ?? undefined;
    if (typeof webServer?.register === 'function') {
      const prefix = ROUTE_PREFIX;
      ctx.effect(
        () =>
          webServer.register({
            kind: 'prefix',
            path: prefix,
            handler: (req, res) => {
              const url = new URL(req.url ?? '/', `http://${HOST}`);
              const rest = url.pathname.slice(prefix.length) || '/';
              const shim = { method: req.method, url: rest, on: req.on.bind(req), destroy: req.destroy.bind(req) };
              void handle(shim, res, `http://${HOST}${prefix}`, false);
            },
          }),
        'mini-window: same-origin control route',
      );
    }
  } catch (error) {
    ctx.logger?.warn?.(`mini-window: webServer route unavailable — ${String(error?.message ?? error)}`);
  }

  /* 通道 2：回环端口兜底。 */
  const server = createServer((req, res) => {
    void handle(req, res, `http://${HOST}:${String(PORT)}`, true);
  });
  server.on('error', (error) => {
    ctx.logger?.warn?.(
      `mini-window: fallback control server unavailable on ${HOST}:${String(PORT)} — ${String(error?.message ?? error)}`,
    );
  });
  server.listen(PORT, HOST);

  ctx.effect(
    () => () => {
      try {
        server.close();
      } catch (error) {
        /* 已关闭。 */
      }
      if (mode === 'enter') void runScript('exit');
    },
    'mini-window: control server',
  );
}