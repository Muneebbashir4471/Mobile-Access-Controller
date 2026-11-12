# Runbook

## First deploy (EC2)

1. `t3.medium`, Ubuntu LTS, 30 GB, Elastic IP, region `ap-south-1` or `me-central-1`.
2. Security group inbound: TCP 80 (certificate issuance), TCP 443, UDP+TCP 3478, TCP 5349,
   UDP 49160–49200. SSH only from known addresses.
3. DNS: `phones.<domain>` and `turn.<domain>` → the Elastic IP.
4. Install Docker, clone the repo to `/opt/mt5`, `cp deploy/.env.example deploy/.env` and fill
   it in (values from SSM Parameter Store / Secrets Manager).
5. `cd deploy && docker compose up -d --build web api db cache`, then wait until
   `https://turn.<domain>` answers. That means Caddy has the certificate coturn needs.
6. `docker compose up -d turn`
7. Create the first admin:
   `docker compose exec api python -m app.cli create-admin you@example.com`
8. Nightly backup: `BACKUP_BUCKET=s3://… deploy/backup.sh` from cron (instance role needs S3 write).

## Routine

- **Certificate renewal**: Caddy renews automatically. coturn reads the certificate only at start,
  so a monthly `docker compose restart turn` (cron) keeps TLS on 5349 current.
- **Upgrade**: `git pull && docker compose up -d --build`. Migrations run when api starts. Phones
  reconnect on their own (spec N6).
- **Phone shows offline**: check the alert time, then the agent app's own screen, which shows the
  connection state and the reason.
- **Revoked a phone by mistake**: it keeps retrying every 60 s but cannot reconnect. Unpair it in
  the agent app and pair it again with a new code.

## Phone setup

1. Factory reset, skip the Google account, insert the SIM, enable USB debugging.
2. On the dashboard: Devices → Pair a new phone, and note the code.
3. `deploy/provision-phone.sh agent.apk https://phones.<domain> <CODE>`. This installs the agent,
   makes it device owner, enables accessibility, pre-approves screen capture, sets battery
   exemptions and permissions, keeps the screen on, turns Wi-Fi off, and pairs.
4. Do the manual steps the script prints (autostart on Xiaomi/Oppo/Vivo, Play auto-update off,
   MT5 accounts, reboot test).

The agent's own screen shows which checklist items are still missing.

## Agent updates

Bump `versionCode` and `versionName` in `agent-android/app/build.gradle.kts`, build a **signed
release** APK, and publish it on the dashboard (Devices → Agent app release). Online phones
without an open session install it at once; the rest within 6 hours. Device-owner phones install
silently. Always sign with the same key: Android refuses an update signed with a different one.

## Load test

```bash
cd server && .venv/bin/python -m loadtest.simulate --base https://phones.<domain> \
  --admin-email … --admin-password … --admin-totp-secret … --phones 30 --operators 10 --cleanup
```

This creates throwaway operator users (`lt…@loadtest.invalid`); disable them afterwards.
