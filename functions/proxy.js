/**
 * Cloudflare Pages Function: 东方财富 API 代理
 * 路径: /proxy?url=<encoded_eastmoney_url>
 * 浏览器请求同域 /proxy 端点，Worker代为请求东方财富数据并返回
 */

const ALLOWED_HOSTS = [
  'push2.eastmoney.com',
  'push2his.eastmoney.com',
  'searchapi.eastmoney.com',
  'api.binance.com',
  'www.okx.com',
];

export async function onRequest(context) {
  const { request } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ status: 'ok', ts: Date.now(), msg: 'em-proxy ready. Use ?url=<encoded_url>' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid url' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!ALLOWED_HOSTS.includes(parsedTarget.hostname)) {
    return new Response(JSON.stringify({ error: 'Host not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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

    // Strip JSONP callback wrapper if present → return pure JSON
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
    return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + e.message }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
