# Steam Account Recoverer - Installation & Integration Guide

## Dependencies Installation

Add the required npm packages to your `package.json`:

```bash
npm install crypto-js big-integer
```

Or if using yarn:
```bash
yarn add crypto-js big-integer
```

### Dependencies (already included):
- `steam-totp` - For generating Steam Guard codes (2FA)
- `pg` - PostgreSQL database adapter
- Node.js built-in `crypto` module
- Node.js built-in `fetch` (Node 18+)

## Quick Start

### Basic Usage

```javascript
import { SteamAccountRecoverer } from './steam/accountRecoverer.js';

// Step 1: Get current cookies and session data
const cookies = {
    sessionid: '...',
    steamLoginSecure: '...',
    // other cookies from active session
};

// Step 2: Create recoverer instance
const recoverer = new SteamAccountRecoverer({
    login: 'account_username',
    oldPassword: 'current_password',
    newPassword: 'new_secure_password',
    sharedSecret: 'base32_encoded_secret_from_mafile',
    cookies: cookies,
});

// Step 3: Execute recovery
try {
    const result = await recoverer.executeRecovery();
    console.log('✓ Account recovery completed:', result);
} catch (error) {
    console.error('✗ Recovery failed:', error.message);
}
```

### Integration with Rental Cleanup

```javascript
import { SteamRentalCleanup, createRentalCleanup } from './rentals/steamCleanup.js';
import { db } from './src/db.js';

// Initialize cleanup service
const cleanup = createRentalCleanup(db, console);

// When rental ends
async function handleRentalExpiry(rentalId) {
    const rental = await db.query(
        'SELECT id, account_id, login, mafile_payload, session_cookies FROM rentals WHERE id = $1',
        [rentalId]
    );

    const result = await cleanup.cleanupRental(rental.rows[0]);
    
    if (result.success) {
        // Update rental status in DB
        await db.query(
            'UPDATE rentals SET status = $1, cleaned_at = NOW() WHERE id = $2',
            ['cleaned', rentalId]
        );
    } else {
        // Log failure and retry later
        console.error('Cleanup failed, will retry:', result.error);
    }
}
```

## Architecture

### `SteamAccountRecoverer` Class

Main class that handles the complete password change and session deauthorization flow.

**Key Methods:**
- `executeRecovery()` - Runs complete recovery flow
- `_makeRequest()` - Handles HTTP requests with cookie management
- `_encryptPassword()` - RSA password encryption
- `_getRSAKey()` - Retrieves Steam's RSA public key
- `_confirmTwoFactor()` - 2FA code generation and confirmation
- `_setNewPassword()` - Password change via recovery wizard
- `_deauthorizeAllDevices()` - Force logout from all devices

**Configuration Options:**
```javascript
{
    login: 'string',              // Steam username
    oldPassword: 'string',        // Current password
    newPassword: 'string',        // New password to set
    sharedSecret: 'string',       // From mafile for 2FA
    cookies: {},                  // Active session cookies
    userAgent: 'string',          // Optional, defaults to Chrome UA
    timeout: 15000,               // Request timeout (ms)
    maxRetries: 10,               // 2FA confirmation retries
}
```

### Error Handling

All errors inherit from `SteamPasswordChangeError`:

```javascript
import { SteamPasswordChangeError } from './steam/accountRecoverer.js';

try {
    await recoverer.executeRecovery();
} catch (error) {
    if (error instanceof SteamPasswordChangeError) {
        console.error('Status:', error.statusCode);
        console.error('Response:', error.responseBody);
        console.error('Message:', error.message);
    }
}
```

## Execution Flow

The recovery process follows these exact steps:

1. **Get RSA Key** - Retrieve Steam's public RSA key for password encryption
2. **Initialize Wizard** - Start password recovery process and get session parameters
3. **Request 2FA Code** - Ask Steam to send code to mobile authenticator
4. **Confirm 2FA** - Submit generated Steam Guard code
5. **Verify Old Password** - Confirm current password to prove ownership
6. **Set New Password** - Change password to new value
7. **Deauthorize Devices** - Force logout from all devices globally

