# Reverse Image Finder

Веб‑программа для поиска сайтов, страниц и источников, где встречается загруженное изображение или визуально похожие изображения.

Проект рассчитан на запуск как **Cloudflare Worker**. GitHub хранит код, а рабочая программа с backend запускается в Cloudflare Worker, чтобы API‑ключи не попадали в браузер.

## Что подключено

Текущая версия использует один основной ключ `SEARCHAPI_KEY` и несколько движков SearchAPI:

- **Yandex Reverse Image** — основной поиск копий и похожих изображений.
- **Google Lens Exact Matches** — точные совпадения.
- **Google Lens Visual Matches** — визуально похожие совпадения.
- **Google Images Text Fallback** — дополнительный поиск по связанным текстовым запросам.

## Режимы поиска

- **Быстрый** — Yandex Reverse Image.
- **Глубокий** — Yandex + Google Lens exact/visual.
- **Максимум** — все доступные источники + fallback Google Images.

## Файлы

```text
worker.js                              # основной Cloudflare Worker: frontend + backend
.github/workflows/deploy.yml           # автоматический деплой GitHub → Cloudflare
wrangler.toml.example                  # пример конфигурации Wrangler
index.html                             # простая страница для GitHub Pages
docs/SETUP_CLOUDFLARE.md               # пошаговая настройка Cloudflare
docs/AUTO_DEPLOY_GITHUB_ACTIONS.md     # настройка автоматического деплоя
docs/SEARCH_ENGINES.md                 # список поисковых источников
docs/TROUBLESHOOTING.md                # ошибки и решения
```

## Минимальные настройки Cloudflare

### Variables and Secrets

```text
SEARCHAPI_KEY = твой ключ SearchAPI.io
ALLOWED_ORIGINS = *
```

### KV binding

```text
TEMP_IMAGES = твой Workers KV namespace
```

`TEMP_IMAGES` используется для временной публикации загруженного изображения по адресу `/temp-image/...`, потому что reverse image API требуют публичный URL изображения.

## Установка через Cloudflare Dashboard

1. Открой Cloudflare Dashboard.
2. Перейди в **Workers & Pages**.
3. Создай Worker или открой существующий.
4. Нажми **Edit code**.
5. Удали старый код.
6. Вставь код из `worker.js`.
7. В **Settings → Variables and Secrets** добавь `SEARCHAPI_KEY`.
8. В **Workers KV** создай namespace, например `reverse-image-temp-kv`.
9. В **Settings → Bindings** добавь KV binding:

```text
Variable name: TEMP_IMAGES
KV namespace: reverse-image-temp-kv
```

10. Нажми **Deploy**.
11. Открой Worker по адресу `https://...workers.dev/`.

## Автоматический деплой

В репозиторий добавлен GitHub Actions workflow:

```text
.github/workflows/deploy.yml
```

Для работы нужно добавить GitHub Secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_KV_NAMESPACE_ID
SEARCHAPI_KEY
```

Подробная инструкция: `docs/AUTO_DEPLOY_GITHUB_ACTIONS.md`.

## Почему не GitHub Pages

GitHub Pages — статический хостинг. Он не может безопасно хранить API‑ключи и выполнять backend‑код. Поэтому GitHub Pages может быть только страницей проекта, а рабочая программа должна запускаться в Cloudflare Worker.

## Безопасность

- API‑ключи не должны попадать в frontend.
- Ключи хранятся только в Cloudflare Worker `Variables and Secrets`.
- Загруженные изображения хранятся временно в KV.
- Программа не обходит CAPTCHA, авторизацию или запреты сайтов.

## Текущая версия

`v14-github-multi-engine`, основана на стабильной адаптивной версии v13.
