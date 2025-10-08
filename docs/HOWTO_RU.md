# HOWTO (RU)

## Сборка

```
npm install
npm run build
```

- Откройте: `public/index.html` (главная), `public/sessions.html` (сессии), `public/alt.html` (отладка)

## Главная (index)
- Запись экрана → по завершении: индексация → ремакс (StreamSource → файл)
- Обработка существующей сессии: выбор в списке → “Собрать выбранную в файл”
- Прогресс: отдельная полоса “Индексация”, затем “Чтение (байты)”

## Сессии (sessions)
- Назначение: работать с уже записанными сессиями
- Режимы:
  - “Сохранить в файл” (FS API)
  - “Скачать как файл” (Blob)
  - “Скачать по частям (≈ N ГБ)” — целевая величина части в МБ
- Прогрессы: 1) Индексация → 2) Чтение (байты) → 3) Прогресс библиотеки → 4) Финализация; показывается итоговое время.
- Рекомендация: при “по частям” ставить 2048–4096 МБ, чтобы уменьшить оверхед.

## Отладка (alt)
- Проверка потоков (StreamSource/ReadableStreamSource), запись в файл (с обёрткой WritableStream), паддинг

## Сервис (remuxService)
- Подключение (ES‑модуль):

```
<script src="./mediabunny.umd.js"></script>
<script type="module">
  import { listSessionsSorted, remuxSessionToFile } from './services/remuxService.js';
  const sessions = await listSessionsSorted();
  // ...
</script>
```

- Прогрессы:
  - onIndexProgress: 0..1 — индексация sizes/prefix
  - onByteProgress: 0..1 — прогресс по байтам (двигается сразу)
  - onProgress: 0..1 — прогресс библиотеки (может стартовать позже)

