/**
 * Reverse Image Finder — Cloudflare Worker
 * Version: v14-github-multi-engine
 *
 * Required Cloudflare bindings:
 *   Secret: SEARCHAPI_KEY
 *   KV:     TEMP_IMAGES
 * Optional:
 *   Text:   ALLOWED_ORIGINS = *
 */

const VERSION = 'v14-github-multi-engine';
const SEARCHAPI_ENDPOINT = 'https://www.searchapi.io/api/v1/search';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_SEND_BYTES = 5.8 * 1024 * 1024;
const TEMP_TTL_SECONDS = 30 * 60;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return htmlResponse(cors);
      }

      if (request.method === 'GET' && url.pathname === '/app.js') {
        return jsResponse(cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json({
          ok: true,
          service: 'Reverse Image Finder Multi Engine SearchAPI Worker',
          version: VERSION,
          hasSearchApi: Boolean(env.SEARCHAPI_KEY),
          hasTempKv: Boolean(env.TEMP_IMAGES),
          tempStorage: 'Workers KV JSON base64',
          required: ['SEARCHAPI_KEY', 'TEMP_IMAGES'],
          engines: [
            'yandex_reverse_image',
            'google_lens exact_matches',
            'google_lens visual_matches',
            'google_images fallback'
          ]
        }, 200, cors);
      }

      if (request.method === 'GET' && url.pathname === '/api/debug-temp') {
        requireEnv(env);
        const b64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';
        const key = 'debug-' + crypto.randomUUID() + '.jpg';
        await env.TEMP_IMAGES.put(key, JSON.stringify({ type: 'image/jpeg', b64, createdAt: Date.now(), size: b64.length }), { expirationTtl: 120 });
        return json({ ok: true, tempUrl: new URL('/temp-image/' + key, request.url).toString() }, 200, cors);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/temp-image/')) {
        return serveTempImage(url, env, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/search') {
        return handleSearch(request, env, cors);
      }

      return json({ ok: false, error: 'Неизвестный адрес: ' + url.pathname }, 404, cors);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error), version: VERSION }, 500, cors);
    }
  }
};

function requireEnv(env) {
  if (!env.SEARCHAPI_KEY) throw new Error('Не задан SEARCHAPI_KEY в Cloudflare Variables and Secrets.');
  if (!env.TEMP_IMAGES) throw new Error('Не подключён KV binding TEMP_IMAGES.');
}

async function handleSearch(request, env, cors) {
  requireEnv(env);

  const form = await request.formData();
  const file = form.get('image');
  const mode = String(form.get('mode') || 'max');
  const country = String(form.get('country') || 'ru').toLowerCase();

  if (!(file instanceof File)) throw new Error('Файл изображения не получен.');
  if (!ALLOWED_MIME.has(file.type)) throw new Error('Поддерживаются только JPG, PNG и WEBP.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Файл слишком большой. Максимум 10 МБ.');
  if (file.size > MAX_SEND_BYTES) throw new Error('Файл слишком большой для временной публикации. Уменьши изображение до 5–6 МБ.');

  const buffer = await file.arrayBuffer();
  const key = 'temp-' + crypto.randomUUID() + extensionByMime(file.type);
  const b64 = arrayBufferToBase64(buffer);

  await env.TEMP_IMAGES.put(key, JSON.stringify({
    type: file.type,
    name: cleanName(file.name || key),
    size: file.size,
    createdAt: Date.now(),
    b64
  }), { expirationTtl: TEMP_TTL_SECONDS });

  const imageUrl = new URL('/temp-image/' + key, request.url).toString();
  await sleep(3500);

  const started = Date.now();
  const diagnostics = [{ step: 'temp_url_created', imageUrl, size: file.size, type: file.type }];
  const collected = [];
  const relatedQueries = new Set();
  const sourcesUsed = [];

  const yandex = await safeSearchWithRetry(env, {
    engine: 'yandex_reverse_image',
    url: imageUrl,
    country,
    num: '20'
  }, 'Yandex Reverse Image', diagnostics);
  if (yandex.ok) {
    sourcesUsed.push('Yandex Reverse Image');
    collectYandex(yandex.data, collected, relatedQueries);
  }

  if (mode === 'deep' || mode === 'max') {
    const exact = await safeSearchWithRetry(env, {
      engine: 'google_lens',
      url: imageUrl,
      type: 'exact_matches',
      country,
      hl: 'ru'
    }, 'Google Lens Exact', diagnostics);
    if (exact.ok) {
      sourcesUsed.push('Google Lens Exact');
      collectGoogleLens(exact.data, collected, relatedQueries, 'точное', 94, 'Google Lens Exact');
    }

    const visual = await safeSearchWithRetry(env, {
      engine: 'google_lens',
      url: imageUrl,
      type: 'visual_matches',
      country,
      hl: 'ru'
    }, 'Google Lens Visual', diagnostics);
    if (visual.ok) {
      sourcesUsed.push('Google Lens Visual');
      collectGoogleLens(visual.data, collected, relatedQueries, 'похожее', 78, 'Google Lens Visual');
    }
  }

  if (mode === 'max') {
    const queries = Array.from(relatedQueries).filter(Boolean).slice(0, 3);
    for (const q of queries) {
      const images = await safeSearchApi(env, {
        engine: 'google_images',
        q,
        country,
        hl: 'ru',
        num: '10'
      }, 'Google Images: ' + q, diagnostics);
      if (images.ok) {
        sourcesUsed.push('Google Images');
        collectGoogleImages(images.data, collected, q);
      }
    }
  }

  const results = dedupeAndSort(collected);
  diagnostics.push({ step: 'done', ms: Date.now() - started, rawItems: collected.length, results: results.length, sourcesUsed });

  return json({
    ok: true,
    version: VERSION,
    imageUrl,
    mode,
    country,
    sourcesUsed: Array.from(new Set(sourcesUsed)),
    total: results.length,
    results,
    diagnostics
  }, 200, cors);
}

