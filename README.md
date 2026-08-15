# GambitRP — сайт заявок

Статическая страница с двумя формами: возврат привилегии и «не пришёл донат».
Заявка сохраняется в Supabase и прилетает в Telegram. План и решения — в [PLAN.md](PLAN.md).

```
index.html  styles.css  app.js   фронт
validators.js                    правила валидации, общие для фронта и бэка
api/submit.js                    приём заявки (Vercel Edge Function)
supabase.sql                     таблица и bucket, выполнить один раз
```

## Запуск

```bash
npm test
```

Локально страницу удобно смотреть через `python -m http.server 8123`
(формы будут ругаться на отсутствующий `/api/submit` — это нормально,
для полной проверки нужен `vercel dev`).

## Развёртывание

1. Выполнить [supabase.sql](supabase.sql) в Supabase → SQL Editor.
2. Импортировать репозиторий в Vercel (framework preset: **Other**, build command пустой).
3. Заполнить переменные окружения из [.env.example](.env.example) в настройках проекта Vercel.
4. Deploy.

## Как работать с заявками

Supabase → Table Editor → `requests`. Это и есть админка: фильтр по `status`,
правка статуса (`new` → `in_progress` → `done` / `rejected`), заметки в `admin_note`.
Ответ игроку — в Discord, ник берётся из заявки.
