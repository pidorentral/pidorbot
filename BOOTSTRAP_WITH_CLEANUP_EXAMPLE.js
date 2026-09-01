/**
 * EXAMPLE: Bootstrap Integration with Cleanup Retry System
 * 
 * Add this to your main bootstrap.js or main.js to enable
 * the complete Steam account cleanup system with automatic retries
 */

// ============================================================================
// 1. IMPORTS
// ============================================================================

import { Telegraf } from 'telegraf';
import { db, getPool } from './src/db.js';
import { startCleanupRetryWorker } from './steam/cleanupRetryWorker.js';
import { 
    getCleanupRetryHistory, 
    getCleanupStats, 
    resetCleanupRetry 
} from './steam/cleanupRetry.js';

// ============================================================================
// 2. INITIALIZE BOT
// ============================================================================

const bot = new Telegraf(process.env.BOT_TOKEN);
const logger = console;

// ============================================================================
// 3. SETUP CLEANUP SYSTEM
// ============================================================================

export async function initializeCleanupSystem(bot) {
    logger.info('[Cleanup System] Initializing...');

    // Start retry worker
    const stopWorker = startCleanupRetryWorker(logger, 60000); // Check every minute

    logger.info('✓ Cleanup retry worker started');

    // Graceful shutdown
    const shutdown = () => {
        logger.info('[Cleanup System] Shutting down...');
        stopWorker();
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return { stopWorker, shutdown };
}

// ============================================================================
// 4. TELEGRAM COMMANDS
// ============================================================================

/**
 * /cleanup_status <rental_id> - View cleanup status for a rental
 */
bot.command('cleanup_status', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            await ctx.reply('Usage: /cleanup_status <rental_id>');
            return;
        }

        const rentalId = parseInt(args[1]);
        if (!Number.isFinite(rentalId)) {
            await ctx.reply('❌ Invalid rental ID');
            return;
        }

        // Fetch rental info
        const res = await db.query(
            `SELECT 
                r.id,
                r.account_id,
                a.login,
                r.cleanup_status,
                r.cleanup_failed_count,
                r.cleanup_last_error,
                r.cleanup_next_retry_at,
                r.cleanup_completed_at,
                r.status as rental_status,
                r.ends_at
            FROM rentals r
            JOIN accounts a ON r.account_id = a.id
            WHERE r.id = $1`,
            [rentalId]
        );

        if (res.rows.length === 0) {
            await ctx.reply(`❌ Rental #${rentalId} not found`);
            return;
        }

        const rental = res.rows[0];

        // Build status message
        let statusEmoji = '❓';
        if (rental.cleanup_status === 'success') statusEmoji = '✅';
        if (rental.cleanup_status === 'scheduled_retry') statusEmoji = '⏳';
        if (rental.cleanup_status === 'failed_permanent') statusEmoji = '❌';

        let message = `${statusEmoji} Cleanup Status - Rental #${rentalId}\n\n`;
        message += `📄 Account: <code>${rental.login}</code>\n`;
        message += `🏠 Rental Status: ${rental.rental_status}\n`;
        message += `🔧 Cleanup Status: <code>${rental.cleanup_status || 'not_started'}</code>\n`;
        message += `📊 Attempts: ${rental.cleanup_failed_count || 0}\n`;

        if (rental.cleanup_status === 'scheduled_retry' && rental.cleanup_next_retry_at) {
            const nextRetry = new Date(rental.cleanup_next_retry_at);
            const timeUntil = Math.round((nextRetry - new Date()) / 1000);
            message += `⏰ Next Retry: <code>${Math.max(0, timeUntil)}s</code>\n`;
        }

        if (rental.cleanup_last_error) {
            message += `\n❌ Last Error:\n<code>${rental.cleanup_last_error.substring(0, 150)}</code>\n`;
        }

        if (rental.cleanup_completed_at) {
            message += `\n✓ Completed: <code>${new Date(rental.cleanup_completed_at).toLocaleString()}</code>\n`;
        }

        // Show retry history
        const history = await getCleanupRetryHistory(rentalId);
        if (history.length > 0) {
            message += `\n📋 Attempt History:\n`;
            history.slice(-3).forEach(h => {
                message += `  #${h.attempt}: ${h.error_message?.substring(0, 40) || 'success'}\n`;
            });
        }

        await ctx.reply(message, { parse_mode: 'HTML' });

    } catch (error) {
        logger.error(`Error in cleanup_status: ${error.message}`);
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

/**
 * /cleanup_stats - View global cleanup statistics
 */
bot.command('cleanup_stats', async (ctx) => {
    try {
        const stats = await getCleanupStats();

        let message = `📊 Cleanup Statistics\n\n`;
        message += `✅ Successful: ${stats.successful || 0}\n`;
        message += `⏳ Pending Retry: ${stats.pending_retry || 0}\n`;
        message += `❌ Failed Permanent: ${stats.failed_permanent || 0}\n`;
        message += `\n📈 Metrics:\n`;
        message += `  Avg Attempts: ${stats.avg_attempts?.toFixed(1) || 'N/A'}\n`;
        message += `  Max Attempts: ${stats.max_attempts || 0}\n`;

        await ctx.reply(message);

    } catch (error) {
        logger.error(`Error in cleanup_stats: ${error.message}`);
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

/**
 * /cleanup_retry <rental_id> - Manually trigger cleanup retry (ADMIN ONLY)
 */
bot.command('cleanup_retry', async (ctx) => {
    try {
        // Check admin permission
        const adminIds = (process.env.TG_ADMIN_IDS || '').split(',').map(id => id.trim());
        if (!adminIds.includes(String(ctx.from.id))) {
            await ctx.reply('❌ Admin access required');
            return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            await ctx.reply('Usage: /cleanup_retry <rental_id>');
            return;
        }

        const rentalId = parseInt(args[1]);
        if (!Number.isFinite(rentalId)) {
            await ctx.reply('❌ Invalid rental ID');
            return;
        }

        // Reset cleanup for retry
        const result = await resetCleanupRetry(rentalId);

        await ctx.reply(
            `✓ Cleanup retry reset for rental #${rentalId}\n` +
            `Will be processed on next worker run (within 1 minute)`
        );

    } catch (error) {
        logger.error(`Error in cleanup_retry: ${error.message}`);
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

/**
 * /cleanup_failed - List all permanently failed cleanups (ADMIN ONLY)
 */
bot.command('cleanup_failed', async (ctx) => {
    try {
        // Check admin permission
        const adminIds = (process.env.TG_ADMIN_IDS || '').split(',').map(id => id.trim());
        if (!adminIds.includes(String(ctx.from.id))) {
            await ctx.reply('❌ Admin access required');
            return;
        }

        const res = await db.query(
            `SELECT 
                r.id,
                a.login,
                r.cleanup_failed_count,
                r.cleanup_last_error,
                r.cleanup_completed_at
            FROM rentals r
            JOIN accounts a ON r.account_id = a.id
            WHERE r.cleanup_status = 'failed_permanent'
            ORDER BY r.cleanup_completed_at DESC
            LIMIT 10`,
            []
        );

        if (res.rows.length === 0) {
            await ctx.reply('✓ No permanently failed cleanups');
            return;
        }

        let message = `❌ Permanently Failed Cleanups (${res.rows.length})\n\n`;
        
        res.rows.forEach(r => {
            message += `Rental #${r.id}: ${r.login}\n`;
            message += `  Attempts: ${r.cleanup_failed_count}\n`;
            message += `  Error: ${r.cleanup_last_error?.substring(0, 50)}...\n\n`;
        });

        message += `Use: /cleanup_retry <rental_id> to retry\n`;

        // Split long message if needed
        if (message.length > 4000) {
            const chunks = message.match(/[\s\S]{1,4000}/g) || [];
            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }
        } else {
            await ctx.reply(message);
        }

    } catch (error) {
        logger.error(`Error in cleanup_failed: ${error.message}`);
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

// ============================================================================
// 5. MAIN STARTUP
// ============================================================================

async function main() {
    try {
        logger.info('🚀 Starting bot...');

        // Initialize database
        await getPool();
        logger.info('✓ Database connected');

        // Initialize cleanup system
        const { stopWorker } = await initializeCleanupSystem(bot);
        logger.info('✓ Cleanup system initialized');

        // Launch bot
        await bot.launch();
        logger.info('✓ Bot launched');

        // Graceful shutdown
        const shutdown = async () => {
            logger.info('🛑 Shutting down...');
            stopWorker();
            await bot.stop();
            process.exit(0);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        logger.error('Fatal error:', error);
        process.exit(1);
    }
}

// Start bot
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { bot };