async function safeSearchWithRetry(env, params, label, diagnostics) {
  const delays = [0, 7000, 16000, 30000];
  let last;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    last = await safeSearchApi(env, params, label + ' attempt ' + (i + 1), diagnostics);
    if (last.ok) return last;
    const msg = String(last.error || '').toLowerCase();
    if (!msg.includes('image') && !msg.includes('url') && !msg.includes('404') && !msg.includes('fetch')) break;
  }
  return last;
}

async function safeSearchApi(env, params, label, diagnostics) {
  try {
    const data = await callSearchApi(env, params);
    diagnostics.push({ step: 'source_ok', source: label, keys: Object.keys(data || {}).slice(0, 12) });
    return { ok: true, data };
  } catch (error) {
    diagnostics.push({ step: 'source_error', source: label, error: error.message || String(error) });
    return { ok: false, error: error.message || String(error) };
  }
}

async function callSearchApi(env, params) {
  const url = new URL(SEARCHAPI_ENDPOINT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 65000);
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok || data.error) {
    const message = data.error || data.message || text.slice(0, 300) || ('HTTP ' + response.status);
    throw new Error(String(message));
  }
  return data;
}

function collectYandex(data, out, queries) {
  const visual = asArray(data.visual_matches);
  for (const item of visual) out.push(normalize(item, 'Yandex Reverse Image', item.exact_match ? 'точное' : 'похожее', item.exact_match ? 96 : 82));

  const similar = asArray(data.similar_images);
  for (const item of similar) out.push(normalize(item, 'Yandex Similar Images', 'похожее', 72));

  const sizes = asArray(data.image_sizes);
  for (const item of sizes) out.push(normalize(item, 'Yandex Image Sizes', 'точное', 92));

  for (const q of asArray(data.related_searches)) {
    const text = q.query || q.title || q.text;
    if (text) queries.add(String(text));
  }
}

function collectGoogleLens(data, out, queries, type, score, source) {
  for (const item of asArray(data.exact_matches)) out.push(normalize(item, source, 'точное', 96));
  for (const item of asArray(data.visual_matches)) out.push(normalize(item, source, type, score));
  for (const item of asArray(data.related_content)) {
    if (item.query) queries.add(String(item.query));
    out.push(normalize(item, source + ' Related', 'возможное', 55));
  }
}

function collectGoogleImages(data, out, query) {
  for (const item of asArray(data.images)) out.push(normalize(item, 'Google Images: ' + query, 'возможное', 50));
}

function normalize(item, source, matchType, score) {
  const link = item.link || item.url || item.source_link || item.page || item.serpapi_link || '';
  const image = item.thumbnail || item.image || item.original || item.image_url || item.src || '';
  const title = item.title || item.name || item.source || getDomain(link) || 'Найденное изображение';
  const description = item.snippet || item.description || item.content || item.query || '';
  return {
    title: String(title),
    url: String(link || image),
    domain: getDomain(link || image),
    preview: String(image || ''),
    similarity: Math.max(1, Math.min(100, Number(score || 50))),
    matchType,
    source,
    description: String(description).slice(0, 300)
  };
}

