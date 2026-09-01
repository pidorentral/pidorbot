# Steam Account Recoverer - Quick Reference

## Installation

```bash
npm install
# No additional packages needed - uses existing dependencies
```

## Files Created

| File | Purpose |
|------|---------|
| `steam/accountRecoverer.js` | Core password change & deauth logic |
| `rentals/steamCleanup.js` | Database integration layer |
| `docs/STEAM_ACCOUNT_RECOVERY.md` | Full documentation |
| `docs/STEAM_RECOVERY_INTEGRATION_EXAMPLES.js` | Integration examples |

## Core API

### Quick Execute
```javascript
import { recoverSteamAccount } from './steam/accountRecoverer.js';

const result = await recoverSteamAccount({
    login: 'username',
    oldPassword: 'current_pass',
    newPassword: 'new_pass',
    sharedSecret: 'base32_secret',
    cookies: { sessionid: '...', steamLoginSecure: '...' }
});
```

### Full Recovery Flow
```javascript
import { SteamAccountRecoverer } from './steam/accountRecoverer.js';

const recoverer = new SteamAccountRecoverer({
    login: 'username',
    oldPassword: 'current_pass',
    newPassword: 'new_pass',
    sharedSecret: 'base32_secret',
    cookies: { sessionid: '...', steamLoginSecure: '...' }
});

const result = await recoverer.executeRecovery();
console.log(result.completedSteps);  // Array of completed steps
console.log(result.success);         // boolean
```

### With Database Integration
```javascript
import { createRentalCleanup } from './rentals/steamCleanup.js';

const cleanup = createRentalCleanup(db, logger);

const result = await cleanup.cleanupRental({
    id: 123,
    accountId: 45,
    login: 'username',
    mafilePayload: '...',
    sessionCookies: '...'
});
```

## Environment Variables

```bash
STEAM_SESSION_LOGOUT_ENABLED=true      # Enable device deauth
STEAM_PASSWORD_CHANGE_ENABLED=true     # Enable password change
```

Both must be `true` for cleanup to work.

## Execution Steps (In Order)

1. ✅ **Get RSA Key** - Retrieve Steam's public encryption key
2. ✅ **Init Wizard** - Start password recovery process
3. ✅ **Request 2FA** - Ask for mobile auth code
4. ✅ **Confirm 2FA** - Submit generated Steam Guard code
5. ✅ **Verify Old PW** - Prove account ownership with current password
6. ✅ **Set New PW** - Change password to new value
7. ✅ **Deauth Devices** - Force logout from all devices

## Error Handling

```javascript
import { SteamPasswordChangeError } from './steam/accountRecoverer.js';

try {
    await recoverer.executeRecovery();
} catch (error) {
    if (error instanceof SteamPasswordChangeError) {
        console.error('Status:', error.statusCode);
        console.error('Details:', error.responseBody);
    }
}
```

## Result Object

```javascript
{
    success: true,                           // Overall success
    completedSteps: [                        // Array of completed steps
        "Getting RSA key",
        "Initializing recovery wizard",
        "Requesting 2FA code",
        "Confirming 2FA code",
        "Verifying old password",
        "Setting new password",
        "Deauthorizing all devices"
    ],
    failedStep: null,                        // Which step failed (if any)
    error: null,                             // Error message (if any)
    account: "username",                     // Account that was processed
    timestamp: "2024-08-25T10:30:45.123Z"   // When it completed
}
```

## Configuration Options

```javascript
new SteamAccountRecoverer({
    login: 'username',              // Required: Steam username
    oldPassword: 'current_pass',    // Required: Current password
    newPassword: 'new_pass',        // Required: New password
    sharedSecret: 'base32_secret',  // Required: From mafile
    cookies: {},                    // Required: Active session cookies
    userAgent: 'Chrome/...',        // Optional: User-Agent string
    timeout: 15000,                 // Optional: Request timeout (ms)
    maxRetries: 10,                 // Optional: 2FA retry attempts
})
```

## Database Schema

```sql
-- Cleanup logs table (optional)
CREATE TABLE rental_cleanup_logs (
    id SERIAL PRIMARY KEY,
    rental_id INTEGER NOT NULL,
    account_id INTEGER,
    login VARCHAR(255),
    success BOOLEAN NOT NULL,
    message TEXT,
    details JSONB,
    error_details TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Integration Point Example

```javascript
// In your rental expiry handler (e.g., rentalExpiry.js)
async function onRentalEnd(rentalId) {
    // 1. Do existing expiry logic
    // 2. Clean up the account
    const result = await processRentalExpiryWithCleanup(rentalId);
    // 3. Handle result
}
```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "2FA confirmation failed" | Verify shared_secret, check system clock |
| "Old password verification failed" | Confirm password is correct, check for special chars |
| "RSA key not available" | Check network, verify Steam API is accessible |
| "sessionid cookie is required" | Session expired, need to refresh cookies first |
| "Failed to parse mafile" | Verify mafile is valid JSON, check decryption |

## Security Checklist

- [ ] Store cookies in encrypted database
- [ ] Don't log passwords or secrets
- [ ] Rotate User-Agent periodically
- [ ] Use HTTPS only
- [ ] Verify shared_secret from encrypted mafile
- [ ] Rate limit cleanup operations
- [ ] Monitor cleanup logs for failures
- [ ] Don't store temporary passwords
- [ ] Use secure password generation

## Testing

```bash
# Run tests
npm test

# Specific test file
npm test test/accountRecoverer.test.js
```

## Debugging

Enable verbose logging:
```javascript
const recoverer = new SteamAccountRecoverer(config);
// Will log each step with timestamps
const result = await recoverer.executeRecovery();
```

## Rate Limiting Notes

Steam may throttle or rate-limit:
- Multiple password changes from same IP
- Rapid successive 2FA attempts
- Too many simultaneous operations

Solution:
- Space operations by 2-5 seconds
- Process cleanups sequentially, not in parallel
- Implement exponential backoff for retries
- Monitor for 429 (Too Many Requests) responses

## What Gets Cleaned

✅ **Password changed** - Old password becomes invalid
✅ **All sessions deauth** - Logged out from all devices globally
✅ **Mobile app logout** - Steam app on phones disconnected
✅ **Browser sessions invalidated** - All active steam.com sessions end
✅ **Device tokens refreshed** - Old session cookies become useless

## What You Need to Provide

- `login` - Steam account username
- `oldPassword` - Current password (decrypt from DB if needed)
- `newPassword` - New secure password (generate it yourself)
- `sharedSecret` - From decrypted mafile (base32 format)
- `cookies` - Active session cookies (sessionid, steamLoginSecure, etc.)

## Next Steps After Cleanup

1. Update rental status to 'cleaned' in database
2. Optional: Update account password_changed_at timestamp
3. Optional: Log results to cleanup_logs table
4. Optional: Notify admin of completion
5. Optional: Archive rental for audit trail

## Performance

- Typical cleanup time: 15-30 seconds
- Network timeout: 15-20 seconds
- 2FA confirmation: Usually <5 seconds
- Worst case: 2-3 minutes (with retries)

## Production Deployment

1. Test with sandbox account
2. Verify environment variables set
3. Create database tables for logging
4. Implement retry mechanism for failed cleanups
5. Set up monitoring/alerting
6. Deploy with process manager (PM2, etc.)
7. Monitor cleanup logs for errors
8. Periodic manual audits

## Support & Troubleshooting

See `docs/STEAM_ACCOUNT_RECOVERY.md` for full documentation.
See `docs/STEAM_RECOVERY_INTEGRATION_EXAMPLES.js` for code examples.
