/**
 * Steam Account Cleanup Retry Mechanism
 * @description Handles automatic retries for failed cleanups with exponential backoff
 */

import { query, getClient } from '../src/db.js';
import { SteamAccountRecoverer, SteamPasswordChangeError } from './accountRecoverer.js';
import { parseMafile } from './mafile.js';

/**
 * Retry configuration constants
 */
export const RETRY_CONFIG = {
    MAX_RETRIES: 5,
    INITIAL_DELAY_MS: 5000,      // 5 seconds
    MAX_DELAY_MS: 3600000,        // 1 hour
    BACKOFF_MULTIPLIER: 2,        // Exponential: 5s → 10s → 20s → 40s → 80s
    JITTER_FACTOR: 0.1,           // Add ±10% randomness
    RETRY_WINDOW_HOURS: 24,       // Retry only within 24 hours
};

/**
 * Schedule a cleanup for retry
 * Called when initial cleanup fails
 * @param {number} rentalId - Rental ID
 * @param {string} errorMessage - Error that occurred
 * @param {number} [currentAttempt=1] - Current retry attempt number
 * @returns {Promise<Object>} Retry scheduling result
 */
export async function scheduleCleanupRetry(rentalId, errorMessage, currentAttempt = 1) {
    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Get current rental state
        const rentalRes = await client.query(
            `SELECT id, cleanup_failed_count, cleanup_last_error, cleanup_next_retry_at
             FROM rentals
             WHERE id = $1
             FOR UPDATE`,
            [rentalId]
        );

        if (!rentalRes.rows.length) {
            throw new Error(`Rental ${rentalId} not found`);
        }

        const rental = rentalRes.rows[0];
        const failCount = (rental.cleanup_failed_count || 0) + 1;

        // Check if we've exceeded max retries
        if (failCount > RETRY_CONFIG.MAX_RETRIES) {
            await client.query(
                `UPDATE rentals
                 SET cleanup_status = 'failed_permanent',
                     cleanup_failed_count = $1,
                     cleanup_last_error = $2,
                     cleanup_completed_at = NOW()
                 WHERE id = $3`,
                [failCount, errorMessage, rentalId]
            );

            await client.query('COMMIT');
            return { rentalId, scheduled: false, reason: 'max_retries_exceeded', attempt: failCount };
        }

        // Calculate exponential backoff with jitter
        const delayMs = calculateBackoffDelay(failCount);
        const nextRetryAt = new Date(Date.now() + delayMs);

        // Schedule retry
        await client.query(
            `UPDATE rentals
             SET cleanup_status = 'scheduled_retry',
                 cleanup_failed_count = $1,
                 cleanup_last_error = $2,
                 cleanup_next_retry_at = $3
             WHERE id = $4`,
            [failCount, errorMessage, nextRetryAt, rentalId]
        );

        // Log retry attempt
        await client.query(
            `INSERT INTO cleanup_retry_logs (rental_id, attempt, error_message, scheduled_for, delay_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [rentalId, failCount, errorMessage, nextRetryAt, delayMs]
        );

        await client.query('COMMIT');

        return {
            rentalId,
            scheduled: true,
            attempt: failCount,
            nextRetryAt: nextRetryAt.toISOString(),
            delayMs,
        };

    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Calculate exponential backoff delay with jitter
 * @private
 * @param {number} attemptNumber - Which retry attempt this is (1-based)
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attemptNumber) {
    // Base delay: INITIAL * (MULTIPLIER ^ (attempt - 1))
    let delayMs = RETRY_CONFIG.INITIAL_DELAY_MS * Math.pow(
        RETRY_CONFIG.BACKOFF_MULTIPLIER,
        attemptNumber - 1
    );

    // Cap at max delay
    delayMs = Math.min(delayMs, RETRY_CONFIG.MAX_DELAY_MS);

    // Add jitter: ±JITTER_FACTOR * delay
    const jitter = delayMs * RETRY_CONFIG.JITTER_FACTOR * (Math.random() * 2 - 1);
    delayMs += jitter;

    return Math.round(delayMs);
}

/**
 * Process pending cleanup retries
 * Should be called periodically (e.g., every minute)
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Processing results
 */
export async function processPendingCleanupRetries(logger = console) {
    const client = await getClient();
    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;

    try {
        // Find all rentals ready for retry
        const pendingRes = await client.query(
            `SELECT 
                r.id,
                r.account_id,
                r.cleanup_failed_count,
                r.cleanup_next_retry_at,
                a.login,
                a.password,
                r.mafile_payload,
                r.session_cookies
             FROM rentals r
             JOIN accounts a ON r.account_id = a.id
             WHERE r.cleanup_status = 'scheduled_retry'
               AND r.cleanup_next_retry_at <= NOW()
               AND r.ends_at > NOW() - INTERVAL '${RETRY_CONFIG.RETRY_WINDOW_HOURS} hours'
             ORDER BY r.cleanup_next_retry_at ASC
             LIMIT 10`,
            []
        );

        if (pendingRes.rows.length === 0) {
            return { processedCount: 0, successCount: 0, failedCount: 0 };
        }

        logger.info(`[Cleanup Retry] Found ${pendingRes.rows.length} pending retries`);

        // Process each retry
        for (const rental of pendingRes.rows) {
            processedCount++;

            try {
                logger.info(`[Cleanup Retry] Processing retry #${rental.cleanup_failed_count + 1} for rental ${rental.id} (${rental.login})`);

                // Execute cleanup
                const result = await executeCleanupWithRetryTracking(rental, logger);

                if (result.success) {
                    successCount++;
                    logger.info(`✓ Cleanup retry succeeded for rental ${rental.id}`);
                } else {
                    failedCount++;
                    logger.warn(`✗ Cleanup retry failed for rental ${rental.id}: ${result.error}`);

                    // Schedule next retry
                    await scheduleCleanupRetry(
                        rental.id,
                        result.error,
                        rental.cleanup_failed_count + 1
                    );
                }

            } catch (error) {
                failedCount++;
                logger.error(`Error processing retry for rental ${rental.id}: ${error.message}`);

                // Attempt to schedule next retry despite error
                try {
                    await scheduleCleanupRetry(
                        rental.id,
                        error.message,
                        rental.cleanup_failed_count + 1
                    );
                } catch (scheduleError) {
                    logger.error(`Failed to schedule retry for rental ${rental.id}: ${scheduleError.message}`);
                }
            }

            // Space out requests to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        return { processedCount, successCount, failedCount };

    } catch (error) {
        logger.error(`Fatal error in cleanup retry processor: ${error.message}`);
        return { processedCount, successCount, failedCount, error: error.message };
    } finally {
        client.release();
    }
}

