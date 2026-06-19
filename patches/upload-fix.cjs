const fs = require('fs');

let s = fs.readFileSync('worker.js', 'utf8');

function replaceExact(from, to) {
  if (!s.includes(from)) {
    console.error('Patch target not found:', from);
    process.exit(1);
  }
  s = s.replace(from, to);
}

replaceExact("const VERSION = 'v14-github-multi-engine';", "const VERSION = 'v15-simple-upload-fix';");
replaceExact('<input id="file" type="file" accept="image/jpeg,image/png,image/webp">', '<input id="file" type="file" accept="image/*,.jpg,.jpeg,.png,.webp">');
replaceExact('<script src="/app.js?v=14"></script>', '<script src="/app.js?v=15"></script>');

replaceExact(
  "if (!ALLOWED_MIME.has(file.type)) throw new Error('Поддерживаются только JPG, PNG и WEBP.');",
  "const uploadMime = String(file.type || '').toLowerCase();\n  const uploadName = String(file.name || '').toLowerCase();\n  const uploadTypeOk = ALLOWED_MIME.has(uploadMime) || /\\.(jpg|jpeg|png|webp)$/i.test(uploadName);\n  if (!uploadTypeOk) throw new Error('Поддерживаются только JPG, PNG и WEBP. Если это HEIC/HEIF — сохрани как JPG или сделай скриншот. Тип браузера: ' + (file.type || 'пусто') + ', имя: ' + (file.name || 'без имени'));"
);

replaceExact(
  "const key = 'temp-' + crypto.randomUUID() + extensionByMime(file.type);",
  "const effectiveType = ALLOWED_MIME.has(uploadMime) ? uploadMime : (uploadName.endsWith('.png') ? 'image/png' : uploadName.endsWith('.webp') ? 'image/webp' : 'image/jpeg');\n  const key = 'temp-' + crypto.randomUUID() + extensionByMime(effectiveType);"
);

replaceExact("type: file.type,", "type: effectiveType,");
replaceExact("const diagnostics = [{ step: 'temp_url_created', imageUrl, size: file.size, type: file.type }];", "const diagnostics = [{ step: 'temp_url_created', imageUrl, size: file.size, type: effectiveType, browserType: file.type || '', name: file.name || '' }];");

replaceExact(
  "if(!/^image\\/(jpeg|png|webp)$/.test(f.type)){setStatus('Неверный формат. Нужен JPG, PNG или WEBP.');file.value='';return;}",
  "var okType=/^image\\/(jpeg|png|webp)$/.test(f.type)||/\\.(jpg|jpeg|png|webp)$/i.test(f.name||'');if(!okType){setStatus('Неверный формат. Нужен JPG, PNG или WEBP. Если это HEIC/HEIF — сохрани как JPG или сделай скриншот. Тип: '+(f.type||'пусто'));file.value='';return;}"
);

fs.writeFileSync('worker.js', s);
console.log('simple upload compatibility patch applied');
