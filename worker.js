/**
 * 检验记录表 — Cloudflare Worker
 * 职责：作为浏览器和 Cloudflare KV 之间的中间层
 *   - GET  ?key=xxx           读取某个 key 的数据（返回 JSON）
 *   - PUT  ?key=xxx + body    写入/覆盖某个 key 的数据（body 为 JSON，需密码）
 *   - GET  /list              列出所有已存储的 key（需密码，自动分页取全）
 *   - GET  /snapshots         列出所有历史快照（需密码，自动分页取全）
 *   - POST /snapshot          手动创建一份当天快照（需密码）
 *   - DELETE ?key=xxx         删除某个 key（需密码）
 *   - scheduled               定时触发：每天自动把主数据复制成 backup_YYYY-MM-DD，并清理 30 天前的旧快照
 *
 * v2.1 改进：
 *   - /list 与 /snapshots 支持 KV 分页游标，key 超过 1000 个也能全部列出
 *   - 定时任务容错：快照创建失败不再阻塞旧快照清理
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
        const keys = await listAllKeys(env);
        return new Response(JSON.stringify({ ok: true, keys }), { headers: corsHeaders });
      }

      // ---------- 列出历史快照 ----------
      if (request.method === 'GET' && url.pathname === '/snapshots') {
        if (!checkPassword()) {
          return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: corsHeaders });
        }
        const snapshots = (await listAllKeys(env, SNAPSHOT_PREFIX)).sort().reverse();
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

  // 定时触发器：每天自动快照 + 清理旧快照（互不阻塞）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await createSnapshot(env);
      } catch (e) {
        // 快照失败不阻塞后续清理
      }
      try {
        await cleanupSnapshots(env);
      } catch (e) {
        // 忽略清理错误
      }
    })());
  }
};

/** 分页列出 KV 中所有匹配前缀的 key（单页最多 1000 个，自动翻页取全） */
async function listAllKeys(env, prefix) {
  const names = [];
  let cursor;
  do {
    const params = { limit: 1000 };
    if (prefix) params.prefix = prefix;
    if (cursor) params.cursor = cursor;
    const page = await env.KV.list(params);
    page.keys.forEach((k) => names.push(k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** 把主数据复制成当天快照 backup_YYYY-MM-DD */
async function createSnapshot(env) {
  const value = await env.KV.get(MAIN_KEY);
  if (value === null) return false;
  const dateStr = new Date().toISOString().slice(0, 10);
  await env.KV.put(SNAPSHOT_PREFIX + dateStr, value);
  return true;
}

/** 清理超过保留天数的旧快照 */
async function cleanupSnapshots(env) {
  const names = await listAllKeys(env, SNAPSHOT_PREFIX);
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const name of names) {
    const datePart = name.slice(SNAPSHOT_PREFIX.length);
    const ts = new Date(datePart + 'T00:00:00Z').getTime();
    if (!isNaN(ts) && ts < cutoff) {
      await env.KV.delete(name);
    }
  }
}
