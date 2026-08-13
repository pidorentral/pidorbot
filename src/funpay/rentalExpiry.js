import { getClient, query } from '../db.js';
import { extendActiveRental } from '../dao/write.js';
import { createCleanupAgentClient } from '../rentals/cleanupAgentClient.js';

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_RENEWAL_GRACE_MS = 120_000;
const DEFAULT_RETRY_INITIAL_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_LEASE_MS = 75_000;

function getPositiveInteger(value, name, fallback, minimum = 1) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

export function getExpiryCheckIntervalMs(value = process.env.RENTAL_EXPIRY_CHECK_MS) {
  return getPositiveInteger(value, 'RENTAL_EXPIRY_CHECK_MS', DEFAULT_CHECK_INTERVAL_MS, 2_000);
}

/**
 * A small grace period lets a renewal payment be processed before teardown starts.
 * Set to 0 only if immediate teardown is more important than late renewal handling.
 */
export function getRentalRenewalGraceMs(value = process.env.RENTAL_RENEWAL_GRACE_MS) {
  return getPositiveInteger(value, 'RENTAL_RENEWAL_GRACE_MS', DEFAULT_RENEWAL_GRACE_MS, 0);
}

export function getCleanupRetryInitialMs(value = process.env.RENTAL_CLEANUP_RETRY_INITIAL_MS) {
  return getPositiveInteger(value, 'RENTAL_CLEANUP_RETRY_INITIAL_MS', DEFAULT_RETRY_INITIAL_MS, 1_000);
}

export function getCleanupRetryMaxMs(value = process.env.RENTAL_CLEANUP_RETRY_MAX_MS) {
  return getPositiveInteger(value, 'RENTAL_CLEANUP_RETRY_MAX_MS', DEFAULT_RETRY_MAX_MS, 1_000);
}

export function getCleanupLeaseMs(value = process.env.RENTAL_CLEANUP_LEASE_MS) {
  return getPositiveInteger(value, 'RENTAL_CLEANUP_LEASE_MS', DEFAULT_CLEANUP_LEASE_MS, 5_000);
}

export function getCleanupRetryDelayMs(attempt, { initialMs, maxMs }) {
  const exponent = Math.max(0, Math.min(Number(attempt || 1) - 1, 16));
  return Math.min(initialMs * (2 ** exponent), maxMs);
}

function asDate(value) {
  return value ? new Date(value) : null;
}

function isRentalReadyForCleanup(rental, now, renewalGraceMs) {
  if (rental.status !== 'active' || rental.cleanupCompletedAt) return false;

  const requested = asDate(rental.cleanupRequestedAt);
  const endsAt = asDate(rental.endsAt);
  const expirationDeadline = new Date(now.getTime() - renewalGraceMs);
  if (!requested && (!endsAt || endsAt > expirationDeadline)) return false;

  const leaseUntil = asDate(rental.cleanupLeaseUntil);
  if (leaseUntil && leaseUntil > now) return false;

  const nextRetryAt = asDate(rental.cleanupNextRetryAt);
  return !nextRetryAt || nextRetryAt <= now;
}

