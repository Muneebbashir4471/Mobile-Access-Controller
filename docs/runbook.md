# Runbook

## First deploy (EC2)

1. Ubuntu 24.04 ARM64 (`t4g.small` for testing, `t4g.medium` for ~30 phones), 20+ GB disk,
   Elastic IP.
2. Security group inbound: TCP 80 and 443 (dashboard, certificate issuance), UDP+TCP 3478 and
   UDP 49160–49200 (TURN video relay). SSH only from known addresses. AWS forwards every port to
   the instance, so the security group is the only gate. A server behind a NAT router also needs
   these ports forwarded, or video relay fails ("Opening…" never turns live).
3. DNS: an A record for the dashboard host (e.g. `dashboard.example.com`) → the Elastic IP.
4. Install Docker with Compose v2 (`sudo apt install docker.io docker-compose-v2`), clone the
   repo, `cp deploy/.env.example deploy/.env` and fill it in.
5. `cd deploy && docker compose -f docker-compose.yml --env-file .env up -d --build`
6. Check: `curl -s https://<DASHBOARD_HOST>/api/health` → `{"ok":true}`, and
   `docker compose -f docker-compose.yml --env-file .env logs --tail=20 turn` shows no
   "Address already in use". Run only one stack per server: a second (LAN) stack's coturn grabs
   port 3478.
7. Create the owner account, then sign in and turn on two-factor login under Settings (admins and
   superusers see no phones until they do):
   `docker compose -f docker-compose.yml --env-file .env exec api python -m app.cli create-superuser you@example.com`
8. Nightly backups: `cd deploy && ./install-backup-cron.sh` (add `BACKUP_BUCKET=s3://…` to copy
   them to S3; the instance role needs S3 write).

## Roles

- **superuser**: everything, including creating, editing and disabling admins and superusers.
- **admin**: all phones, pairing, devices; manages operators only (Settings → Users).
- **operator**: only the phones assigned to them.

Admins and superusers must use two-factor login (`REQUIRE_ADMIN_2FA`, on by default). If the only
superuser loses their authenticator, set `REQUIRE_ADMIN_2FA=false` in `.env`, restart the api,
sign in, fix the account, and set it back to `true`.

## Routine

- **Upgrade**: `git pull && docker compose -f docker-compose.yml --env-file .env up -d --build`.
  Migrations run when the api starts. Phones reconnect on their own.
- **Logs** are capped at 3 × 10 MB per container, so they cannot fill the disk.
- **Phone offline / stuck at 1 fps**: the dashboard shows an alert (and Telegram, if set). The
  agent app's own screen shows the connection state and what is missing.
- **Revoked a phone by mistake**: it keeps retrying every 60 s but cannot reconnect. Unpair it in
  the agent app and pair it again with a new code.

## Backups and restore

`deploy/backup.sh` writes `deploy/backups/mt5-<time>.dump` and keeps 14 days (`KEEP_DAYS`).
To restore one into the running stack:

```bash
cd deploy
docker compose -f docker-compose.yml --env-file .env exec -T db \
  pg_restore -U mt5 -d mt5 --clean --if-exists < backups/mt5-<time>.dump
docker compose -f docker-compose.yml --env-file .env restart api
```

## Phone setup

**Recommended for dedicated phones: Device Owner QR.** The agent becomes the phone's owner, so
Android cannot kill or uninstall it, the lock screen is off and permissions are granted for it.

1. On the server: `cd deploy && ./set-agent-apk.sh mt5-agent-<version>.apk <versionCode> <version>`
   (once per version; copy the APK to the server first).
2. Devices → **Device Owner setup QR**, optionally with the Wi-Fi name and password.
3. Factory-reset the phone, don't add a Google account, tap the first welcome screen 6 times,
   scan the QR. The phone downloads the agent, makes it owner and pairs itself.
4. Open the agent and turn on its Accessibility service (Android only allows this by hand).
   Screen capture permission is then accepted automatically.

Without a factory reset: install the APK, pair it (Devices → Pair a new phone) and follow
`docs/phone-setup.md`. With a cable: `deploy/provision-phone.sh`.

Prefer pairing phones to `https://<DASHBOARD_HOST>` (the pairing QR does this). Pairing to
`http://<PUBLIC_IP>` works but sends the device token and control messages unencrypted. Video is
always encrypted by WebRTC.

## Agent updates

The agent does not update itself. Bump `versionCode` and `versionName` in
`agent-android/app/build.gradle.kts`, run `agent-android/build-apk.sh`, and install the new
`releases/mt5-agent-<version>.apk` on each phone over the old one (pairing and settings survive).
Also run `deploy/set-agent-apk.sh` with it so new Device Owner setups get it. Every build is signed with
the same key; Android refuses an update signed with a different one.

## Load test

```bash
cd server && .venv/bin/python -m loadtest.simulate --base https://<DASHBOARD_HOST> \
  --admin-email … --admin-password … --admin-totp-secret … --phones 30 --operators 10 --cleanup
```

This creates throwaway operator users (`lt…@loadtest.invalid`); disable them afterwards. The
admin account needs two-factor login on, so pass its TOTP secret.