Each step must complete successfully before proceeding to the next.

## Database Integration

Create table for cleanup logs (optional but recommended):

```sql
CREATE TABLE IF NOT EXISTS cleanup_logs (
    id SERIAL PRIMARY KEY,
    rental_id INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    message TEXT,
    completed_steps JSONB,
    error_details TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (rental_id) REFERENCES rentals(id)
);

CREATE INDEX idx_cleanup_logs_rental_id ON cleanup_logs(rental_id);
CREATE INDEX idx_cleanup_logs_created_at ON cleanup_logs(created_at DESC);
```

## Production Deployment Checklist

- [ ] Verify Node.js version is 18+ (for native fetch)
- [ ] Install all dependencies: `npm install`
- [ ] Set environment variables:
  - `STEAM_SESSION_LOGOUT_ENABLED=true`
  - `STEAM_PASSWORD_CHANGE_ENABLED=true`
- [ ] Test with sandbox account first
- [ ] Implement retry logic for failed cleanups
- [ ] Monitor cleanup logs for errors
- [ ] Add alerting for failed password changes
- [ ] Ensure mafile decryption keys are secure
- [ ] Test with actual rental expiry workflow

## Security Notes

1. **Password Storage**: Temporary passwords should NOT be stored permanently
2. **Cookies**: Always use HTTPS cookies, store securely in database
3. **Shared Secrets**: Encrypt mafile data at rest in database
4. **User-Agent**: Rotate UA periodically to avoid detection
5. **Rate Limiting**: Space out recovery operations to avoid Steam throttling
6. **Logging**: Never log passwords or secrets to console/files

## Troubleshooting

### "2FA confirmation failed"
- Verify shared_secret is correct base32 value
- Check system time is synchronized (time-based codes are sensitive)
- Increase `maxRetries` option if codes are expiring too quickly

### "Old password verification failed"
- Confirm password is correct
- Check for special characters that might need escaping
- Verify password hasn't been changed externally

### "RSA key not available"
- Network connectivity issue during key retrieval
- Steam API might be down
- Check Referer headers are correct

### "sessionid cookie is required"
- Session has expired
- Need to refresh authentication before cleanup
- Implement cookie refresh mechanism

## Testing

```javascript
// test/accountRecoverer.test.js
import { SteamAccountRecoverer } from '../steam/accountRecoverer.js';

const config = {
    login: 'testaccount',
    oldPassword: 'oldpass123',
    newPassword: 'newpass456!@#',
    sharedSecret: 'JBSWY3DPEBLW64TMMQ======', // example
    cookies: {
        sessionid: 'test_session_id',
        steamLoginSecure: 'test_login_secure',
    },
};

const recoverer = new SteamAccountRecoverer(config);
const result = await recoverer.executeRecovery();
console.assert(result.success, 'Recovery should succeed');
```

## API Reference

### SteamAccountRecoverer

```javascript
class SteamAccountRecoverer {
    constructor(config: {
        login: string,
        oldPassword: string,
        newPassword: string,
        sharedSecret: string,
        cookies: Record<string, string>,
        userAgent?: string,
        timeout?: number,
        maxRetries?: number,
    })
    
    async executeRecovery(): Promise<{
        success: boolean,
        completedSteps: string[],
        failedStep: string | null,
        error: string | null,
        account: string,
        timestamp: string,
    }>
}
```

### SteamRentalCleanup

```javascript
class SteamRentalCleanup {
    constructor(config: {
        db: PgPool,
        logger?: Logger,
        enabled?: boolean,
        timeoutMs?: number,
    })
    
    async cleanupRental(rental: {
        id: number,
        accountId: string,
        login: string,
        mafilePayload: string,
        sessionCookies: string,
    }): Promise<{
        success: boolean,
        rentalId: number,
        login: string,
        completedSteps?: string[],
        error?: string,
        timestamp: string,
    }>
}
```

## License & Support

This implementation is production-ready and follows Steam's API requirements. For issues or questions about integration, review the attached source files or consult Steam documentation.
