const fs = require('fs');

let s = fs.readFileSync('worker.js', 'utf8');

function rep(from, to) {
  if (!s.includes(from)) {
    console.error('Patch target not found:', from.slice(0, 140));
    process.exit(1);
  }
  s = s.replace(from, to);
}

rep("const VERSION = 'v14-github-multi-engine';", "const VERSION = 'v15-upload-compat';");
rep('<input id="file" type="file" accept="image/jpeg,image/png,image/webp">', '<input id="file" type="file" accept="image/*,.jpg,.jpeg,.png,.webp">');
rep('<script src="/app.js?v=14"></script>', '<script src="/app.js?v=15"></script>');

rep("if (request.method === 'POST' && url.pathname === '/api/search') {\n        return handleSearch(request, env, cors);\n      }", "if (request.method === 'POST' && url.pathname === '/api/upload-test') {\n        return handleUploadTest(request, env, cors);\n      }\n\n      if (request.method === 'POST' && url.pathname === '/api/search') {\n        return handleSearch(request, env, cors);\n      }");

rep("async function handleSearch(request, env, cors) {", "async function handleUploadTest(request, env, cors) {\n  requireEnv(env);\n\n  const form = await request.formData();\n  const file = form.get('image');\n\n  if (!(file instanceof File)) throw new Error('Файл изображения не получен.');\n  if (!file.size) throw new Error('Файл пустой или браузер не дал доступ к файлу.');\n  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Файл слишком большой. Максимум 10 МБ.');\n  if (file.size > MAX_SEND_BYTES) throw new Error('Файл слишком большой для временной публикации. Уменьши изображение до 5–6 МБ.');\n\n  const safeType = normalizeImageType(file.type, file.name);\n  if (!safeType) throw new Error('Нужен JPG, PNG или WEBP. Если это HEIC/HEIF — сохрани как JPG или сделай скриншот. Тип браузера: ' + (file.type || 'пусто') + ', имя: ' + (file.name || 'без имени'));\n\n  const buffer = await file.arrayBuffer();\n  const key = 'temp-' + crypto.randomUUID() + extensionByMime(safeType);\n  const b64 = arrayBufferToBase64(buffer);\n\n  await env.TEMP_IMAGES.put(key, JSON.stringify({\n    type: safeType,\n    name: cleanName(file.name || key),\n    size: file.size,\n    createdAt: Date.now(),\n    b64\n  }), { expirationTtl: TEMP_TTL_SECONDS });\n\n  const tempUrl = new URL('/temp-image/' + key, request.url).toString();\n  return json({ ok: true, version: VERSION, tempUrl, fileInfo: { name: file.name || '', browserType: file.type || '', detectedType: safeType, size: file.size } }, 200, cors);\n}\n\nasync function handleSearch(request, env, cors) {");

rep("if (!ALLOWED_MIME.has(file.type)) throw new Error('Поддерживаются только JPG, PNG и WEBP.');", "const safeType = normalizeImageType(file.type, file.name);\n  if (!safeType) throw new Error('Нужен JPG, PNG или WEBP. Если это HEIC/HEIF — сохрани как JPG или сделай скриншот. Тип браузера: ' + (file.type || 'пусто') + ', имя: ' + (file.name || 'без имени'));");
rep("const key = 'temp-' + crypto.randomUUID() + extensionByMime(file.type);", "const key = 'temp-' + crypto.randomUUID() + extensionByMime(safeType);");
rep("type: file.type,", "type: safeType,");
rep("const diagnostics = [{ step: 'temp_url_created', imageUrl, size: file.size, type: file.type }];", "const diagnostics = [{ step: 'temp_url_created', imageUrl, size: file.size, type: safeType, browserType: file.type || '', name: file.name || '' }];");

rep("function extensionByMime(type) { return type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'; }", "function normalizeImageType(type, name) {\n  const t = String(type || '').toLowerCase();\n  const n = String(name || '').toLowerCase();\n  if (ALLOWED_MIME.has(t)) return t;\n  if (/\\.(jpg|jpeg)$/i.test(n)) return 'image/jpeg';\n  if (/\\.png$/i.test(n)) return 'image/png';\n  if (/\\.webp$/i.test(n)) return 'image/webp';\n  return '';\n}\nfunction extensionByMime(type) { return type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'; }");

rep("var file=document.getElementById('file'), preview=document.getElementById('preview'), search=document.getElementById('search'), status=document.getElementById('status'), results=document.getElementById('results');", "var file=document.getElementById('file'), preview=document.getElementById('preview'), search=document.getElementById('search'), uploadTest=document.getElementById('uploadTest'), status=document.getElementById('status'), results=document.getElementById('results');");
rep("if(!/^image\\/(jpeg|png|webp)$/.test(f.type)){setStatus('Неверный формат. Нужен JPG, PNG или WEBP.');file.value='';return;}", "var fileOk=/^image\\/(jpeg|png|webp)$/.test(f.type)||/\\.(jpg|jpeg|png|webp)$/i.test(f.name||'');if(!fileOk){setStatus('Неверный формат. Нужен JPG, PNG или WEBP. Если это HEIC/HEIF — сделай скриншот или сохрани как JPG. Тип: '+(f.type||'пусто'));file.value='';return;}");
rep("<button id=\"health\" class=\"btn2\" style=\"margin-top:10px\">Проверить настройки</button>", "<button id=\"uploadTest\" class=\"btn2\" style=\"margin-top:10px\">Проверить только загрузку</button><button id=\"health\" class=\"btn2\" style=\"margin-top:10px\">Проверить настройки</button>");
rep("document.getElementById('health').addEventListener('click',function(){fetch('/api/health').then(function(r){return r.json();}).then(function(j){setStatus(JSON.stringify(j,null,2));}).catch(function(e){setStatus('Ошибка health: '+e.message);});});", "uploadTest.addEventListener('click',function(){var f=file.files&&file.files[0];if(!f){setStatus('Сначала выбери изображение.');return;}var fd=new FormData();fd.append('image',f,f.name||'image.jpg');uploadTest.disabled=true;setStatus('Проверяю загрузку во временное хранилище...');fetch('/api/upload-test',{method:'POST',body:fd}).then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));return j;});}).then(function(j){setStatus('Загрузка работает. Временная ссылка:\\n'+j.tempUrl+'\\n\\nФайл:\\n'+JSON.stringify(j.fileInfo,null,2));window.open(j.tempUrl,'_blank');}).catch(function(e){setStatus('Ошибка загрузки: '+e.message);}).finally(function(){uploadTest.disabled=false;});});\ndocument.getElementById('health').addEventListener('click',function(){fetch('/api/health').then(function(r){return r.json();}).then(function(j){setStatus(JSON.stringify(j,null,2));}).catch(function(e){setStatus('Ошибка health: '+e.message);});});");

fs.writeFileSync('worker.js', s);
console.log('upload compatibility patch applied');
