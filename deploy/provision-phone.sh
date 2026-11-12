#!/usr/bin/env bash
# Provision one phone over USB, following the spec's phone setup checklist.
#
#   deploy/provision-phone.sh path/to/agent.apk https://phones.example.com PAIRCODE [adb-serial]
#   KEEP_WIFI=1 deploy/provision-phone.sh …   # local test server on your Wi-Fi
#
# Before running: factory reset, skip the Google account, insert the SIM, enable developer
# options and USB debugging. After running: install MT5 and log in to this phone's accounts,
# then record its accounts on the dashboard's Devices page.
set -euo pipefail

APK="${1:?agent APK path}"
SERVER="${2:?server URL, e.g. https://phones.example.com}"
CODE="${3:?pairing code from the dashboard}"
SERIAL="${4:-}"
PKG=com.yourorg.agent
ADB=(adb ${SERIAL:+-s "$SERIAL"})

say() { printf '\n== %s\n' "$*"; }
try() { "$@" || echo "   (not supported on this phone: $*)"; }

say "Phone: $("${ADB[@]}" shell getprop ro.product.manufacturer) $("${ADB[@]}" shell getprop ro.product.model), Android $("${ADB[@]}" shell getprop ro.build.version.release)"

say "Installing agent"
"${ADB[@]}" install -r -g "$APK"

say "Making the agent device owner (fails if any account is on the phone)"
"${ADB[@]}" shell dpm set-device-owner "$PKG/.AdminReceiver"

say "Enabling the accessibility service (remote input)"
"${ADB[@]}" shell settings put secure enabled_accessibility_services "$PKG/$PKG.InputService"
"${ADB[@]}" shell settings put secure accessibility_enabled 1

say "Pre-approving screen capture (skips the consent dialog on many builds; check on each model)"
try "${ADB[@]}" shell appops set "$PKG" PROJECT_MEDIA allow

say "Battery: exempt from Doze and background limits"
try "${ADB[@]}" shell dumpsys deviceidle whitelist +"$PKG"
try "${ADB[@]}" shell cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow
try "${ADB[@]}" shell cmd appops set "$PKG" RUN_IN_BACKGROUND allow
try "${ADB[@]}" shell am set-standby-bucket "$PKG" active

say "Runtime permissions"
for p in READ_PHONE_STATE POST_NOTIFICATIONS CAMERA; do
  try "${ADB[@]}" shell pm grant "$PKG" "android.permission.$p"
done

say "Screen stays on while charging, no screen lock"
"${ADB[@]}" shell settings put global stay_on_while_plugged_in 7
try "${ADB[@]}" shell locksettings set-disabled true
if [[ "${KEEP_WIFI:-0}" == "1" ]]; then
  echo "   KEEP_WIFI=1: leaving Wi-Fi on (local test server). Turn it off for production."
else
  say "Wi-Fi off (trades must use SIM data)"
  try "${ADB[@]}" shell svc wifi disable
fi

say "Pairing with $SERVER"
"${ADB[@]}" shell am start -n "$PKG/.PairingActivity" --es server "$SERVER" --es code "$CODE"

cat <<MSG

Done with the automatic steps. Still to do by hand:
  - Xiaomi / Oppo / Vivo: allow Autostart for "MT5 Agent" in the phone's security app
  - Play Store: turn off automatic app updates (keeps MT5 from updating mid-session)
  - Install MT5 and log in to this phone's accounts
  - Reboot ("${ADB[*]} reboot") and confirm the phone comes back online on the dashboard
  - Record name, SIM carrier and accounts on the Devices page
MSG
