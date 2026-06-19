# Автоматический деплой GitHub → Cloudflare Worker

После этой настройки каждый push в ветку `main`, который меняет `worker.js`, будет автоматически публиковать программу в Cloudflare Worker.

## 1. Что уже добавлено в репозиторий

Файл workflow:

```text
.github/workflows/deploy.yml
```

Он использует официальный Cloudflare Wrangler Action:

```text
cloudflare/wrangler-action@v3
```

## 2. Какие GitHub Secrets нужно добавить

Открой репозиторий GitHub:

```text
Settings → Secrets and variables → Actions → New repository secret
```

Добавь 4 секрета:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_KV_NAMESPACE_ID
SEARCHAPI_KEY
```

## 3. Где взять `CLOUDFLARE_ACCOUNT_ID`

В Cloudflare Dashboard открой свой аккаунт. Account ID обычно виден в правой боковой панели на странице Overview аккаунта или Worker.

Скопируй его и добавь в GitHub Secret:

```text
CLOUDFLARE_ACCOUNT_ID
```

## 4. Где взять `CLOUDFLARE_KV_NAMESPACE_ID`

В Cloudflare открой:

```text
Workers & Pages → KV
```

Открой namespace, который используется для временных изображений, например:

```text
reverse-image-temp-kv
```

Скопируй его ID и добавь в GitHub Secret:

```text
CLOUDFLARE_KV_NAMESPACE_ID
```

Важно: binding в Worker должен называться именно:

```text
TEMP_IMAGES
```

## 5. Где взять `CLOUDFLARE_API_TOKEN`

В Cloudflare открой:

```text
My Profile → API Tokens → Create Token
```

Нужен токен, который может деплоить Worker и работать с Workers KV.

Минимально нужны права примерно такого типа:

```text
Account → Workers Scripts → Edit
Account → Workers KV Storage → Edit
Account → Account Settings → Read
```

Если Cloudflare не даёт выбрать такие точные права, используй шаблон для Workers deploy или custom token с правами на Workers.

После создания токен показывается только один раз. Сразу скопируй его и добавь в GitHub Secret:

```text
CLOUDFLARE_API_TOKEN
```

## 6. Где взять `SEARCHAPI_KEY`

Это твой ключ SearchAPI.io. Добавь его в GitHub Secret:

```text
SEARCHAPI_KEY
```

Workflow передаст его в Cloudflare Worker как Worker Secret.

## 7. Как запустить деплой вручную

Открой GitHub:

```text
Actions → Deploy Cloudflare Worker → Run workflow
```

Выбери ветку `main` и нажми запуск.

## 8. Как проверить после деплоя

Открой:

```text
https://твой-worker.workers.dev/api/health
```

Должно быть:

```json
{
  "ok": true,
  "hasSearchApi": true,
  "hasTempKv": true
}
```

## 9. Важно

Секреты не нужно добавлять в код. Не записывай API ключи в `worker.js`, `README.md` или `wrangler.toml.example`.
