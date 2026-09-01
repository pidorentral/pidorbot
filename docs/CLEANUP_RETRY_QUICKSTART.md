# Cleanup Retry Механика - Краткий Старт

## Что это?

Автоматические повторения неудачных cleanup операций с экспоненциальной задержкой.

**Логика:**
- 1-я попытка: +5 сек
- 2-я попытка: +10 сек  
- 3-я попытка: +20 сек
- 4-я попытка: +40 сек
- 5-я попытка: +80 сек
- После 5 попыток — перманентный fail

## Setup (3 шага)

### 1. Запустить миграцию БД

```javascript
import { CLEANUP_RETRY_SCHEMA } from './steam/cleanupRetry.js';

// В вашем скрипте миграции:
await db.query(CLEANUP_RETRY_SCHEMA);
```

### 2. Запустить worker в bootstrap.js

```javascript
import { startCleanupRetryWorker } from './steam/cleanupRetryWorker.js';

// При старте бота:
const stopWorker = startCleanupRetryWorker(console, 60000); // Check every minute

// При остановке:
process.on('SIGTERM', () => {
    stopWorker();
    process.exit(0);
});
```

### 3. Обновить обработчик ошибок cleanup

```javascript
import { scheduleCleanupRetry } from './steam/cleanupRetry.js';

try {
    const result = await processRentalExpiryWithCleanup(rentalId);
} catch (error) {
    // Автоматически запланировать retry
    const retry = await scheduleCleanupRetry(rentalId, error.message);
    console.log(`Scheduled retry: ${retry.nextRetryAt}`);
}
```

## Как это работает

### Когда cleanup падает:

```
1️⃣ Ошибка при cleanup
   ↓
2️⃣ Сохранить в БД: cleanup_status = 'scheduled_retry'
   ↓
3️⃣ Рассчитать delay (экспоненциальный backoff)
   ↓
4️⃣ Установить cleanup_next_retry_at = NOW() + delay
   ↓
5️⃣ Worker каждую минуту проверяет rentals готовые к retry
   ↓
6️⃣ Запустить cleanup снова
   ↓
7️⃣ Если успех → cleanup_status = 'success'
   ↓
8️⃣ Если fail → повторить (шаг 2-7)
```

## API

### scheduleCleanupRetry(rentalId, errorMessage)
```javascript
const result = await scheduleCleanupRetry(123, 'Network timeout');
// → { 
//     rentalId: 123,
//     scheduled: true,
//     attempt: 2,
//     nextRetryAt: '2026-09-01T10:35:00.000Z',
//     delayMs: 10000
//   }
```

### processPendingCleanupRetries(logger)
```javascript
const stats = await processPendingCleanupRetries(console);
// → { processedCount: 3, successCount: 2, failedCount: 1 }
```

### getCleanupRetryHistory(rentalId)
```javascript
const history = await getCleanupRetryHistory(123);
// → [
//   { attempt: 1, error_message: '...', scheduled_for: '...', delay_ms: 5000 },
//   { attempt: 2, error_message: '...', scheduled_for: '...', delay_ms: 10000 }
// ]
```

### getCleanupStats()
```javascript
const stats = await getCleanupStats();
// → { 
//     successful: 45,
//     pending_retry: 3,
//     failed_permanent: 2,
//     avg_attempts: 1.5,
//     max_attempts: 5
//   }
```

### resetCleanupRetry(rentalId)
```javascript
// Админская команда для повторного запуска cleanup
await resetCleanupRetry(123);
```

## Telegram команды

### Статус cleanup

```javascript
// Add handler to bot:
bot.command('cleanup_status', (ctx) => {
    const rentalId = ctx.message.text.split(' ')[1];
    handleCleanupStatusCommand(ctx, rentalId);
});

// Usage: /cleanup_status 123
// Output:
// ⏳ Cleanup Status for Rental #123
// Account: username
// Status: scheduled_retry
// Attempts: 2
// Next Retry: in 8s
```

### Вручную запустить retry

```javascript
bot.command('cleanup_retry', async (ctx) => {
    const rentalId = parseInt(ctx.message.text.split(' ')[1]);
    
    if (!process.env.TG_ADMIN_IDS?.includes(String(ctx.from.id))) {
        await ctx.reply('❌ Admin only');
        return;
    }

    try {
        const result = await resetCleanupRetry(rentalId);
        await ctx.reply(`✓ Cleanup retry reset for rental ${rentalId}`);
    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Usage: /cleanup_retry 123
```

## Мониторинг

