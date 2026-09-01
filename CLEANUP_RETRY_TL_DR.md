# 🔄 Retry Механика для Steam Cleanup - Вкратце

## ТЛ;ДР (Too Long; Didn't Read)

**Что это:** Автоматические повторения неудачных очисток Steam аккаунтов с экспоненциальной задержкой.

**Как работает:**
```
Cleanup fails → Save to DB → Wait 5s → Retry → Wait 10s → Retry → ... (max 5 times)
```

**3 шага интеграции:**

### 1️⃣ Запустить миграцию
```javascript
import { CLEANUP_RETRY_SCHEMA } from './steam/cleanupRetry.js';
await db.query(CLEANUP_RETRY_SCHEMA);
```

### 2️⃣ Запустить worker в bootstrap.js
```javascript
import { startCleanupRetryWorker } from './steam/cleanupRetryWorker.js';
startCleanupRetryWorker(console, 60000); // каждую минуту проверяет
```

### 3️⃣ Обновить обработчик ошибок
```javascript
try {
    await recoverer.executeRecovery();
} catch (error) {
    await scheduleCleanupRetry(rentalId, error.message);
}
```

## 📊 Как это выглядит в БД

После запуска cleanup:

```
Успех:
┌─────────────────┐
│ cleanup_status  │ = 'success'
│ completed_at    │ = NOW()
└─────────────────┘

Ошибка (retry запланирован):
┌──────────────────────────────────┐
│ cleanup_status         │ = 'scheduled_retry'   
│ cleanup_failed_count   │ = 1
│ cleanup_last_error     │ = 'Network timeout'
│ cleanup_next_retry_at  │ = NOW + 5 seconds
└──────────────────────────────────┘

Worker запустится через 5 сек и повторит...
```

## 📱 Телеграм команды

```
/cleanup_status 123         # Посмотреть статус rental #123
/cleanup_stats              # Общая статистика
/cleanup_retry 123          # Вручную запустить retry (admin)
/cleanup_failed             # Список failed cleanups (admin)
```

Пример:
```
/cleanup_status 123

✅ Cleanup Status - Rental #123
Account: username123
Rental Status: active
Cleanup Status: scheduled_retry
Attempts: 2
⏰ Next Retry: 8s
```

## ⚙️ Логика Retry

| Попытка | Задержка | Итого до retry |
|---------|----------|---|
| 1️⃣ | ~5 сек | 5s |
| 2️⃣ | ~10 сек | 10s |
| 3️⃣ | ~20 сек | 20s |
| 4️⃣ | ~40 сек | 40s |
| 5️⃣ | ~80 сек | 80s |
| Дальше | ❌ FAIL | — |

**Plus:** 
- ±10% рандомности (избегаем thundering herd)
- 24-часовое окно (не retry старые rentals)
- Экспоненциальный backoff (2x каждый раз)

## 💾 Данные в БД

### Таблица `rentals` (новые колонки):
```sql
cleanup_status           -- 'success' | 'scheduled_retry' | 'failed_permanent'
cleanup_failed_count     -- Кол-во попыток
cleanup_last_error       -- Текст ошибки
cleanup_next_retry_at    -- Когда следующий retry
cleanup_completed_at     -- Когда завершилось
```

### Таблица `cleanup_retry_logs`:
```sql
rental_id         -- Какой rental
attempt           -- Номер попытки (1, 2, 3...)
error_message     -- Текст ошибки
scheduled_for     -- На когда запланирована
delay_ms          -- Задержка перед попыткой
created_at        -- Когда логировалось
```

## 🧪 Тестирование

### Тест на dev машине
```javascript
// 1. Создать rental с истекшей датой
const rental = await ensureRental({ orderId: 1, offerId: '123' });
await db.query('UPDATE rentals SET ends_at = NOW() - INTERVAL 1 HOUR WHERE id = $1', [rental.id]);

// 2. Запустить cleanup
await processRentalExpiryWithCleanup(rental.id);

// 3. Проверить БД
SELECT cleanup_status, cleanup_failed_count, cleanup_next_retry_at 
FROM rentals WHERE id = <rental_id>;

// 4. Дождаться retry
setTimeout(() => {
    processPendingCleanupRetries();
}, 6000); // Через 6 сек после первой попытки
```

