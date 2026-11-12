# Setting up a phone by hand (after installing mt5-agent.apk)

Do these once per phone, in this order. Menu names are from OnePlus / OxygenOS. Other brands
use similar names.

## 1. Pair
1. Open **MT5 Agent**.
2. On the dashboard: **Devices → Pair a new phone**.
3. In the app: **Scan pairing QR**, or type the server address and the code.
4. The app shows **● Online**.

## 2. Allow "restricted settings" (Android 13 and newer, needed for step 3)
Android blocks accessibility for apps installed from an APK file until you allow it.
1. **Settings → Apps → MT5 Agent** (or long-press the app icon → App info).
2. Tap **⋮** (top right) → **Allow restricted settings** → confirm with your PIN.

If you don't see the ⋮ option, do step 3 once first: the switch shows a "Restricted setting"
message, and the option then appears.

## 3. Turn on the accessibility service (taps, typing, wake and unlock)
1. **Settings → Additional settings → Accessibility → Downloaded apps → MT5 Agent**
   (or the app's checklist: **Accessibility service → Fix**).
2. Turn it **on** and accept.

The app's checklist then shows ✓ Accessibility service. **Without this, clicks in the dashboard do
nothing.**

## 4. Allow screen capture
- In the app: **Screen capture running → Fix**, then **Start now**. If Android asks, choose
  **Entire screen**, not a single app.
- With accessibility on, the app accepts this prompt by itself after a restart.

## 5. Stop OnePlus from killing the app (this is what loses the screen share when minimized)
1. **Settings → Apps → MT5 Agent → Battery → Unrestricted** (or "Allow background activity").
2. **Settings → Apps → MT5 Agent**: turn on **Auto launch** / "Allow auto-start" if present.
3. Open the recent apps view, tap the MT5 Agent card's menu (or pull it down) → **Lock**. A lock
   icon appears, and "Clear all" no longer kills it.
4. In the app: **Exempt from battery optimisation → Fix → Allow**.
5. Allow **notifications** (the app's checklist).

Never swipe MT5 Agent away from recents. Minimizing it with Home is fine.

## 6. Screen and lock
- **Recommended for dedicated trading phones:** Settings → Security → **Screen lock → None**,
  and keep the phone on a charger. Developer options → **Stay awake** keeps the screen on while
  charging.
- If you keep a lock:
  - **Swipe** is woken and dismissed automatically when an operator opens the phone.
  - **PIN / password:** the operator types it in the dashboard's **Unlock** box.
  - **Pattern** cannot be entered remotely. Use a PIN instead.

## 7. Check from the dashboard
Phone card: online, no "no capture / no input / screen off" warnings. Open it: you see the screen,
and taps work. Then reboot the phone and confirm it comes back by itself.

## Easier: the setup script
On a factory-reset phone with no Google account and USB debugging on, run
`deploy/provision-phone.sh`. It does steps 1–6 automatically (it makes the app device owner and
turns the accessibility service on directly, so step 2 is not needed).