/**
 * Execute cleanup with retry tracking
 * @private
 * @param {Object} rental - Rental object from database
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Result with success flag
 */
async function executeCleanupWithRetryTracking(rental, logger) {
    try {
        if (!rental.mafile_payload) {
            throw new Error('Missing rental.mafile_payload');
        }
        if (!rental.session_cookies) {
            throw new Error('Missing rental.session_cookies');
        }

        // Decrypt mafile
        let mafile;
        try {
            const decrypted = JSON.parse(rental.mafile_payload);
            mafile = parseMafile(JSON.stringify(decrypted));
        } catch {
            throw new Error('Failed to parse mafile');
        }

        // Parse cookies
        let cookies;
        try {
            cookies = JSON.parse(rental.session_cookies);
        } catch {
            throw new Error('Failed to parse cookies');
        }

        if (!cookies.sessionid || !cookies.steamLoginSecure) {
            throw new Error('Required cookies missing');
        }

        // Execute recovery
        const recoverer = new SteamAccountRecoverer({
            login: rental.login,
            oldPassword: rental.password,
            newPassword: generateSecurePassword(32),
            sharedSecret: mafile.sharedSecret,
            cookies: cookies,
            timeout: 20000,
            maxRetries: 15,
        });

        const result = await recoverer.executeRecovery();

        // Update rental as cleaned
        await query(
            `UPDATE rentals
             SET cleanup_status = 'success',
                 cleanup_completed_at = NOW()
             WHERE id = $1`,
            [rental.id]
        );

        return { success: true, result };

    } catch (error) {
        const errorMsg = error instanceof SteamPasswordChangeError
            ? `${error.message} (HTTP ${error.statusCode})`
            : error.message;

        return { success: false, error: errorMsg };
    }
}

