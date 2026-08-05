# Admin Instructions

This document describes how administrators should process review bonus claims and manage the review workflow.

## Review bonus flow

1. A user submits a review claim using the bot command `/claim_review`.
2. The user is asked for:
   - FunPay order ID
   - review link (optional)
   - review text or excerpt
   - rating (optional)
3. The claim is saved in the `reviews` table as pending.
4. Admins receive a Telegram notification with the new review claim and a button to open it.
5. Admins process the claim using the bot command `/reviews`.

## Bot admin review flow

Use the Telegram bot with your admin account.

### /reviews

Shows pending review claims.

### Open review

When you open a review, you can:
- press `Auto-check` to run the automated FunPay verifier
- press `Confirm` to manually approve and grant the bonus
- press `Reject` to deny the claim

### Auto-check behavior

The bot attempts to verify the claim automatically for FunPay reviews by checking:
- FunPay order ID in the review link
- buyer or submitter username in the attached content
- optional review text on the FunPay order page

If auto-check confidence is high, it can automatically approve the claim.
If it is low, it will keep the review pending for manual confirmation.

### Manual confirmation

If you press `Confirm`, the system will:
- extend the active rental for the order by 1 hour
- mark the review as verified in `reviews.verified_at`
- write an audit row to `review_audits`

### Rejecting a claim

If you press `Reject`, the system will:
- mark the review as rejected in `reviews.verified_at`
- write an audit row to `review_audits`

## Audit records

Audit rows are written to `review_audits` with:
- `review_id`
- `action` (`verify` or `reject`)
- `performed_by`
- `details`
- `performed_at`

## Database migrations

If the review system is not yet migrated, run:

```bash
node scripts/createReviewsTable.js
node scripts/createReviewAuditsTable.js
```

These scripts create the `reviews` and `review_audits` tables.

## Troubleshooting

- If a review is already verified, attempting to verify again is idempotent and will not grant bonus twice.
- If a claim should be rejected, use `Reject` and provide the reason in the audit metadata.
- If the FunPay page check fails, confirm manually.
