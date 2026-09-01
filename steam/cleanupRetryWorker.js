/**
 * Cleanup Retry Worker
 * @description Periodic worker that processes pending cleanup retries
 * Run this in a separate process or interval
 */

import { processPendingCleanupRetries, getCleanupStats } from './cleanupRetry.js';

let isRunning = false;
let lastRunTime = null;

/**
 * Start the cleanup retry worker
 * Processes pending retries every minute
 * @param {Object} logger - Logger instance
 * @param {number} [intervalMs=60000] - Check interval in milliseconds
 * @returns {Function} Function to stop the worker
 */
export function startCleanupRetryWorker(logger = console, intervalMs = 60000) {
    if (isRunning) {
        logger.warn('Cleanup retry worker is already running');
        return () => {};
    }

    isRunning = true;
    logger.info('[Cleanup Retry Worker] Started');

    const intervalId = setInterval(async () => {
        // Prevent overlapping runs
        if (lastRunTime && Date.now() - lastRunTime < intervalMs) {
            return;
        }

        try {
            lastRunTime = Date.now();

            const result = await processPendingCleanupRetries(logger);

            if (result.processedCount > 0) {
                logger.info(
                    `[Cleanup Retry Worker] Processed ${result.processedCount} retries: ` +
                    `${result.successCount} success, ${result.failedCount} failed`
                );
            }

            // Log stats every 10 runs
            if (result.processedCount > 0 && Math.random() < 0.1) {
                const stats = await getCleanupStats();
                logger.info(`[Cleanup Stats] Successful: ${stats.successful}, ` +
                    `Pending: ${stats.pending_retry}, Failed: ${stats.failed_permanent}`);
            }

        } catch (error) {
            logger.error(`[Cleanup Retry Worker] Fatal error: ${error.message}`);
        }
    }, intervalMs);

    // Return stop function
    return () => {
        isRunning = false;
        clearInterval(intervalId);
        logger.info('[Cleanup Retry Worker] Stopped');
    };
}

/**
 * Example: Integrate with your main bot
 */
export function initializeCleanupRetryWorker(logger) {
    // Start worker in the background
    const stopWorker = startCleanupRetryWorker(logger, 60000); // Check every minute

    // Store stop function for graceful shutdown
    return stopWorker;
}
