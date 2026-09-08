import { SteamAccountRecoverer, SteamPasswordChangeError } from '../steam/accountRecoverer.js';

/**
 * Steam Rental Cleanup - integrates account recovery into rental end workflow
 * @description Handles password change and device deauthorization when a rental ends
 */
export class SteamRentalCleanup {
    /**
     * @param {Object} config
     * @param {Object} config.db - Database connection pool
     * @param {Object} config.logger - Logger instance
     * @param {boolean} [config.enabled] - Whether cleanup is enabled (default: true)
     * @param {number} [config.timeoutMs] - Request timeout in milliseconds (default: 15000)
     */
    constructor(config) {
        this.db = config.db;
        this.logger = config.logger || console;
        this.enabled = config.enabled !== false;
        this.timeoutMs = config.timeoutMs || 15000;
    }

    /**
     * Execute cleanup for a rental that has ended
     * @param {Object} rental - Rental object
     * @param {number} rental.id - Rental ID
     * @param {string} rental.accountId - Account ID in database
     * @param {string} rental.login - Steam login
     * @param {string} rental.mafilePayload - Encrypted mafile JSON
     * @param {string} rental.sessionCookies - Current session cookies JSON
     * @returns {Promise<Object>} Cleanup result
     */
    async cleanupRental(rental) {
        if (!this.enabled) {
            this.logger.warn(`Cleanup disabled - skipping rental ${rental.id}`);
            return { success: false, reason: 'cleanup_disabled' };
        }

        try {
            this.logger.info(`Starting cleanup for rental ${rental.id} (${rental.login})`);

            // Decrypt mafile payload
            const mafile = await this._decryptMafile(rental.mafilePayload);

            // Parse cookies
            const cookies = this._parseCookies(rental.sessionCookies);

            // Validate required data
            if (!mafile.shared_secret) {
                throw new Error('shared_secret missing from mafile');
            }

            if (!cookies.sessionid || !cookies.steamLoginSecure) {
                throw new Error('Required cookies missing (sessionid, steamLoginSecure)');
            }

            // Execute account recovery
            const recoverer = new SteamAccountRecoverer({
                login: rental.login,
                oldPassword: rental.currentPassword, // Must be provided separately or fetched
                newPassword: null,
                passwordChangeEnabled: false,
                sharedSecret: mafile.shared_secret,
                cookies: cookies,
                timeout: this.timeoutMs,
            });

            const result = await recoverer.executeRecovery();

            // Log successful cleanup
            await this._logCleanupSuccess(rental.id, result);

            this.logger.info(`✓ Cleanup completed for rental ${rental.id}`);

            return {
                success: true,
                rentalId: rental.id,
                login: rental.login,
                completedSteps: result.completedSteps,
                timestamp: result.timestamp,
            };
        } catch (error) {
            this.logger.error(`✗ Cleanup failed for rental ${rental.id}: ${error.message}`);

            // Log failed cleanup attempt
            await this._logCleanupFailure(rental.id, error);

            return {
                success: false,
                rentalId: rental.id,
                login: rental.login,
                error: error.message,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * Decrypt mafile from database payload
     * @private
     * @param {string} encryptedPayload - Encrypted mafile JSON
     * @returns {Promise<Object>} Parsed mafile object
     */
    async _decryptMafile(encryptedPayload) {
        // This should use your existing encryption/decryption logic
        // For now, assume it's stored as JSON string
        try {
            return JSON.parse(encryptedPayload);
        } catch {
            throw new Error('Failed to parse mafile');
        }
    }

    /**
     * Parse cookies from database storage
     * @private
     * @param {string|Object} cookiesData - Cookies as JSON string or object
     * @returns {Object} Parsed cookies object
     */
    _parseCookies(cookiesData) {
        if (typeof cookiesData === 'string') {
            try {
                return JSON.parse(cookiesData);
            } catch {
                throw new Error('Failed to parse cookies');
            }
        }
        return cookiesData || {};
    }

    /**
     * Generate a cryptographically secure temporary password
     * @private
     * @returns {string} Random password (24 characters)
     */
    _generateTemporaryPassword() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let password = '';
        const randomValues = new Uint8Array(24);
        crypto.getRandomValues(randomValues);

        for (let i = 0; i < 24; i++) {
            password += chars[randomValues[i] % chars.length];
        }

        return password;
    }

    /**
     * Log successful cleanup to database
     * @private
     * @param {number} rentalId - Rental ID
     * @param {Object} result - Cleanup result
     */
    async _logCleanupSuccess(rentalId, result) {
        try {
            await this.db.query(
                `INSERT INTO cleanup_logs (rental_id, success, message, completed_steps, created_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [rentalId, true, 'Cleanup completed successfully', JSON.stringify(result.completedSteps)]
            );
        } catch (error) {
            this.logger.error(`Failed to log cleanup success: ${error.message}`);
        }
    }

    /**
     * Log failed cleanup to database
     * @private
     * @param {number} rentalId - Rental ID
     * @param {Error} error - Error that occurred
     */
    async _logCleanupFailure(rentalId, error) {
        try {
            await this.db.query(
                `INSERT INTO cleanup_logs (rental_id, success, message, error_details, created_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [rentalId, false, 'Cleanup failed', error.message]
            );
        } catch (dbError) {
            this.logger.error(`Failed to log cleanup failure: ${dbError.message}`);
        }
    }
}

/**
 * Create cleanup instance with database integration
 * @param {Object} db - Database pool instance
 * @param {Object} [logger] - Logger instance (defaults to console)
 * @returns {SteamRentalCleanup} Cleanup instance
 */
export function createRentalCleanup(db, logger) {
    return new SteamRentalCleanup({
        db,
        logger,
        // Device deauthorization is always the cleanup action; password rotation is opt-in inside the recoverer.
        enabled: process.env.STEAM_SESSION_LOGOUT_ENABLED !== 'false',
    });
}
