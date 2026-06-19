/**
 * Reverse Image Finder — Cloudflare Worker
 * Version: v16-stable-buttons-upload
 */

const VERSION = 'v16-stable-buttons-upload';
const SEARCHAPI_ENDPOINT = 'https://www.searchapi.io/api/v1/search';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_STORE_BYTES = 6 * 1024 * 1024;
const TEMP_TTL_SECONDS = 30 * 60;

export default {
  async fetch(request, env) {
    const cors = getCors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return html(cors);
      if (request.method === 'GET' && url.pathname === '/app.js') return appJs(cors);
      if (request.method === 'GET' && url.pathname === '/api/health') return json(health(env), 200, cors);
      if (request.method === 'GET' && url.pathname.startsWith('/temp-image/')) return serveTempImage(url, env, cors);
      if (request.method === 'POST' && url.pathname === '/api/upload-test') return uploadTest(request, env, cors);
      if (request.method === 'POST' && url.pathname === '/api/search') return search(request, env, cors);
      return json({ ok: false, error: 'Unknown path: ' + url.pathname, version: VERSION }, 404, cors);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err), version: VERSION }, 500, cors);
    }
  }
};

function health(env) {
  return {
    ok: true,
    service: 'Reverse Image Finder Multi Engine SearchAPI Worker',
    version: VERSION,
    hasSearchApi: Boolean(env.SEARCHAPI_KEY),
    hasTempKv: Boolean(env.TEMP_IMAGES),
    tempStorage: 'Workers KV JSON base64',
    required: ['SEARCHAPI_KEY', 'TEMP_IMAGES'],
    engines: ['yandex_reverse_image', 'google_lens exact_matches', 'google_lens visual_matches', 'google_images fallback']
  };
}

function requireBindings(env, needSearch) {
  if (!env.TEMP_IMAGES) throw new Error('Не подключён KV binding TEMP_IMAGES.');
  if (needSearch && !env.SEARCHAPI_KEY) throw new Error('Не задан SEARCHAPI_KEY.');
}

async function uploadTest(request, env, cors) {
  requireBindings(env, false);
  const form = await request.formData();
  const saved = await saveUploadedImage(form, env, request.url);
  return json({ ok: true, version: VERSION, message: 'Загрузка работает', tempUrl: saved.imageUrl, fileInfo: saved.fileInfo }, 200, cors);
}

async function search(request, env, cors) {
  requireBindings(env, true);
  const form = await request.formData();
  const mode = String(form.get('mode') || 'max');
  const country = String(form.get('country') || 'ru');
  const saved = await saveUploadedImage(form, env, request.url);
  await sleep(3500);

  const diagnostics = [{ step: 'image_saved', imageUrl: saved.imageUrl, fileInfo: saved.fileInfo }];
  const collected = [];
  const related = new Set();
  const used = [];

  const yandex = await callSearchSafe(env, { engine: 'yandex_reverse_image', url: saved.imageUrl, country, num: '20' }, 'Yandex Reverse Image', diagnostics);
  if (yandex.ok) { used.push('Yandex Reverse Image'); collectYandex(yandex.data, collected, related); }

  if (mode === 'deep' || mode === 'max') {
    const exact = await callSearchSafe(env, { engine: 'google_lens', url: saved.imageUrl, type: 'exact_matches', country, hl: 'ru' }, 'Google Lens Exact', diagnostics);
    if (exact.ok) { used.push('Google Lens Exact'); collectGoogleLens(exact.data, collected, related, 'точное', 94, 'Google Lens Exact'); }

    const visual = await callSearchSafe(env, { engine: 'google_lens', url: saved.imageUrl, type: 'visual_matches', country, hl: 'ru' }, 'Google Lens Visual', diagnostics);
    if (visual.ok) { used.push('Google Lens Visual'); collectGoogleLens(visual.data, collected, related, 'похожее', 78, 'Google Lens Visual'); }
  }

  if (mode === 'max') {
    const queries = Array.from(related).filter(Boolean).slice(0, 3);
    for (const q of queries) {
      const g = await callSearchSafe(env, { engine: 'google_images', q, country, hl: 'ru', num: '10' }, 'Google Images: ' + q, diagnostics);
      if (g.ok) { used.push('Google Images'); collectGoogleImages(g.data, collected, q); }
    }
  }

  const results = dedupe(collected).slice(0, 80);
  diagnostics.push({ step: 'done', sourcesUsed: Array.from(new Set(used)), resultCount: results.length });
  return json({ ok: true, version: VERSION, mode, country, imageUrl: saved.imageUrl, fileInfo: saved.fileInfo, sourcesUsed: Array.from(new Set(used)), total: results.length, results, diagnostics }, 200, cors);
}