## 🚀 Deployment

```bash
# 1. Миграция
npm run db:migrate  # или вручную запустить CLEANUP_RETRY_SCHEMA

# 2. Обновить код (добавить startCleanupRetryWorker в bootstrap)

# 3. Перезагрузить бота
npm start

# 4. Проверить логи
[Cleanup Retry Worker] Started
✓ Cleanup retry worker started
```

## 📊 Мониторинг

### Периодически проверяйте:
```javascript
const stats = await getCleanupStats();
// { successful: 45, pending_retry: 2, failed_permanent: 1, ... }

if (stats.failed_permanent > 5) {
    // Отправить алерт админу
    await bot.telegram.sendMessage(ADMIN_ID, '⚠️ Too many failed cleanups');
}
```

### Логи worker'а
```
[Cleanup Retry Worker] Found 3 pending retries
[Cleanup Retry] Processing retry #2 for rental 123 (username)
✓ Cleanup retry succeeded for rental 123
✗ Cleanup retry failed for rental 124: Old password verification failed
[Cleanup Retry Worker] Completed: 2 succeeded, 1 failed
```

## ❓ FAQ

**Q: Что если worker не запустится?**
A: Retry не будет обработан. Добавьте startCleanupRetryWorker в bootstrap.js и перезагрузитесь.

**Q: Можно ли менять задержки между retry?**
A: Да, меняйте `RETRY_CONFIG` в `steam/cleanupRetry.js`. Например:
```javascript
MAX_RETRIES: 10,              // Больше попыток
MAX_DELAY_MS: 7200000,        // 2 часа макс
INITIAL_DELAY_MS: 10000,      // 10 сек вместо 5
```

**Q: Что если cleanup всегда падает?**
A: После 5 попыток: `cleanup_status = 'failed_permanent'`. Проверьте:
- Правильный ли пароль?
- Не истекли ли cookies?
- Не заблокирован ли аккаунт?

Можно вручную retry: `/cleanup_retry <rental_id>`

**Q: Можно ли отключить retry для некоторых rental?**
A: Нет, но можно удалить из БД или установить очень старый `cleanup_next_retry_at`.

**Q: Сколько памяти требует worker?**
A: Минимум — он только читает из БД и запускает cleanup процесс.

## 🔗 Ссылки

- Полная документация: `docs/STEAM_ACCOUNT_RECOVERY.md`
- Retry доки: `docs/CLEANUP_RETRY_QUICKSTART.md`
- Примеры кода: `docs/STEAM_RECOVERY_INTEGRATION_EXAMPLES.js`
- Пример bootstrap: `BOOTSTRAP_WITH_CLEANUP_EXAMPLE.js`
- Исходник retry: `steam/cleanupRetry.js`
- Исходник worker: `steam/cleanupRetryWorker.js`
- Overview: `CLEANUP_SYSTEM_OVERVIEW.md`

## ✅ Checklist

- [ ] Запущена миграция CLEANUP_RETRY_SCHEMA
- [ ] startCleanupRetryWorker добавлен в bootstrap.js
- [ ] scheduleCleanupRetry используется при ошибках cleanup
- [ ] Telegram команды добавлены (или используйте пример из BOOTSTRAP_WITH_CLEANUP_EXAMPLE.js)
- [ ] Протестировано с одним rental
- [ ] Логирование проверено
- [ ] Мониторинг настроен

## 💡 Советы

1. **Начните с малого** — тестируйте на одном rental, потом roll out
2. **Мониторьте failed_permanent** — это признак систематической проблемы
3. **Логируйте успехи** — помогает отследить когда прошли retry
4. **Не меняйте RETRY_CONFIG часто** — стабильность важнее экспериментов
5. **Архивируйте старые логи** — cleanup_retry_logs может расти большой

---

**Создано:** Полная система retry с exponential backoff  
**Время интеграции:** 15-30 минут  
**Production ready:** ✅ Да
