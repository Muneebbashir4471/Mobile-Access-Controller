# Pilot (milestone 0) and real-phone acceptance checks

Every milestone in the spec ends with a check on real phones over SIM data. The code for all of
them is written; these checks are what turns "written" into "done". Record results per phone model.

## Milestone 0: RustDesk pilot (2–3 days, the go / no-go gate)

Goal: learn the real delay, data use and how often a phone needs a hand, before trusting the design.

1. On a small EC2 instance in the chosen region, run the RustDesk server:
   `docker run -d --name hbbs --net=host rustdesk/rustdesk-server hbbs` and
   `docker run -d --name hbbr --net=host rustdesk/rustdesk-server hbbr`
   (open TCP 21115–21119 and UDP 21116 in the security group).
2. Install the RustDesk app on 3 phones (different models if the fleet is mixed). Point it at the
   server's ID/relay address and key, enable its accessibility and screen-capture permissions.
3. Wi-Fi off. Use each phone from a browser/desktop client over SIM data for several days.
4. Record, per phone:

| Measure | How | Pass |
|---|---|---|
| Tap-to-screen delay | Tap the MT5 clock area; time the change on a phone stopwatch filmed with the screen | under 500 ms on normal 4G |
| Data per hour of control | Android Settings → Data usage, before/after a 1-hour session | about 0.5 GB/h or less |
| Unattended reboots | Reboot 5 times; count how often someone must touch the phone to reconnect | 0 needed (or a known, fixable cause) |
| MT5 secure screens | Open MT5 login, password, trade screens; note any black screen | none black, or list the screens |
| Overnight survival | Leave 3 nights; is it reachable each morning? | yes every time |

**Decision:** if phones cannot stay reachable unattended on your models, change the design before
building further (spec fallback: USB host nodes for the control path).

## Milestone 1: agent skeleton and hub

On 3 phones provisioned with `deploy/provision-phone.sh`:
- Each shows **online** on the Phones page within 10 s of pairing, with battery, signal, carrier.
- Airplane mode on → **offline** within ~90 s; off → online again within seconds.
- Reboot → online again with nobody touching the phone.
- After 3+ minutes offline an alert appears (dashboard; Telegram if configured).

## Milestone 2: screen stream

- Open a phone: video appears within ~3 s. Phones card shows no "1 fps fallback".
- Control view round trip under 300 ms; tap-to-screen under 500 ms on 4G (same stopwatch method).
- Reboot a phone: does the capture consent get accepted automatically? Check the agent's setup
  screen shows "Screen capture running". If not, note the model: the fallback should start
  within ~20 s (card shows "1 fps fallback").
- Try `appops set com.yourorg.agent PROJECT_MEDIA allow` (done by the provisioning script): does
  the consent dialog stop appearing after reboot? Note per model.
- Data: with no operator connected, the phone's data usage stays flat (spec N3).

## Milestone 3: remote input

- From the browser only: open MT5, pick an account, open a 0.01-lot trade on a demo account,
  modify SL/TP, close it. Back / Home / Recents work. Text box enters a login number.
- Long press (hold 600 ms) opens context menus. Swipes scroll the chart.

## Milestone 4: users and locking

- Two operators open the same phone: the second sees "in use by …".
- Leave a session idle 5 minutes: it ends with "Released after 5 minutes without input".
- Admin "Take over": the operator sees "An admin took over this phone".
- Sessions and Audit pages list all of the above.

## Milestone 5: dashboard

- An operator finds an account by login on the Accounts page, opens its phone and trades using
  only the dashboard.

## Milestone 6: hardening and rollout

- `server/loadtest/simulate.py` against production with `--phones 30 --operators 10`: no errors,
  open → opened p95 under 500 ms. (Local result on a laptop: p95 129 ms, 0 errors.)
- Publish a new agent APK on the Devices page: phones update themselves (device owner = silent)
  and come back online on the new version.
- Provision all 30 phones; leave them **7 days** untouched. Pass = every phone reachable every day.
