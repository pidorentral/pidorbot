# PidorBot

PidorBot is a Telegram admin bot for Steam/FunPay rental operations. It manages Steam account state, watches FunPay orders, handles account expiry and cleanup, processes review claims, and gives admins a single command surface for routine operations.

## What this project does

- Manages Steam account inventory and cookie state
- Monitors FunPay orders and parse lot/offer identifiers
- Handles rental expiry flow, cleanup, and retry scheduling
- Supports Steam account recovery and deauthorization workflows
- Provides Telegram admin UI for account management and operational checks
- Keeps sensitive FunPay credentials encrypted and stored in the database instead of only in `.env`

## Main system components

- `tgBot/tg.js` — Telegram UI and admin interaction layer
- `src/funpay/client.js` — FunPay session, key management, request layer
- `src/funpay/orderParser.js` — parses FunPay order markup and extracts offer/lot IDs
- `src/dao/*.js` — database read/write logic
- `steam/*.js` — Steam session recovery, cleanup, and password workflows
- `scripts/*.js` — maintenance and migration utilities
- `test/*.js` — regression tests for critical flows

## Requirements

- Node.js 20+
- PostgreSQL database
- Telegram bot token
- FunPay golden key or runtime key update via Telegram settings
- Playwright browser runtime for Steam/browser automation

## Quick start

1. Copy the example environment file:

```bash
copy .env.example .env
```

2. Fill in your real values in `.env`:

```env
BOT_TOKEN=your_telegram_bot_token
TG_ADMIN_IDS=123456789,987654321
DATABASE_URL=postgresql://user:password@host:5432/db
ENCRYPTION_KEY=your-32-byte-base64-or-hex-key

FUNPAY_GOLDEN_KEY=your_funpay_golden_key
FUNPAY_POLL_INTERVAL_MS=15000
FUNPAY_CHAT_POLL_MS=20000
FUNPAY_POLLING_ENABLED=true

RENTAL_RENEWAL_GRACE_MS=120000
RENTAL_EXPIRY_CHECK_MS=30000
RENTAL_CLEANUP_RETRY_INITIAL_MS=30000
RENTAL_CLEANUP_RETRY_MAX_MS=3600000
RENTAL_CLEANUP_LEASE_MS=75000

DEBUG_RENTAL_EXPIRY=false
ENABLE_PASSWORD_CHANGE=false
STEAM_BROWSER_PROFILE_DIR=
STEAM_BROWSER_HEADLESS=true
```

3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm start
```

The app boots through `bootstrap.js`, which starts the cleanup retry worker and then loads the main bot.

## Runtime configuration

The bot supports a secure runtime settings flow in Telegram:

- `/settings`
- `Update FunPay key`
- send the new golden key value
- the key is encrypted and stored in the `settings` table

The project uses encrypted storage for the active secret and applies it immediately to the live FunPay client. This avoids needing to edit `.env` every time the key rotates.

For local debugging only, the expiry-check script is protected by a hard gate:

```bash
$env:DEBUG_RENTAL_EXPIRY='true'
node scripts/debugRentalExpiry.js
```

Without this flag, the script exits immediately and does not create demo rent records in the database.

## Database requirements

The app expects PostgreSQL with the schema used by the DAO and migration scripts. Common operational scripts available via the package scripts include:

```bash
npm run db:create-indexes
npm run db:smoke
npm run funpay:check
npm run db:cleanup-retry
```

The core settings is stored in the `settings` table in the pattern:

- `key` — text primary key
- `value` — jsonb payload
- `updated_at` — timestamp

For FunPay key storage, the value is encrypted before persisting.

## Telegram commands

Common admin commands include:

- `/start` — home panel
- `/settings` — bot settings
- `/accs` — list accounts
- `/orders` — recent orders
- `/active_rentals` — active rentals
- `/cleanup_history` — cleanup attempts history
- `/offers` — account offer bindings
- `/claim_review` — review claim workflow
- `/reviews` — review queue

## Environment variables

Required or commonly used variables:

- `BOT_TOKEN` — Telegram bot token
- `TG_ADMIN_IDS` — admin Telegram user IDs, comma-separated
- `DATABASE_URL` — PostgreSQL connection string
- `ENCRYPTION_KEY` — AES key used for encrypted storage
- `FUNPAY_GOLDEN_KEY` — initial FunPay golden key or fallback value
- `FUNPAY_POLL_INTERVAL_MS` — FunPay order poll interval
- `FUNPAY_CHAT_POLL_MS` — chat polling interval
- `FUNPAY_POLLING_ENABLED` — enable polling loop
- `RENTAL_RENEWAL_GRACE_MS` — time window before expiry when renewal is considered
- `RENTAL_EXPIRY_CHECK_MS` — expiry watcher interval
- `RENTAL_CLEANUP_RETRY_INITIAL_MS` — initial cleanup retry backoff
- `RENTAL_CLEANUP_RETRY_MAX_MS` — maximum cleanup retry backoff
- `RENTAL_CLEANUP_LEASE_MS` — cleanup lease lifetime
- `DEBUG_RENTAL_EXPIRY` — debug-only gate for the expiry-check script, must be set to `true` manually
- `STEAM_BROWSER_PROFILE_DIR` — local Steam browser profile directory
- `STEAM_BROWSER_HEADLESS` — headless browser mode
- `ENABLE_PASSWORD_CHANGE` — optional password rotation flag

## Security notes

- Sensitive values are encrypted before storage
- Telegram admin access is restricted by `TG_ADMIN_IDS`
- The project avoids exposing raw secrets in user-facing messages
- Storage is DB-backed, which makes rotating keys and runtime updates much safer than manually editing a single `.env` variable on every change

## Testing

Run the project test suite:

```bash
npm test
```

The suite covers order parsing, account recovery, cleanup logic, and runtime validation guards.

## Project layout

```text
.
├── src/                     # core application logic
├── tgBot/                  # Telegram bot UI and callbacks
├── steam/                  # Steam recovery and cleanup routines
├── scripts/                # maintenance and migration utilities
├── test/                   # automated tests
├── .env.example            # sample environment configuration
├── bootstrap.js            # app bootstrap with singleton lock
├── main.js                 # app entrypoint
├── package.json            # scripts and dependencies
├── README.md               # project overview and setup guide
└── .gitignore              # repo ignore rules
```

## Notes

- The app intentionally keeps bot logic and business logic separated between Telegram flow, DB access, and Steam/FunPay service layers.
- Runtime updates are applied without restarting the process where supported, especially for the FunPay golden key.
- For local development, use `.env` and do not commit production secrets.