function cleanError(error) {
  return String(error?.message || error || 'VM cleanup failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function claimCleanup(rentalId, { renewalGraceMs, cleanupLeaseMs }) {
  const dbClient = await getClient();
  try {
    await dbClient.query('BEGIN');
    const selected = await dbClient.query(
      `SELECT r.id,
              r.account_id AS "accountId",
              r.buyer,
              r.node_id AS "nodeId",
              r.ends_at AS "endsAt",
              r.status,
              r.cleanup_requested_at AS "cleanupRequestedAt",
              r.cleanup_started_at AS "cleanupStartedAt",
              r.cleanup_lease_until AS "cleanupLeaseUntil",
              r.cleanup_completed_at AS "cleanupCompletedAt",
              r.cleanup_next_retry_at AS "cleanupNextRetryAt",
              r.cleanup_attempts AS "cleanupAttempts",
              a.title,
              a.login
         FROM rentals r
         JOIN accounts a ON a.id = r.account_id
        WHERE r.id = $1
        FOR UPDATE`,
      [rentalId]
    );

    const rental = selected.rows[0];
    const now = new Date();
    if (!rental || !isRentalReadyForCleanup(rental, now, renewalGraceMs)) {
      await dbClient.query('COMMIT');
      return null;
    }

    const attempt = Number(rental.cleanupAttempts || 0) + 1;
    const leaseUntil = new Date(now.getTime() + cleanupLeaseMs);
    const claimed = await dbClient.query(
      `UPDATE rentals
          SET cleanup_started_at = COALESCE(cleanup_started_at, NOW()),
              cleanup_lease_until = $2,
              cleanup_next_retry_at = NULL,
              cleanup_attempts = $3,
              cleanup_last_error = NULL
        WHERE id = $1
        RETURNING id,
                  account_id AS "accountId",
                  buyer,
                  node_id AS "nodeId",
                  ends_at AS "endsAt",
                  cleanup_attempts AS "cleanupAttempts"`,
      [rentalId, leaseUntil, attempt]
    );

    // Fail closed: even if an older/manual operation made the account available,
    // it cannot be assigned while the VM cleanup job is running.
    await dbClient.query(
      `UPDATE accounts
          SET status = 'rented'
        WHERE id = $1 AND status = 'available'`,
      [rental.accountId]
    );

    await dbClient.query('COMMIT');
    return { ...rental, ...claimed.rows[0], cleanupAttempts: attempt };
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }
}

async function markCleanupSucceeded(rentalId) {
  const dbClient = await getClient();
  try {
    await dbClient.query('BEGIN');
    const ended = await dbClient.query(
      `UPDATE rentals
          SET status = 'ended',
              state = 'completed',
              cleanup_completed_at = NOW(),
              cleanup_lease_until = NULL,
              cleanup_next_retry_at = NULL,
              cleanup_last_error = NULL
        WHERE id = $1
          AND status = 'active'
          AND cleanup_completed_at IS NULL
        RETURNING id, account_id AS "accountId"`,
      [rentalId]
    );

    if (!ended.rows.length) {
      await dbClient.query('COMMIT');
      return false;
    }

    const accountId = ended.rows[0].accountId;
    await dbClient.query(
      `UPDATE accounts a
          SET status = 'available'
        WHERE a.id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM rentals r
             WHERE r.account_id = a.id
               AND r.status = 'active'
          )`,
      [accountId]
    );

    await dbClient.query('COMMIT');
    return true;
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }
}

async function markCleanupFailed(rentalId, errorMessage, { attempt, retryInitialMs, retryMaxMs }) {
  const delay = getCleanupRetryDelayMs(attempt, { initialMs: retryInitialMs, maxMs: retryMaxMs });
  const nextRetryAt = new Date(Date.now() + delay);
  await query(
    `UPDATE rentals
        SET cleanup_lease_until = NULL,
            cleanup_next_retry_at = $2,
            cleanup_last_error = $3
      WHERE id = $1
        AND status = 'active'
        AND cleanup_completed_at IS NULL`,
    [rentalId, nextRetryAt, errorMessage]
  );
  return { delay, nextRetryAt };
}

async function notifyRentalEnded(rental, { client, notifyAdmin, logger }) {
  if (rental.nodeId && client) {
    try {
      await client.sendMessage(rental.nodeId, [
        '⏰ Время аренды истекло.',
        '',
        `Аккаунт «${rental.title}» больше недоступен.`,
        'Спасибо за использование сервиса!',
      ].join('\n'));
    } catch (error) {
      logger.error(`Failed to notify buyer ${rental.buyer}: ${error.message}`);
    }
  }

  if (notifyAdmin) {
    await notifyAdmin(
      `🔒 Аренда #${rental.id} безопасно завершена\n` +
      `Аккаунт: #${rental.accountId} (${rental.login})\n` +
      `Покупатель: ${rental.buyer}`
    );
  }
}

async function tryAutomaticRenewal(rental, { renewalResolver, logger, notifyAdmin }) {
  if (!renewalResolver || rental.cleanupStartedAt) return false;

  let decision;
  try {
    decision = await renewalResolver(rental);
  } catch (error) {
    logger.error(`Automatic renewal check failed for rental #${rental.id}: ${error.message}`);
    if (notifyAdmin) {
      await notifyAdmin(`⚠️ Не удалось проверить автопродление аренды #${rental.id}: ${cleanError(error)}`);
    }
    return false;
  }

  if (!decision) return false;
  const hours = Number(decision.hours);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.warn(`Ignoring invalid automatic renewal decision for rental #${rental.id}`);
    return false;
  }

  try {
    const extension = await extendActiveRental(rental.id, hours, {
      reason: decision.reason || 'automatic',
    });
    logger.info(`Rental #${rental.id} automatically extended by ${hours}h until ${extension.newEndsAt.toISOString()}`);
    return true;
  } catch (error) {
    // A concurrent cleanup/extension can legitimately win this race. Cleanup remains fail-closed.
    logger.warn(`Automatic renewal was not applied to rental #${rental.id}: ${error.message}`);
    return false;
  }
}

