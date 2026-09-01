/**
 * INTEGRATION EXAMPLE - Steam Account Recovery in Rental Expiry Workflow
 * 
 * This file demonstrates how to integrate SteamAccountRecoverer into your
 * existing rental lifecycle, particularly when a rental ends.
 */

import { SteamAccountRecoverer } from '../steam/accountRecoverer.js';
import { scheduleCleanupRetry, getCleanupRetryHistory } from '../steam/cleanupRetry.js';
import { db } from '../src/db.js';
import { parseMafile } from '../steam/mafile.js';

/**
 * Example: Process rental expiry and cleanup Steam account
 * 
 * This would typically be called from:
 * - rentalExpiry.js poller
 * - orderHandler.js after rental end date
 * - Manual admin cleanup command
 */
export async function processRentalExpiryWithCleanup(rentalId) {
    console.log(`[Rental Expiry] Processing cleanup for rental ${rentalId}`);

    try {
        // 1. Fetch rental details from database
        const rentalQuery = await db.query(
            `SELECT 
                r.id,
                r.account_id,
                a.login,
                a.password,
                a.mafile_payload,
                r.session_cookies,
                r.created_at,
                r.end_date
            FROM rentals r
            JOIN steam_accounts a ON r.account_id = a.id
            WHERE r.id = $1`,
            [rentalId]
        );

        if (rentalQuery.rows.length === 0) {
            throw new Error(`Rental ${rentalId} not found`);
        }

        const rental = rentalQuery.rows[0];

        console.log(`[Rental ${rentalId}] Found rental for account ${rental.login}`);

        // 2. Validate rental has ended
        const now = new Date();
        if (new Date(rental.end_date) > now) {
            console.warn(`[Rental ${rentalId}] Rental hasn't ended yet, skipping cleanup`);
            return { success: false, reason: 'rental_not_ended' };
        }

        // 3. Decrypt and parse mafile
        let mafile;
        try {
            // Assuming mafile is encrypted with your encryption key
            const decrypted = await decryptMafile(rental.mafile_payload);
            mafile = parseMafile(decrypted);
        } catch (error) {
            throw new Error(`Failed to parse mafile: ${error.message}`);
        }

        console.log(`[Rental ${rentalId}] Parsed mafile for ${rental.login}`);

        // 4. Parse cookies from session storage
        let cookies;
        try {
            cookies = JSON.parse(rental.session_cookies);
        } catch {
            throw new Error('Failed to parse session cookies');
        }

        // Validate required cookies exist
        if (!cookies.sessionid || !cookies.steamLoginSecure) {
            throw new Error('Required cookies (sessionid, steamLoginSecure) not found');
        }

        console.log(`[Rental ${rentalId}] Using session cookies from ${rental.created_at}`);

        // 5. Generate new secure password
        const newPassword = generateSecurePassword(32);

        // 6. Create recoverer instance
        const recoverer = new SteamAccountRecoverer({
            login: rental.login,
            oldPassword: rental.password,
            newPassword: newPassword,
            sharedSecret: mafile.sharedSecret,
            cookies: cookies,
            timeout: 20000, // Extended timeout for rental cleanup
            maxRetries: 15,  // More retries since this is automated
        });

        console.log(`[Rental ${rentalId}] Starting recovery flow for ${rental.login}`);

        // 7. Execute recovery (password change + device deauth)
        const result = await recoverer.executeRecovery();

        console.log(`[Rental ${rentalId}] ✓ Recovery completed: ${result.completedSteps.join(' → ')}`);

        // 8. Update database with cleanup results
        await db.query(
            `UPDATE rentals 
             SET 
                status = 'cleaned',
                cleaned_at = NOW(),
                cleanup_notes = $1
             WHERE id = $2`,
            [JSON.stringify({
                passwordChanged: true,
                devicesDeauthorized: true,
                completedSteps: result.completedSteps,
                timestamp: result.timestamp,
            }), rentalId]
        );

        // 9. Update account password in database (optional - for audit trail)
        // NOTE: Don't store the new password! Just mark as changed
        await db.query(
            `UPDATE steam_accounts 
             SET 
                password_changed_at = NOW(),
                password_changed_by = 'system_cleanup'
             WHERE id = $1`,
            [rental.account_id]
        );

        // 10. Log successful cleanup
        await db.query(
            `INSERT INTO rental_cleanup_logs (rental_id, account_id, login, success, message, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                rentalId,
                rental.account_id,
                rental.login,
                true,
                'Account cleaned successfully',
                JSON.stringify({
                    completedSteps: result.completedSteps,
                    duration: new Date() - new Date(rental.end_date),
                    timestamp: result.timestamp,
                }),
            ]
        );

        console.log(`[Rental ${rentalId}] ✓ Database updated, cleanup complete`);

        return {
            success: true,
            rentalId: rentalId,
            account: rental.login,
            completedSteps: result.completedSteps,
            timestamp: new Date().toISOString(),
        };

    } catch (error) {
        console.error(`[Rental ${rentalId}] ✗ Cleanup failed: ${error.message}`);

        // Schedule retry with exponential backoff
        try {
            const retryResult = await scheduleCleanupRetry(rentalId, error.message, 1);

            if (retryResult.scheduled) {
                console.log(`[Rental ${rentalId}] ✓ Scheduled retry #${retryResult.attempt} for ${retryResult.nextRetryAt}`);
            } else {
                console.error(`[Rental ${rentalId}] ✗ Cannot schedule retry: ${retryResult.reason}`);
            }
        } catch (retryError) {
            console.error(`[Rental ${rentalId}] ✗ Failed to schedule retry: ${retryError.message}`);
        }

        // Log failed cleanup attempt
        try {
            await db.query(
                `INSERT INTO rental_cleanup_logs (rental_id, success, message, error_details)
                 VALUES ($1, $2, $3, $4)`,
                [rentalId, false, 'Cleanup failed, scheduled for retry', error.message]
            );
        } catch (logError) {
            console.error(`Failed to log cleanup failure: ${logError.message}`);
        }

        return {
            success: false,
            rentalId: rentalId,
            error: error.message,
            retryScheduled: true,
            timestamp: new Date().toISOString(),
        };
    }
}

