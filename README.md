# pidorbot

Super mega cool auto rent bot for FunPay.

## Overview

`pidorbot` automates rental order management, review bonus claims, and review verification for FunPay account rentals.

## Features

- Telegram bot for users and admins
- Review bonus claim flow with manual and automated verification
- Database audit logging for review approvals and rejections
- Title-based account matching for new rentals
- CI workflow with PostgreSQL and `DATABASE_URL`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables in `.env`:

```env
DATABASE_URL=postgres://user:pass@host:5432/dbname
BOT_TOKEN=<telegram-bot-token>
ADMIN_IDS=<comma-separated-admin-ids>
```

3. Run database migrations:

```bash
node scripts/createIndexes.js
node scripts/createReviewsTable.js
node scripts/createReviewAuditsTable.js
```

4. Start the bot:

```bash
node main.js
```

## Review bonus workflow

1. User submits a review claim with `/claim_review`.
2. The claim is stored in `reviews` as pending.
3. Admins review pending claims using `/reviews`.
4. Admins can `Auto-check`, `Confirm`, or `Reject` claims.
5. When confirmed, the rental is extended by 1 hour and the bonus is recorded.

## Admin instructions

See `ADMIN_INSTRUCTIONS.md` for detailed admin workflow and review handling.

## Testing

Run tests with:

```bash
npm test
```

If `DATABASE_URL` is missing, DB-dependent tests will skip.

## CI

The repository includes GitHub Actions workflow at `.github/workflows/ci.yml`.
It runs PostgreSQL, migrations, and tests on push.

## Notes

- The bot uses `tgBot/tg.js` for Telegram interaction.
- Review verification is logged in `review_audits` for accountability.
- Duplicate verification attempts are safe and do not grant duplicate bonuses.