export function createExpiryChecker({
  client,
  notifyAdmin,
  logger = console,
  intervalMs = getExpiryCheckIntervalMs(),
  renewalGraceMs = getRentalRenewalGraceMs(),
  cleanupLeaseMs = getCleanupLeaseMs(),
  retryInitialMs = getCleanupRetryInitialMs(),
  retryMaxMs = getCleanupRetryMaxMs(),
  cleanupAgent = createCleanupAgentClient(),
  // Reserved integration point for paid subscriptions/recurring billing.
  // Return { hours, reason } to extend before teardown, or null to end the rental.
  renewalResolver = null,
} = {}) {
  let timer = null;

  async function processRental(rental) {
    if (await tryAutomaticRenewal(rental, { renewalResolver, logger, notifyAdmin })) {
      return 'renewed';
    }

    const claimed = await claimCleanup(rental.id, { renewalGraceMs, cleanupLeaseMs });
    if (!claimed) return 'skipped';

    const result = await cleanupAgent.cleanupRental({
      rentalId: claimed.id,
      accountId: claimed.accountId,
      attempt: claimed.cleanupAttempts,
    });

    if (result.ok) {
      const ended = await markCleanupSucceeded(claimed.id);
      if (ended) {
        logger.info(`Rental #${claimed.id} cleaned up by VM agent and completed`);
        await notifyRentalEnded(claimed, { client, notifyAdmin, logger });
        return 'ended';
      }
      return 'skipped';
    }

    const failure = await markCleanupFailed(claimed.id, cleanError(result.error || result.reason), {
      attempt: claimed.cleanupAttempts,
      retryInitialMs,
      retryMaxMs,
    });
    logger.warn(
      `VM cleanup for rental #${claimed.id} failed (${result.reason || 'unknown'}); ` +
      `retry at ${failure.nextRetryAt.toISOString()}`
    );

    if (notifyAdmin && (claimed.cleanupAttempts === 1 || claimed.cleanupAttempts % 5 === 0)) {
      await notifyAdmin(
        `🚨 Очистка аренды #${claimed.id} не выполнена (попытка ${claimed.cleanupAttempts}).\n` +
        `Аккаунт #${claimed.accountId} остаётся занятым. Следующая попытка: ${failure.nextRetryAt.toISOString()}.\n` +
        `Причина: ${cleanError(result.error || result.reason)}`
      );
    }
    return 'failed';
  }

  async function checkOnce() {
    const candidates = await query(
      `SELECT r.id,
              r.account_id AS "accountId",
              r.buyer,
              r.node_id AS "nodeId",
              r.ends_at AS "endsAt",
              r.status,
              r.cleanup_requested_at AS "cleanupRequestedAt",
              r.cleanup_started_at AS "cleanupStartedAt",
              r.cleanup_lease_until AS "cleanupLeaseUntil",
              r.cleanup_completed_at AS "cleanupCompletedAt",
              r.cleanup_next_retry_at AS "cleanupNextRetryAt",
              r.cleanup_attempts AS "cleanupAttempts",
              a.title,
              a.login
         FROM rentals r
         JOIN accounts a ON a.id = r.account_id
        WHERE r.status = 'active'
          AND r.cleanup_completed_at IS NULL
          AND (
            r.cleanup_requested_at IS NOT NULL
            OR r.ends_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
          )
          AND (
            r.cleanup_started_at IS NULL
            OR r.cleanup_next_retry_at <= NOW()
            OR r.cleanup_lease_until <= NOW()
          )
        ORDER BY COALESCE(r.cleanup_next_retry_at, r.ends_at) ASC`,
      [renewalGraceMs]
    );

    if (!candidates.rows.length) return { processed: 0 };
    logger.info(`Expiry checker: ${candidates.rows.length} rental(s) due for cleanup`);

    const results = { processed: 0, ended: 0, renewed: 0, failed: 0, skipped: 0 };
    for (const rental of candidates.rows) {
      try {
        const outcome = await processRental(rental);
        results.processed += 1;
        results[outcome] = (results[outcome] || 0) + 1;
      } catch (error) {
        results.failed += 1;
        logger.error(`Failed to process expired rental #${rental.id}: ${error.message}`);
      }
    }
    return results;
  }

  function start() {
    if (timer) return;
    logger.info(`Rental expiry checker started (interval: ${intervalMs}ms, renewal grace: ${renewalGraceMs}ms)`);
    void checkOnce().catch((error) => logger.error(`Expiry check error: ${error.message}`));
    timer = setInterval(() => {
      void checkOnce().catch((error) => logger.error(`Expiry check error: ${error.message}`));
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { checkOnce, start, stop };
}

/** Queues a manual early end; the expiry worker still performs the VM cleanup. */
export async function requestRentalCleanup(rentalId) {
  const result = await query(
    `UPDATE rentals
        SET ends_at = NOW(),
            cleanup_requested_at = NOW(),
            cleanup_next_retry_at = NOW(),
            cleanup_lease_until = NULL
      WHERE id = $1
        AND status = 'active'
        AND cleanup_completed_at IS NULL
      RETURNING id`,
    [rentalId]
  );
  return result.rows[0] || null;
}