/**
 * Example: Batch cleanup of multiple expired rentals
 * Run periodically (e.g., every 5 minutes)
 */
export async function cleanupExpiredRentals() {
    console.log('[Batch Cleanup] Starting cleanup of expired rentals');

    try {
        // Find all rentals that ended but haven't been cleaned
        const expiredRentals = await db.query(
            `SELECT r.id
             FROM rentals r
             WHERE 
                r.status = 'active'
                AND r.end_date < NOW()
                AND (r.cleaned_at IS NULL OR r.status != 'cleaned')
             LIMIT 5`,  // Process 5 at a time to avoid overload
        );

        if (expiredRentals.rows.length === 0) {
            console.log('[Batch Cleanup] No expired rentals to clean');
            return { processedCount: 0, successCount: 0, failedCount: 0 };
        }

        console.log(`[Batch Cleanup] Found ${expiredRentals.rows.length} expired rentals to clean`);

        let successCount = 0;
        let failedCount = 0;

        // Process each rental sequentially (not in parallel) to avoid Steam rate limits
        for (const rental of expiredRentals.rows) {
            const result = await processRentalExpiryWithCleanup(rental.id);

            if (result.success) {
                successCount++;
            } else {
                failedCount++;
            }

            // Space out requests to avoid hitting rate limits
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(
            `[Batch Cleanup] Completed: ${successCount} succeeded, ${failedCount} failed`
        );

        return {
            processedCount: expiredRentals.rows.length,
            successCount,
            failedCount,
            timestamp: new Date().toISOString(),
        };

    } catch (error) {
        console.error(`[Batch Cleanup] Fatal error: ${error.message}`);
        return {
            processedCount: 0,
            successCount: 0,
            failedCount: 0,
            error: error.message,
        };
    }
}

/**
 * Example: Telegram bot command to manually trigger cleanup
 * Usage: /cleanup <rental_id>
 */
export async function handleCleanupCommand(ctx, rentalId) {
    const chatId = ctx.chat.id;

    // Verify admin permissions
    const adminIds = (process.env.TG_ADMIN_IDS || '').split(',');
    if (!adminIds.includes(String(ctx.from.id))) {
        await ctx.reply('❌ Unauthorized');
        return;
    }

    try {
        await ctx.reply(`🔄 Starting cleanup for rental ${rentalId}...`);

        const result = await processRentalExpiryWithCleanup(rentalId);

        if (result.success) {
            const message = `✅ Cleanup completed for ${result.account}\n\n` +
                `Steps completed:\n${result.completedSteps.map(s => `  • ${s}`).join('\n')}\n\n` +
                `Time: ${result.timestamp}`;
            await ctx.reply(message);
        } else {
            await ctx.reply(`❌ Cleanup failed: ${result.error}`);
        }

    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
}

/**
 * Example: Integration with existing rentalExpiry.js
 * Add this to your rental expiry poller:
 */
export async function onRentalExpired(rental) {
    // Existing rental expiry logic...
    console.log(`Rental ${rental.id} has expired`);

    // New: Run account cleanup if enabled
    if (process.env.STEAM_SESSION_LOGOUT_ENABLED === 'true' &&
        process.env.STEAM_PASSWORD_CHANGE_ENABLED === 'true') {

        const cleanupResult = await processRentalExpiryWithCleanup(rental.id);

        if (!cleanupResult.success) {
            // Send alert to admin
            console.warn(`Cleanup failed for rental ${rental.id}: ${cleanupResult.error}`);
            // Consider implementing retry mechanism
        }
    }
}

/**
 * Helper: Generate cryptographically secure password
 * @param {number} length - Password length
 * @returns {string} Random password with mixed character types
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
 * Helper: Decrypt mafile payload (stub - implement with your encryption)
 */
async function decryptMafile(encryptedPayload) {
    // TODO: Implement with your encryption/decryption logic
    // This is a placeholder
    return encryptedPayload;
}

/**
 * Create database table for cleanup logs
 * Run once during migration:
 */
export const CLEANUP_LOGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS rental_cleanup_logs (
    id SERIAL PRIMARY KEY,
    rental_id INTEGER NOT NULL,
    account_id INTEGER,
    login VARCHAR(255),
    success BOOLEAN NOT NULL,
    message TEXT,
    details JSONB,
    error_details TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE
);

CREATE INDEX idx_rental_cleanup_logs_rental_id ON rental_cleanup_logs(rental_id);
CREATE INDEX idx_rental_cleanup_logs_success ON rental_cleanup_logs(success);
CREATE INDEX idx_rental_cleanup_logs_created_at ON rental_cleanup_logs(created_at DESC);
`;

/**
 * Example: Get cleanup retry history for a rental
 * Useful for admin panels or debugging
 */
export async function getCleanupHistory(rentalId) {
    const retryHistory = await getCleanupRetryHistory(rentalId);
    
    if (retryHistory.length === 0) {
        return { rentalId, status: 'no_retries' };
    }

    return {
        rentalId,
        totalAttempts: retryHistory.length,
        attempts: retryHistory.map(r => ({
            attempt: r.attempt,
            error: r.error_message,
            scheduledFor: r.scheduled_for,
            delayMs: r.delay_ms,
            createdAt: r.created_at,
        })),
    };
}

/**
 * Example: Telegram command to view cleanup status
 * Usage: /cleanup_status <rental_id>
 */
export async function handleCleanupStatusCommand(ctx, rentalId) {
    try {
        const res = await db.query(
            `SELECT 
                r.id,
                r.account_id,
                a.login,
                r.cleanup_status,
                r.cleanup_failed_count,
                r.cleanup_last_error,
                r.cleanup_next_retry_at,
                r.cleanup_completed_at
             FROM rentals r
             JOIN accounts a ON r.account_id = a.id
             WHERE r.id = $1`,
            [rentalId]
        );

        if (res.rows.length === 0) {
            await ctx.reply(`❌ Rental ${rentalId} not found`);
            return;
        }

        const rental = res.rows[0];
        const history = await getCleanupHistory(rentalId);

        let statusEmoji = '❓';
        if (rental.cleanup_status === 'success') statusEmoji = '✅';
        if (rental.cleanup_status === 'scheduled_retry') statusEmoji = '⏳';
        if (rental.cleanup_status === 'failed_permanent') statusEmoji = '❌';

        let message = `${statusEmoji} Cleanup Status for Rental #${rentalId}\n\n`;
        message += `Account: ${rental.login}\n`;
        message += `Status: ${rental.cleanup_status}\n`;
        message += `Attempts: ${rental.cleanup_failed_count}\n`;

        if (rental.cleanup_status === 'scheduled_retry') {
            const nextRetry = new Date(rental.cleanup_next_retry_at);
            const timeUntil = Math.round((nextRetry - new Date()) / 1000);
            message += `Next Retry: in ${Math.max(0, timeUntil)}s\n`;
        }

        if (rental.cleanup_last_error) {
            message += `Last Error: ${rental.cleanup_last_error.substring(0, 100)}\n`;
        }

        if (rental.cleanup_completed_at) {
            message += `Completed: ${new Date(rental.cleanup_completed_at).toLocaleString()}\n`;
        }

        if (history.attempts.length > 0) {
            message += `\nAttempt History:\n`;
            history.attempts.forEach(a => {
                message += `  #${a.attempt}: ${a.error?.substring(0, 50)}...\n`;
            });
        }

        await ctx.reply(message);

    } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
}

/**
 * Example: Initialize cleanup retry worker on bot start
 * Add this to your main bootstrap.js
 */
export async function initializeCleanupSystem(bot, db, logger = console) {
    // Import worker
    const { startCleanupRetryWorker } = await import('./steam/cleanupRetryWorker.js');

    // Start the worker
    const stopWorker = startCleanupRetryWorker(logger, 60000); // Check every minute

    logger.info('✓ Cleanup retry worker started');

    // Store stop function for graceful shutdown
    process.on('SIGTERM', async () => {
        logger.info('Stopping cleanup retry worker...');
        stopWorker();
    });

    return stopWorker;
}
