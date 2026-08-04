/**
 * 检验记录表 — Cloudflare Worker
 * 职责：作为浏览器和 Cloudflare KV 之间的中间层
 *   - GET  ?key=xxx           读取某个 key 的数据（返回 JSON）
 *   - PUT  ?key=xxx + body    写入/覆盖某个 key 的数据（body 为 JSON，需密码）
 *   - GET  /list              列出所有已存储的 key（需密码）
 *   - GET  /snapshots         列出所有历史快照（需密码）
 *   - POST /snapshot          手动创建一份当天快照（需密码）
 *   - DELETE ?key=xxx         删除某个 key（需密码）
 *   - scheduled               定时触发：每天自动把主数据复制成 backup_YYYY-MM-DD，并清理 30 天前的旧快照
 *
 * 部署方法：
 *   1. Cloudflare Dashboard → Workers & Pages → Create Worker
 *   2. 把本文件全部内容粘贴进编辑器，部署
 *   3. 在该 Worker 的 Settings → Variables → KV Namespace Bindings
 *      添加绑定：变量名填 `KV`（必须一致），选择你建好的 KV 命名空间
 *   4. 在 Settings → Variables 添加 `WRITE_PASSWORD` 为你的密码
 *   5. 在 Settings → Triggers → Cron Triggers 添加定时：`0 2 * * *`（每天凌晨2点自动快照）
 *   6. 记下 Worker 的域名（形如 https://xxx.workers.dev）
 */

// 主数据 key（与网页端约定一致）
const MAIN_KEY = 'inspection_all';
const SNAPSHOT_PREFIX = 'backup_';
const SNAPSHOT_RETENTION_DAYS = 30;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-password',
      'Content-Type': 'application/json; charset=utf-8'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    function checkPassword() {
      const pwd = request.headers.get('x-password') || '';
      return pwd === env.WRITE_PASSWORD;
    }

    try {
      // ---------- 读取单个 key ----------
      if (request.method === 'GET' && key) {
        const value = await env.KV.get(key);
        if (value === null) {
          return new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404, headers: corsHeaders });
        }
        return new Response(value, { headers: corsHeaders });
      }

      // ---------- 列出所有 key ----------
      if (request.method === 'GET' && url.pathname === '/list') {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        const list = await env.KV.list();
        return new Response(JSON.stringify({ ok: true, keys: list.keys.map(k => k.name) }), { headers: corsHeaders });
      }

      // ---------- 列出历史快照 ----------
      if (request.method === 'GET' && url.pathname === '/snapshots') {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        const list = await env.KV.list({ prefix: SNAPSHOT_PREFIX });
        const snapshots = list.keys
          .map(k => k.name)
          .sort()
          .reverse();
        return new Response(JSON.stringify({ ok: true, snapshots }), { headers: corsHeaders });
      }

      // ---------- 手动创建当天快照 ----------
      if (request.method === 'POST' && url.pathname === '/snapshot') {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        const ok = await createSnapshot(env);
        if (!ok) {
          return new Response(JSON.stringify({ ok: false, error: 'no data to snapshot' }), { status: 404, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      // ---------- 写入 ----------
      if (request.method === 'PUT' && key) {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        const body = await request.text();
        await env.KV.put(key, body);
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      // ---------- 删除 ----------
      if (request.method === 'DELETE' && key) {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        await env.KV.delete(key);
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ ok: false, error: 'invalid request' }), { status: 400, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: corsHeaders });
    }
  },

  // 定时触发器：每天自动快照 + 清理旧快照
  async scheduled(event, env, ctx) {
    ctx.waitUntil(createSnapshot(env).then(() => cleanupSnapshots(env)));
  }
};

/** 把主数据复制成当天快照 backup_YYYY-MM-DD */
async function createSnapshot(env) {
  const value = await env.KV.get(MAIN_KEY);
  if (value === null) return false;
  const today = new Date();
  const dateStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
  await env.KV.put(SNAPSHOT_PREFIX + dateStr, value);
  return true;
}

/** 清理超过保留天数的旧快照 */
async function cleanupSnapshots(env) {
  const list = await env.KV.list({ prefix: SNAPSHOT_PREFIX });
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const k of list.keys) {
    const datePart = k.name.slice(SNAPSHOT_PREFIX.length);
    const ts = new Date(datePart + 'T00:00:00Z').getTime();
    if (!isNaN(ts) && ts < cutoff) {
      await env.KV.delete(k.name);
    }
  }
}