### Проверить pending retries
```javascript
const stats = await getCleanupStats();
console.log(`Pending retries: ${stats.pending_retry}`);
console.log(`Failed permanently: ${stats.failed_permanent}`);
```

### Логирование в консоль
```javascript
// Worker логирует каждый retry:
[Cleanup Retry Worker] Processing retry #2 for rental 123 (username)
✓ Cleanup retry succeeded for rental 123
✗ Cleanup retry failed for rental 124: Old password verification failed
```

## База данных - Что хранится

### rentals table (новые колонки)
```sql
cleanup_status              -- 'success', 'scheduled_retry', 'failed_permanent'
cleanup_failed_count        -- Количество попыток
cleanup_last_error          -- Последняя ошибка
cleanup_next_retry_at       -- Когда следующая попытка
cleanup_completed_at        -- Когда завершилось (успех/финальный fail)
```

### cleanup_retry_logs table
```sql
rental_id                   -- Какой rental
attempt                     -- Номер попытки (1, 2, 3...)
error_message               -- Текст ошибки
scheduled_for               -- На когда запланирована
delay_ms                    -- Задержка перед этой попыткой
created_at                  -- Когда логировалось
```

## Примеры

### 1. Интеграция в существующий cleanup

```javascript
// В processRentalExpiryWithCleanup():

try {
    const result = await recoverer.executeRecovery();
    // Success — обновить статус
    await db.query(`UPDATE rentals SET cleanup_status = 'success' WHERE id = $1`, [rentalId]);
} catch (error) {
    // Fail — запланировать retry
    const retry = await scheduleCleanupRetry(rentalId, error.message);
    console.log(`Will retry at ${retry.nextRetryAt}`);
}
```

### 2. Запустить worker

```javascript
// bootstrap.js:
import { startCleanupRetryWorker } from './steam/cleanupRetryWorker.js';

const stopWorker = startCleanupRetryWorker(logger, 60000);
console.log('✓ Cleanup retry worker running');
```

### 3. Проверить статус в админке

```javascript
bot.command('cleanup_stats', async (ctx) => {
    const stats = await getCleanupStats();
    
    const message = `📊 Cleanup Statistics
    
✅ Successful: ${stats.successful}
⏳ Pending: ${stats.pending_retry}  
❌ Failed: ${stats.failed_permanent}
📈 Avg attempts: ${stats.avg_attempts?.toFixed(1) || 0}`;
    
    await ctx.reply(message);
});
```

## Конфигурация

Все настройки в `steam/cleanupRetry.js`:

```javascript
export const RETRY_CONFIG = {
    MAX_RETRIES: 5,              // ← Макс попыток
    INITIAL_DELAY_MS: 5000,      // ← Первая задержка
    MAX_DELAY_MS: 3600000,       // ← Макс задержка (1 час)
    BACKOFF_MULTIPLIER: 2,       // ← Каждый раз умножать на 2
    JITTER_FACTOR: 0.1,          // ← ±10% рандомность
    RETRY_WINDOW_HOURS: 24,      // ← Retry только в течение 24ч после конца аренды
};
```

Менять по нужде — например, если Steam часто блокирует:

```javascript
MAX_RETRIES: 10,              // Больше попыток
MAX_DELAY_MS: 7200000,        // 2 часа между попытками
INITIAL_DELAY_MS: 10000,      // Начинать с 10 сек
```

## Что может пойти не так

| Проблема | Решение |
|----------|---------|
| Worker не запущен | Проверить bootstrap.js, добавить startCleanupRetryWorker |
| Retries не обрабатываются | Проверить `cleanup_status` в rentals таблице (должна быть `scheduled_retry`) |
| Всегда fail после 5 попыток | Скорее всего причина в пароле/cookies — проверить их актуальность |
| Заполняется таблица retry_logs | Это нормально — это логирование; можно архивировать старые логи |

## Production Checklist

- [ ] Запустить миграцию DB
- [ ] Добавить worker в bootstrap.js
- [ ] Обновить обработчик ошибок cleanup
- [ ] Добавить Telegram команды для мониторинга
- [ ] Протестировать с одним rental
- [ ] Настроить RETRY_CONFIG под ваши нужды
- [ ] Настроить мониторинг failed_permanent cleanups (алерты админу)
- [ ] Задокументировать для других разработчиков

## Ссылки

- [Full docs](./STEAM_ACCOUNT_RECOVERY.md)
- [Integration examples](./STEAM_RECOVERY_INTEGRATION_EXAMPLES.js)
- [Retry source](../steam/cleanupRetry.js)
- [Worker source](../steam/cleanupRetryWorker.js)