function dedupeAndSort(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.url) continue;
    const key = normalizeUrl(item.url);
    if (!key) continue;
    const old = map.get(key);
    if (!old || item.similarity > old.similarity) map.set(key, item);
  }
  return Array.from(map.values()).sort((a, b) => b.similarity - a.similarity).slice(0, 80);
}

async function serveTempImage(url, env, cors) {
  if (!env.TEMP_IMAGES) return new Response('TEMP_IMAGES is not configured', { status: 500, headers: cors });
  const key = decodeURIComponent(url.pathname.replace('/temp-image/', ''));
  const raw = await env.TEMP_IMAGES.get(key);
  if (!raw) return new Response('Not found', { status: 404, headers: cors });
  let meta;
  try { meta = JSON.parse(raw); } catch { return new Response('Bad temp object', { status: 500, headers: cors }); }
  const bytes = base64ToUint8Array(meta.b64 || '');
  return new Response(bytes, {
    status: 200,
    headers: {
      ...cors,
      'content-type': meta.type || 'image/jpeg',
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=120',
      'cross-origin-resource-policy': 'cross-origin',
      'content-disposition': 'inline; filename="image"'
    }
  });
}

function htmlResponse(cors) {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reverse Image Finder</title><style>
*{box-sizing:border-box}html,body{margin:0;max-width:100%;overflow-x:hidden}body{font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;background:#080b12;color:#ecf2ff}.wrap{width:min(1180px,100%);margin:0 auto;padding:24px}.hero{border:1px solid rgba(255,255,255,.12);border-radius:28px;padding:28px;background:linear-gradient(135deg,#111827,#0b1220 55%,#101827);box-shadow:0 24px 80px rgba(0,0,0,.35)}h1{margin:0 0 8px;font-size:clamp(28px,5vw,56px);line-height:1.02}p{color:#aeb9cc}.panel{margin-top:18px;border:1px solid rgba(255,255,255,.11);border-radius:22px;padding:18px;background:rgba(255,255,255,.045);min-width:0}.grid{display:grid;grid-template-columns:1fr 320px;gap:16px;min-width:0}.upload{min-width:0;border:1px dashed rgba(255,255,255,.24);border-radius:20px;padding:18px;background:rgba(0,0,0,.18)}input,select,button{width:100%;border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:13px 14px;background:#101827;color:#fff}input[type=file]{background:#0d1422;cursor:pointer}button{cursor:pointer;background:linear-gradient(135deg,#7c3aed,#2563eb);font-weight:800}.btn2{background:#141d2e}.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;min-width:0}.preview{max-width:100%;border-radius:16px;margin-top:12px;display:none}.status{white-space:pre-wrap;overflow-wrap:anywhere;background:#050813;border-radius:16px;padding:14px;margin-top:12px;color:#b9c7dd}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:18px;min-width:0}.card{border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:14px;background:#0d1422;min-width:0}.card img{width:100%;height:170px;object-fit:cover;border-radius:13px;background:#050813}.card h3{font-size:16px;overflow-wrap:anywhere}.url,.domain{overflow-wrap:anywhere;color:#93c5fd;font-size:13px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#162033;margin-right:6px}.tools{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.tools button{width:auto}.small{font-size:12px;color:#93a4bc}@media(max-width:820px){.wrap{padding:12px}.hero{padding:18px;border-radius:20px}.grid,.row{grid-template-columns:1fr}.tools button{width:100%}}
</style></head><body><main class="wrap"><section class="hero"><h1>AI Reverse Image Finder</h1><p>Загрузи изображение. Worker выполнит поиск через Yandex Reverse Image, Google Lens и Google Images fallback.</p><div class="panel grid"><div class="upload"><label>Изображение JPG / PNG / WEBP</label><input id="file" type="file" accept="image/jpeg,image/png,image/webp"><img id="preview" class="preview" alt="preview"><div class="small">Файл не хранится постоянно. Временная копия удаляется по TTL из Workers KV.</div></div><div><label>Режим поиска</label><select id="mode"><option value="fast">Быстрый — Яндекс</option><option value="deep">Глубокий — Яндекс + Google Lens</option><option value="max" selected>Максимум — все источники</option></select><label style="display:block;margin-top:12px">Регион</label><select id="country"><option value="ru" selected>Россия</option><option value="us">США</option><option value="de">Германия</option><option value="tr">Турция</option><option value="at">Австрия</option></select><button id="search" style="margin-top:12px">Найти изображение</button><button id="health" class="btn2" style="margin-top:10px">Проверить настройки</button></div></div><div class="row"><button id="copy" class="btn2">Копировать ссылки</button><button id="json" class="btn2">Экспорт JSON</button><button id="clear" class="btn2">Очистить результаты</button></div><div id="status" class="status">Готово. Выбери изображение.</div><div id="results" class="cards"></div></section></main><script src="/app.js?v=14"></script></body></html>`;
  return new Response(html, { status: 200, headers: { ...cors, 'content-type': 'text/html; charset=utf-8' } });
}

function jsResponse(cors) {
  const js = `
(function(){
'use strict';
var file=document.getElementById('file'), preview=document.getElementById('preview'), search=document.getElementById('search'), status=document.getElementById('status'), results=document.getElementById('results');
var mode=document.getElementById('mode'), country=document.getElementById('country');
var last=[];
function setStatus(t){status.textContent=t;}
function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function render(items){last=items||[];results.innerHTML='';if(!last.length){results.innerHTML='<div class="card"><h3>Ничего не найдено</h3><p>Попробуй режим Максимум или другое изображение.</p></div>';return;}last.forEach(function(r){var d=document.createElement('div');d.className='card';d.innerHTML=(r.preview?'<img src="'+esc(r.preview)+'" loading="lazy" referrerpolicy="no-referrer">':'')+'<div><span class="badge">'+esc(r.matchType)+'</span><span class="badge">'+esc(r.similarity)+'%</span></div><h3>'+esc(r.title)+'</h3><div class="domain">'+esc(r.domain)+'</div><div class="url">'+esc(r.url)+'</div><p>'+esc(r.description)+'</p><a href="'+esc(r.url)+'" target="_blank" rel="noopener"><button>Открыть сайт</button></a>';results.appendChild(d);});}
file.addEventListener('change',function(){var f=file.files&&file.files[0];if(!f)return;if(!/^image\/(jpeg|png|webp)$/.test(f.type)){setStatus('Неверный формат. Нужен JPG, PNG или WEBP.');file.value='';return;}if(f.size>10*1024*1024){setStatus('Файл больше 10 МБ. Уменьши изображение.');file.value='';return;}preview.src=URL.createObjectURL(f);preview.style.display='block';setStatus('Файл выбран: '+f.name+' ('+Math.round(f.size/1024)+' КБ)');});
search.addEventListener('click',function(){var f=file.files&&file.files[0];if(!f){setStatus('Сначала выбери изображение.');return;}var fd=new FormData();fd.append('image',f);fd.append('mode',mode.value);fd.append('country',country.value);search.disabled=true;setStatus('Отправка изображения...');fetch('/api/search',{method:'POST',body:fd}).then(function(r){return r.text().then(function(t){var j;try{j=JSON.parse(t);}catch(e){throw new Error('Backend вернул не JSON: '+t.slice(0,300));}if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));return j;});}).then(function(j){setStatus('Готово. Найдено: '+j.total+'\nИсточники: '+(j.sourcesUsed||[]).join(', ')+'\nДиагностика: '+JSON.stringify(j.diagnostics||[],null,2));render(j.results||[]);}).catch(function(e){setStatus('Ошибка: '+(e.message||e));}).finally(function(){search.disabled=false;});});
document.getElementById('health').addEventListener('click',function(){fetch('/api/health').then(function(r){return r.json();}).then(function(j){setStatus(JSON.stringify(j,null,2));}).catch(function(e){setStatus('Ошибка health: '+e.message);});});
document.getElementById('copy').addEventListener('click',function(){var text=last.map(function(r){return r.url;}).filter(Boolean).join('\n');navigator.clipboard.writeText(text||'');setStatus('Скопировано ссылок: '+last.length);});
document.getElementById('json').addEventListener('click',function(){var blob=new Blob([JSON.stringify(last,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='reverse-image-results.json';a.click();});
document.getElementById('clear').addEventListener('click',function(){last=[];results.innerHTML='';setStatus('Результаты очищены.');});
})();`;
  return new Response(js, { status: 200, headers: { ...cors, 'content-type': 'application/javascript; charset=utf-8' } });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes('*') || allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'Origin'
  };
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function cleanName(name) { return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80); }
function extensionByMime(type) { return type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'; }
function getDomain(value) { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } }
function normalizeUrl(value) { try { const u = new URL(value); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch { return String(value || '').trim(); } }

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
