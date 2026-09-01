# 🎯 Steam Account Cleanup System - Полный Overview

## 📦 Что создано

### Ядро (Core)
| Файл | Размер | Назначение |
|------|--------|-----------|
| `steam/accountRecoverer.js` | 500+ строк | Основной класс для смены пароля и деавторизации |
| `steam/cleanupRetry.js` | 350+ строк | Retry механика с exponential backoff |
| `steam/cleanupRetryWorker.js` | 50+ строк | Periodic worker для обработки retry |

### Интеграция
| Файл | Назначение |
|------|-----------|
| `rentals/steamCleanup.js` | Обертка для работы с БД |
| `docs/STEAM_RECOVERY_INTEGRATION_EXAMPLES.js` | Примеры использования + Telegram команды |

### Документация
| Файл | Содержание |
|------|-----------|
| `STEAM_RECOVERY_QUICK_START.md` | Быстрый старт (5 мин) |
| `docs/STEAM_ACCOUNT_RECOVERY.md` | Полная документация |
| `docs/CLEANUP_RETRY_QUICKSTART.md` | Retry механика (эта папка) |
| `test/accountRecoverer.test.js` | Unit тесты |

## 🚀 Быстрый Setup (15 минут)

### Шаг 1: Миграция БД
```javascript
// В любом скрипте миграции:
import { CLEANUP_RETRY_SCHEMA } from './steam/cleanupRetry.js';
await db.query(CLEANUP_RETRY_SCHEMA);
```

### Шаг 2: Запустить worker
```javascript
// В bootstrap.js:
import { startCleanupRetryWorker } from './steam/cleanupRetryWorker.js';
const stopWorker = startCleanupRetryWorker(console, 60000);
```

### Шаг 3: Использовать в cleanup
```javascript
import { SteamAccountRecoverer } from './steam/accountRecoverer.js';
import { scheduleCleanupRetry } from './steam/cleanupRetry.js';

try {
    const recoverer = new SteamAccountRecoverer({...});
    await recoverer.executeRecovery();
} catch (error) {
    await scheduleCleanupRetry(rentalId, error.message);
}
```

## 📊 Архитектура

```
Rental Expires
     ↓
processRentalExpiryWithCleanup()
     ↓
SteamAccountRecoverer.executeRecovery()  
     ├─ Get RSA Key
     ├─ Init Wizard
     ├─ Request 2FA
     ├─ Confirm 2FA
     ├─ Verify Old Password
     ├─ Set New Password
     └─ Deauthorize Devices
     ↓
Success? → cleanup_status = 'success' ✓
     ↓
Fail? → scheduleCleanupRetry()
     ↓
cleanupRetryWorker (checks every minute)
     ├─ Find pending retries
     ├─ Execute cleanup again
     ├─ Update cleanup_status
     └─ Schedule next retry if fail
```

## 💾 БД Schema

### Новые колонки в `rentals` table:
```sql
cleanup_status             VARCHAR(50)    -- success | scheduled_retry | failed_permanent
cleanup_failed_count       INTEGER        -- Количество попыток
cleanup_last_error         TEXT           -- Последняя ошибка
cleanup_next_retry_at      TIMESTAMP      -- Когда следующая попытка
cleanup_completed_at       TIMESTAMP      -- Финальный результат
```

### Новая таблица `cleanup_retry_logs`:
```sql
id                 SERIAL PRIMARY KEY
rental_id          INTEGER (FK rentals)
attempt            INTEGER              -- Номер попытки
error_message      TEXT                 -- Что пошло не так
scheduled_for      TIMESTAMP            -- На когда запланирована
delay_ms           INTEGER              -- Задержка перед попыткой
created_at         TIMESTAMP            -- Когда логировалось
```

## 🔄 Retry Логика

| Попытка | Задержка | Время до retry |
|---------|----------|---|
| 1 | ~5 сек | 5s |
| 2 | ~10 сек | 10s |
| 3 | ~20 сек | 20s |
| 4 | ~40 сек | 40s |
| 5 | ~80 сек | 80s |
| После 5 | ❌ fail permanent | |

**Plus:** ±10% рандомности к каждой задержке + 24-часовое окно retry

## 📱 Telegram Команды

```
/cleanup_status <rental_id>    — Посмотреть статус cleanup
/cleanup_retry <rental_id>     — Вручную запустить retry (admin)
/cleanup_stats                 — Статистика по всем cleanup
```

## 🧪 Тестирование

### Unit тесты
```bash
npm test test/accountRecoverer.test.js
```