async function saveUploadedImage(form, env, requestUrl) {
  const file = form.get('image');
  if (!(file instanceof File)) throw new Error('Файл изображения не получен.');
  if (!file.size) throw new Error('Файл пустой или браузер не дал доступ к файлу.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Файл больше 10 МБ.');
  if (file.size > MAX_STORE_BYTES) throw new Error('Файл больше 6 МБ. Уменьши изображение и попробуй снова.');

  const name = String(file.name || 'image').toLowerCase();
  const browserType = String(file.type || '').toLowerCase();
  const type = detectMime(browserType, name);
  if (!type) throw new Error('Поддерживаются JPG, PNG и WEBP. HEIC/HEIF не поддерживается — сделай скриншот или сохрани как JPG. Тип: ' + (file.type || 'пусто') + ', имя: ' + (file.name || 'без имени'));

  const buf = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  const key = 'temp-' + crypto.randomUUID() + extFor(type);
  await env.TEMP_IMAGES.put(key, JSON.stringify({ b64, type, name: file.name || key, size: file.size, createdAt: Date.now() }), { expirationTtl: TEMP_TTL_SECONDS });
  return { imageUrl: new URL('/temp-image/' + encodeURIComponent(key), requestUrl).toString(), fileInfo: { name: file.name || '', browserType: file.type || '', type, size: file.size } };
}

function detectMime(browserType, name) {
  if (browserType === 'image/jpeg' || browserType === 'image/png' || browserType === 'image/webp') return browserType;
  if (/\.(jpg|jpeg)$/i.test(name)) return 'image/jpeg';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return '';
}
function extFor(type) { return type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'; }

async function serveTempImage(url, env, cors) {
  if (!env.TEMP_IMAGES) return new Response('TEMP_IMAGES is not configured', { status: 500, headers: cors });
  const key = decodeURIComponent(url.pathname.replace('/temp-image/', ''));
  const raw = await env.TEMP_IMAGES.get(key);
  if (!raw) return new Response('Not found', { status: 404, headers: cors });
  let meta;
  try { meta = JSON.parse(raw); } catch { return new Response('Bad temp object', { status: 500, headers: cors }); }
  const bytes = base64ToBytes(meta.b64 || '');
  return new Response(bytes, { status: 200, headers: { ...cors, 'content-type': meta.type || 'image/jpeg', 'content-length': String(bytes.byteLength), 'cache-control': 'public, max-age=120', 'content-disposition': 'inline' } });
}

async function callSearchSafe(env, params, label, diagnostics) {
  const delays = [0, 7000, 16000];
  let lastError = '';
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      const data = await callSearchApi(env, params);
      diagnostics.push({ step: 'source_ok', source: label, attempt: i + 1 });
      return { ok: true, data };
    } catch (e) {
      lastError = String((e && e.message) || e);
      diagnostics.push({ step: 'source_error', source: label, attempt: i + 1, error: lastError });
      const msg = lastError.toLowerCase();
      if (!msg.includes('image') && !msg.includes('url') && !msg.includes('404') && !msg.includes('fetch')) break;
    }
  }
  return { ok: false, error: lastError };
}

async function callSearchApi(env, params) {
  const u = new URL(SEARCHAPI_ENDPOINT);
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null && params[k] !== '') u.searchParams.set(k, String(params[k])); });
  const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + env.SEARCHAPI_KEY, Accept: 'application/json' } });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok || data.error) throw new Error(String(data.error || data.message || text.slice(0, 300) || ('HTTP ' + r.status)));
  return data;
}

function collectYandex(data, out, related) {
  arr(data.visual_matches).forEach(x => out.push(normalize(x, 'Yandex Reverse Image', x.exact_match ? 'точное' : 'похожее', x.exact_match ? 96 : 82)));
  arr(data.similar_images).forEach(x => out.push(normalize(x, 'Yandex Similar Images', 'похожее', 72)));
  arr(data.image_sizes).forEach(x => out.push(normalize(x, 'Yandex Image Sizes', 'точное', 92)));
  arr(data.related_searches).forEach(x => { const q = x.query || x.title || x.text; if (q) related.add(String(q)); });
}
function collectGoogleLens(data, out, related, type, score, source) {
  arr(data.exact_matches).forEach(x => out.push(normalize(x, source, 'точное', 96)));
  arr(data.visual_matches).forEach(x => out.push(normalize(x, source, type, score)));
  arr(data.related_content).forEach(x => { if (x.query) related.add(String(x.query)); out.push(normalize(x, source + ' Related', 'возможное', 55)); });
}
function collectGoogleImages(data, out, q) { arr(data.images).forEach(x => out.push(normalize(x, 'Google Images: ' + q, 'возможное', 50))); }
function normalize(x, source, matchType, score) {
  const url = x.link || x.url || x.source_link || x.page || x.serpapi_link || x.thumbnail || x.image || x.original || x.image_url || '';
  const preview = x.thumbnail || x.image || x.original || x.image_url || '';
  return { title: String(x.title || x.name || domain(url) || 'Найденное изображение'), url: String(url), domain: domain(url), preview: String(preview), similarity: score, matchType, source, description: String(x.snippet || x.description || x.content || '').slice(0, 300) };
}
function dedupe(items) {
  const m = new Map();
  items.forEach(x => { if (!x.url) return; const k = normUrl(x.url); const old = m.get(k); if (!old || x.similarity > old.similarity) m.set(k, x); });
  return Array.from(m.values()).sort((a, b) => b.similarity - a.similarity);
}

