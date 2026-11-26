# Backup & Restore Runbook

## 1. Recovery Objectives
- **RPO (Recovery Point Objective):** <= 5 minutes (MongoDB Atlas Continuous Cloud Backup with oplog tailing).
- **RTO (Recovery Time Objective):** <= 30 minutes (automated snapshot restore to a new/target Atlas cluster + DNS/env switch).

## 2. Atlas Backup Configuration
- Enable **Continuous Cloud Backup** on the production MongoDB Atlas M10+ cluster:
  - Hourly snapshots retained for 2 days
  - Daily snapshots retained for 7 days
  - Weekly snapshots retained for 4 weeks
  - Point-in-time recovery (oplog) window: 24 hours
- Ensure Atlas Encryption at Rest (AWS KMS / Customer-Managed Key) is enabled for all volumes and snapshots.

## 3. Field-Level Encryption vs Message Text Decision
- **Encrypted at application level (AES-256-GCM with `keyId` rotation):** TOTP secrets (`User.twoFactorSecretEnc`) and moderation report notes (`Report.noteEnc`).
- **Not encrypted at application level:** `Message.text`. Relying on MongoDB Atlas encryption at rest preserves server-side message search, cursor indexing, and AI summaries; application-level encryption of message text would break search without protecting against a compromised API node that holds the decryption key.

## 4. Restore Drill Procedure
1. Dump or download a snapshot from Atlas (or local `mongodump --uri="$PROD_URI" --out=./backup-drill`).
2. Restore into a scratch MongoDB instance:
   ```bash
   mongorestore --uri="mongodb://127.0.0.1:27017/chat-app-restore-drill" --drop ./backup-drill/chat-app
   ```
3. Run the verification script against the scratch database:
   ```bash
   cd server
   BACKUP_VERIFY_URI="mongodb://127.0.0.1:27017/chat-app-restore-drill" node src/scripts/verifyBackup.js
   ```
4. Confirm document counts, sample user integrity, and required indexes (`usernameLower`, `{ room: 1, createdAt: -1 }`).
