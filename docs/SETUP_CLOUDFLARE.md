# Настройка Cloudflare Worker

## 1. Создать Worker

1. Открой Cloudflare Dashboard.
2. Перейди в **Workers & Pages**.
3. Нажми **Create application**.
4. Выбери **Worker**.
5. Назови Worker, например `ai-reverse-image-finder`.
6. Нажми **Edit code**.
7. Удали старый код и вставь код из `worker.js`.
8. Нажми **Deploy**.

## 2. Добавить SearchAPI ключ

Открой:

```text
Worker → Settings → Variables and Secrets → Add
```

Добавь:

```text
Type: Secret
Variable name: SEARCHAPI_KEY
Value: твой ключ SearchAPI.io
```

## 3. Добавить CORS

В том же разделе добавь обычную переменную:

```text
Type: Text
Variable name: ALLOWED_ORIGINS
Value: *
```

## 4. Создать KV namespace

1. В Cloudflare открой **Workers KV**.
2. Нажми **Create namespace**.
3. Назови namespace, например:

```text
reverse-image-temp-kv
```

## 5. Подключить KV к Worker

Открой:

```text
Worker → Settings → Bindings → Add
```

Выбери **KV namespace**.

Заполни:

```text
Variable name: TEMP_IMAGES
KV namespace: reverse-image-temp-kv
```

Нажми **Save** и потом **Deploy**.

## 6. Проверка

Открой:

```text
https://адрес-твоего-worker.workers.dev/api/health
```

Должно быть:

```json
{
  "ok": true,
  "hasSearchApi": true,
  "hasTempKv": true
}
```

## 7. Запуск

Открой главную страницу Worker:

```text
https://адрес-твоего-worker.workers.dev/
```

Загрузи изображение и запусти поиск.