/**
 * Get cleanup retry history for a rental
 * @param {number} rentalId - Rental ID
 * @returns {Promise<Array>} Array of retry attempts
 */
export async function getCleanupRetryHistory(rentalId) {
    const res = await query(
        `SELECT 
            id,
            rental_id,
            attempt,
            error_message,
            scheduled_for,
            delay_ms,
            created_at
         FROM cleanup_retry_logs
         WHERE rental_id = $1
         ORDER BY attempt ASC`,
        [rentalId]
    );

    return res.rows;
}

/**
 * Get cleanup statistics
 * @returns {Promise<Object>} Stats object
 */
export async function getCleanupStats() {
    const res = await query(
        `SELECT 
            COUNT(*) FILTER (WHERE cleanup_status = 'success') as successful,
            COUNT(*) FILTER (WHERE cleanup_status = 'scheduled_retry') as pending_retry,
            COUNT(*) FILTER (WHERE cleanup_status = 'failed_permanent') as failed_permanent,
            AVG(cleanup_failed_count) FILTER (WHERE cleanup_failed_count > 0) as avg_attempts,
            MAX(cleanup_failed_count) as max_attempts
         FROM rentals
         WHERE cleanup_status IS NOT NULL`,
        []
    );

    return res.rows[0] || {};
}

/**
 * Manually reset cleanup for a rental (admin only)
 * @param {number} rentalId - Rental ID
 * @returns {Promise<Object>} Reset result
 */
export async function resetCleanupRetry(rentalId) {
    const client = await getClient();

    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE rentals
             SET cleanup_status = 'scheduled_retry',
                 cleanup_failed_count = 0,
                 cleanup_next_retry_at = NOW(),
                 cleanup_last_error = NULL
             WHERE id = $1`,
            [rentalId]
        );

        await client.query(
            `INSERT INTO cleanup_retry_logs (rental_id, attempt, error_message, scheduled_for)
             VALUES ($1, $2, $3, NOW())`,
            [rentalId, 0, 'Manual reset by admin']
        );

        await client.query('COMMIT');

        return { rentalId, reset: true };

    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Generate secure password
 * @private
 * @param {number} length - Password length
 * @returns {string} Random password
 */
function generateSecurePassword(length = 32) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_+-=[]{}|;:,.<>?';
    let password = '';

    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);

    for (let i = 0; i < length; i++) {
        password += charset[randomValues[i] % charset.length];
    }

    return password;
}

/**
 * Database schema for retry tracking
 * Run this migration once:
 */
export const CLEANUP_RETRY_SCHEMA = `
-- Add columns to rentals table if they don't exist
ALTER TABLE rentals
ADD COLUMN IF NOT EXISTS cleanup_status VARCHAR(50),
ADD COLUMN IF NOT EXISTS cleanup_failed_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS cleanup_last_error TEXT,
ADD COLUMN IF NOT EXISTS cleanup_next_retry_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMP;

-- Create retry logs table
CREATE TABLE IF NOT EXISTS cleanup_retry_logs (
    id SERIAL PRIMARY KEY,
    rental_id INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    error_message TEXT,
    scheduled_for TIMESTAMP,
    delay_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_cleanup_retry_logs_rental_id ON cleanup_retry_logs(rental_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_retry_logs_scheduled ON cleanup_retry_logs(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_rentals_cleanup_status ON rentals(cleanup_status);
CREATE INDEX IF NOT EXISTS idx_rentals_cleanup_next_retry ON rentals(cleanup_next_retry_at) 
    WHERE cleanup_status = 'scheduled_retry';
`;
