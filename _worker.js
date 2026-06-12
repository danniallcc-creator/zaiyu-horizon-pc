/**
 * Cloudflare Pages Advanced Mode (_worker.js)
 * 拦截 /proxy 请求做API代理, 其他请求直接返回静态资源
 */

const ALLOWED_HOSTS = [
  'push2.eastmoney.com',
  'push2his.eastmoney.com',
  'searchapi.eastmoney.com',
  'api.binance.com',
  'www.okx.com',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 只拦截 /proxy 路径, 其他请求交给静态资产
    if (url.pathname === '/proxy') {
      return handleProxy(request, url);
    }
    
    // 非 /proxy 路径: 交给 Pages 的静态资产处理, 但对HTML禁用缓存确保用户总获取最新版
    const resp = await env.ASSETS.fetch(request);
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      const newResp = new Response(resp.body, resp);
      newResp.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      newResp.headers.set('Pragma', 'no-cache');
      return newResp;
    }
    return resp;
  }
};

async function handleProxy(request, url) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ status: 'ok', ts: Date.now(), msg: 'em-proxy ready' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid url' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!ALLOWED_HOSTS.includes(parsedTarget.hostname)) {
    return new Response(JSON.stringify({ error: 'Host not allowed' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/',
      },
    });

    let body = await resp.text();

    // Strip JSONP wrapper → pure JSON
    const cbMatch = body.match(/^[a-zA-Z_][a-zA-Z0-9_]*\(([\s\S]*)\);?\s*$/);
    if (cbMatch) {
      body = cbMatch[1];
    }

    return new Response(body, {
      status: resp.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=5',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream failed: ' + e.message }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