function html(cors) {
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reverse Image Finder</title><style>*{box-sizing:border-box}body{margin:0;background:#080b12;color:#eef4ff;font-family:system-ui,Segoe UI,Arial,sans-serif}.wrap{width:min(1100px,100%);margin:auto;padding:20px}.box{border:1px solid #263244;border-radius:24px;background:#101827;padding:22px}h1{margin:0 0 8px;font-size:clamp(28px,5vw,48px)}p{color:#b8c4d6}.grid{display:grid;grid-template-columns:1fr 320px;gap:14px}.panel{border:1px solid #263244;border-radius:18px;padding:14px;background:#0b1220}input,select,button{width:100%;border:1px solid #334155;border-radius:13px;padding:13px;background:#111c2e;color:white}button{cursor:pointer;font-weight:800;background:linear-gradient(135deg,#7c3aed,#2563eb)}button.secondary{background:#172337}.status{white-space:pre-wrap;overflow-wrap:anywhere;background:#050813;padding:14px;border-radius:16px;margin-top:14px;color:#c7d2e5}.preview{display:none;max-width:100%;max-height:340px;object-fit:contain;margin-top:12px;border-radius:14px;background:#050813}.actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:14px}.card{border:1px solid #263244;border-radius:16px;padding:12px;background:#0b1220;overflow:hidden}.card img{width:100%;height:160px;object-fit:cover;border-radius:12px}.small,.url{font-size:12px;color:#93c5fd;overflow-wrap:anywhere}@media(max-width:780px){.wrap{padding:10px}.grid,.actions{grid-template-columns:1fr}}</style></head><body><main class="wrap"><section class="box"><h1>AI Reverse Image Finder</h1><p>Поиск совпадений и похожих изображений через Yandex Reverse Image, Google Lens и Google Images.</p><div class="grid"><div class="panel"><label>Выбери изображение JPG / PNG / WEBP</label><input id="file" type="file" accept="image/*,.jpg,.jpeg,.png,.webp"><img id="preview" class="preview" alt="preview"><p id="fileInfo" class="small">Файл не выбран.</p></div><div class="panel"><label>Режим</label><select id="mode"><option value="fast">Быстрый</option><option value="deep">Глубокий</option><option value="max" selected>Максимум</option></select><label style="display:block;margin-top:10px">Регион</label><select id="country"><option value="ru" selected>Россия</option><option value="us">США</option><option value="de">Германия</option><option value="at">Австрия</option></select><button id="searchBtn" style="margin-top:10px">Найти изображение</button><button id="uploadBtn" class="secondary" style="margin-top:10px">Проверить загрузку</button><button id="healthBtn" class="secondary" style="margin-top:10px">Проверить настройки</button></div></div><div class="actions"><button id="copyBtn" class="secondary">Копировать ссылки</button><button id="jsonBtn" class="secondary">Экспорт JSON</button><button id="clearBtn" class="secondary">Очистить</button></div><div id="status" class="status">Готово. Выбери изображение.</div><div id="results" class="cards"></div></section></main><script src="/app.js?v=16"></script></body></html>`;
  return new Response(body, { headers: { ...cors, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function appJs(cors) {
  const js = String.raw`(function(){
var file=document.getElementById('file');
var preview=document.getElementById('preview');
var fileInfo=document.getElementById('fileInfo');
var status=document.getElementById('status');
var results=document.getElementById('results');
var mode=document.getElementById('mode');
var country=document.getElementById('country');
var last=[];
function say(t){status.textContent=t;}
function okFile(f){var n=(f.name||'').toLowerCase();var t=(f.type||'').toLowerCase();if(/\.(heic|heif)$/.test(n)||t.indexOf('heic')>=0||t.indexOf('heif')>=0)return 'HEIC/HEIF не поддерживается. Сохрани как JPG/PNG/WEBP или сделай скриншот.';if(/^image\/(jpeg|png|webp)$/.test(t)||/\.(jpg|jpeg|png|webp)$/.test(n))return '';return 'Нужен JPG, PNG или WEBP. Тип: '+(f.type||'пусто')+', имя: '+(f.name||'без имени');}
function selected(){return file.files&&file.files[0];}
file.addEventListener('change',function(){var f=selected();if(!f){fileInfo.textContent='Файл не выбран.';return;}fileInfo.textContent='Файл: '+(f.name||'без имени')+' | '+Math.round(f.size/1024)+' КБ | '+(f.type||'тип не указан');var e=okFile(f);if(e){say(e);return;}try{preview.src=URL.createObjectURL(f);preview.style.display='block';}catch(x){}say('Файл выбран. Можно запускать поиск.');});
function post(endpoint){var f=selected();if(!f){say('Сначала выбери изображение.');return;}var e=okFile(f);if(e){say(e);return;}if(f.size>10*1024*1024){say('Файл больше 10 МБ. Уменьши изображение.');return;}var fd=new FormData();fd.append('image',f,f.name||'image.jpg');fd.append('mode',mode.value);fd.append('country',country.value);say(endpoint==='/api/upload-test'?'Проверяю загрузку...':'Идёт поиск. Это может занять до минуты...');return fetch(endpoint,{method:'POST',body:fd}).then(function(r){return r.text().then(function(t){var j;try{j=JSON.parse(t);}catch(x){throw new Error('Ответ не JSON: '+t.slice(0,500));}if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));return j;});});}
function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function render(items){last=items||[];results.innerHTML='';if(!last.length){results.innerHTML='<div class="card"><h3>Ничего не найдено</h3><p>Попробуй другое изображение или режим Максимум.</p></div>';return;}last.forEach(function(r){var d=document.createElement('div');d.className='card';d.innerHTML=(r.preview?'<img src="'+esc(r.preview)+'" referrerpolicy="no-referrer" loading="lazy">':'')+'<h3>'+esc(r.title)+'</h3><div class="small">'+esc(r.source)+' · '+esc(r.matchType)+' · '+esc(r.similarity)+'%</div><div class="url">'+esc(r.url)+'</div><p>'+esc(r.description)+'</p><a href="'+esc(r.url)+'" target="_blank" rel="noopener"><button>Открыть</button></a>';results.appendChild(d);});}
document.getElementById('searchBtn').addEventListener('click',function(){post('/api/search').then(function(j){say('Готово. Найдено: '+j.total+'\nИсточники: '+(j.sourcesUsed||[]).join(', ')+'\nДиагностика: '+JSON.stringify(j.diagnostics||[],null,2));render(j.results||[]);}).catch(function(e){say('Ошибка: '+e.message);});});
document.getElementById('uploadBtn').addEventListener('click',function(){post('/api/upload-test').then(function(j){say('Загрузка работает. Временная ссылка:\n'+j.tempUrl+'\n\n'+JSON.stringify(j.fileInfo,null,2));}).catch(function(e){say('Ошибка загрузки: '+e.message);});});
document.getElementById('healthBtn').addEventListener('click',function(){fetch('/api/health').then(function(r){return r.json();}).then(function(j){say(JSON.stringify(j,null,2));}).catch(function(e){say('Ошибка health: '+e.message);});});
document.getElementById('copyBtn').addEventListener('click',function(){navigator.clipboard.writeText(last.map(function(x){return x.url;}).join('\n'));say('Скопировано: '+last.length);});
document.getElementById('jsonBtn').addEventListener('click',function(){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}));a.download='reverse-image-results.json';a.click();});
document.getElementById('clearBtn').addEventListener('click',function(){last=[];results.innerHTML='';say('Очищено.');});
})();`;
  return new Response(js, { headers: { ...cors, 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
}

function json(data, status, cors) { return new Response(JSON.stringify(data, null, 2), { status: status || 200, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function getCors(request, env) { const origin = request.headers.get('Origin') || '*'; const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()); const allow = allowed.includes('*') || allowed.includes(origin) ? origin : (allowed[0] || '*'); return { 'access-control-allow-origin': allow, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type, authorization', vary: 'Origin' }; }
function arr(v) { return Array.isArray(v) ? v : []; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function domain(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function normUrl(u) { try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return String(u || '').trim(); } }
function arrayBufferToBase64(buffer) { const bytes = new Uint8Array(buffer); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function base64ToBytes(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