### Интеграционный тест
```javascript
// Создать rental с истекшей датой
// Запустить processRentalExpiryWithCleanup()
// Проверить cleanup_status в БД
// Подождать и проверить retry
```

## 📈 Мониторинг

### Проверить статистику
```javascript
const stats = await getCleanupStats();
console.log(`✅ Success: ${stats.successful}`);
console.log(`⏳ Pending: ${stats.pending_retry}`);
console.log(`❌ Failed: ${stats.failed_permanent}`);
```

### Alerting (опционально)
```javascript
// Если много failed_permanent — отправить алерт админу
if (stats.failed_permanent > 5) {
    await bot.telegram.sendMessage(ADMIN_ID, 
        '⚠️ ' + stats.failed_permanent + ' cleanups failed permanently');
}
```

## ⚙️ Конфигурация

Все в `steam/cleanupRetry.js`:

```javascript
export const RETRY_CONFIG = {
    MAX_RETRIES: 5,              // Макс попыток
    INITIAL_DELAY_MS: 5000,      // Первая задержка
    MAX_DELAY_MS: 3600000,       // Макс задержка (1 час)
    BACKOFF_MULTIPLIER: 2,       // Экспоненциальный множитель
    JITTER_FACTOR: 0.1,          // ±% рандомности
    RETRY_WINDOW_HOURS: 24,      // Окно для retry
};
```

## 🔐 Безопасность

- ✅ Пароли шифруются RSA перед отправкой
- ✅ Старые пароли удаляются после первой попытки
- ✅ 2FA коды не логируются
- ✅ Session cookies зашифрованы в БД
- ✅ Retry логи содержат только текст ошибок, не данные
- ✅ Admin-only команды для manual retry

## ⚠️ Важно

1. **Worker обязателен** — без него retry не запустятся!
2. **Миграция обязательна** — нужны новые колонки в БД
3. **Проверьте env vars** — `STEAM_SESSION_LOGOUT_ENABLED` и `STEAM_PASSWORD_CHANGE_ENABLED` должны быть `true`
4. **Тестируйте** — запустите на одном rental перед production
5. **Мониторьте** — следите за failed_permanent cleanups

## 🐛 Troubleshooting

| Проблема | Решение |
|----------|---------|
| Retry не запускаются | Проверить: worker запущен? cleanup_status правильно? |
| Всегда падает на шаге 5 | Password неправильный или cookies истекли |
| БД таблица растет | Нормально — это логирование; архивируйте старое |
| Worker занимает много CPU | Увеличить intervalMs (60000ms = 1 мин) |

## 📚 Документация

Читайте в порядке:
1. **Начните здесь** → `STEAM_RECOVERY_QUICK_START.md` (5 мин)
2. **Retry система** → `docs/CLEANUP_RETRY_QUICKSTART.md` (5 мин)
3. **Полная инфо** → `docs/STEAM_ACCOUNT_RECOVERY.md` (30 мин)
4. **Примеры кода** → `docs/STEAM_RECOVERY_INTEGRATION_EXAMPLES.js` (10 мин)
5. **Исходник** → `steam/accountRecoverer.js`, `steam/cleanupRetry.js`

## ✅ Checklist перед Production

- [ ] Запущена миграция БД (`CLEANUP_RETRY_SCHEMA`)
- [ ] Worker инициализирован в bootstrap.js
- [ ] Обновлены обработчики ошибок cleanup (используют scheduleCleanupRetry)
- [ ] Протестировано с одним rental вручную
- [ ] Telegram команды добавлены (/cleanup_status, /cleanup_stats)
- [ ] Настроен мониторинг (алерты при failed_permanent)
- [ ] Документация прочитана командой
- [ ] Backups настроены (БД с новыми таблицами)

## 📞 Support

Если что-то не работает:
1. Проверьте логи worker → `[Cleanup Retry Worker]`
2. Посмотрите cleanup_retry_logs в БД
3. Используйте `/cleanup_status <rental_id>` в Telegram
4. Проверьте environment variables
5. Прочитайте troubleshooting в docs

## 📋 Summary

**Создано:**
- ✅ 3 основных компонента (accountRecoverer, cleanupRetry, worker)
- ✅ Retry с exponential backoff (5 попыток)
- ✅ Периодический worker (проверяет каждую минуту)
- ✅ Полная документация
- ✅ Примеры интеграции
- ✅ Unit тесты
- ✅ Telegram команды

**Готово к:**
- ✅ Production deployment
- ✅ Масштабированию
- ✅ Мониторингу
- ✅ Кастомизации

**Время Setup:** ~15-30 минут
**Время интеграции:** ~1-2 часа  
**ROI:** Минимизирует ручные вмешательства в failed cleanups
