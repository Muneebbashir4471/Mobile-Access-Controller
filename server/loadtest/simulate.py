"""Fleet simulator for the hub (milestone 6 load test).

Creates N fake phones (paired through the real API) and M operators, then for --duration
seconds each operator repeatedly opens a phone, relays a fake offer/answer and ICE through the
hub, sends activity, and closes. Phones send status every --status-every seconds.

Measures open→opened and offer→answer round trips. Media is not simulated: TURN relay load is
measured on real phones in the pilot.

  python -m loadtest.simulate --base https://phones.example.com \\
      --admin-email admin@example.com --admin-password '…' --admin-totp-secret BASE32
"""

import argparse
import asyncio
import json
import random
import statistics
import time

import httpx
import pyotp
import websockets

PASSWORD = "loadtest-password-123"


def ws_url(base: str, path: str) -> str:
    return base.replace("https://", "wss://").replace("http://", "ws://") + path


async def login(base: str, email: str, password: str, secret: str | None) -> httpx.AsyncClient:
    c = httpx.AsyncClient(base_url=base, timeout=30)
    # A TOTP code is accepted once; wait for a fresh one if this code was just used.
    for _ in range(3):
        code = pyotp.TOTP(secret).now() if secret else None
        r = await c.post("/api/auth/login", json={"email": email, "password": password, "code": code})
        if r.status_code == 200:
            return c
        await asyncio.sleep(31 - time.time() % 30)
    raise SystemExit(f"login failed for {email}: {r.status_code} {r.text}")


async def phone(base: str, token: str, status_every: float, stop: asyncio.Event, stats: dict):
    hdr = {"Authorization": f"Bearer {token}"}
    async with websockets.connect(ws_url(base, "/ws/agent"), additional_headers=hdr) as ws:
        await ws.send(json.dumps({"type": "hello", "app_version": "loadtest", "android_version": "14", "model": "Sim"}))

        async def status_loop():
            while not stop.is_set():
                await ws.send(json.dumps({"type": "status", "battery": random.randint(40, 100), "charging": True,
                                          "signal": random.randint(-110, -80), "carrier": "Sim", "network_type": "LTE",
                                          "capture_ready": True, "input_ready": True, "capture_mode": "projection"}))
                await asyncio.sleep(status_every)

        task = asyncio.create_task(status_loop())
        try:
            while not stop.is_set():
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 1))
                except asyncio.TimeoutError:
                    continue
                if msg["type"] == "rtc_offer":
                    await ws.send(json.dumps({"type": "rtc_answer", "session_id": msg["session_id"], "sdp": "answer"}))
                    await ws.send(json.dumps({"type": "ice", "session_id": msg["session_id"], "candidate": {"candidate": "c"}}))
                elif msg["type"] == "session_start":
                    stats["session_starts"] += 1
        finally:
            task.cancel()


async def operator(base: str, cookie: str, device_ids: list[str], stop: asyncio.Event, stats: dict):
    async with websockets.connect(ws_url(base, "/ws/operator"),
                                  additional_headers={"Cookie": cookie, "Origin": base}) as ws:

        async def wait_for(kind: str, timeout: float = 10) -> dict:
            end = time.monotonic() + timeout
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), max(0.1, end - time.monotonic())))
                if msg["type"] in (kind, "denied"):
                    return msg

        while not stop.is_set():
            did = random.choice(device_ids)
            t0 = time.perf_counter()
            await ws.send(json.dumps({"type": "open", "device_id": did}))
            try:
                msg = await wait_for("opened")
            except asyncio.TimeoutError:
                stats["errors"] += 1
                continue
            if msg["type"] == "denied":
                stats["denied"][msg["reason"]] = stats["denied"].get(msg["reason"], 0) + 1
                await asyncio.sleep(0.5)
                continue
            stats["open_ms"].append((time.perf_counter() - t0) * 1000)
            sid = msg["session_id"]
            t1 = time.perf_counter()
            await ws.send(json.dumps({"type": "rtc_offer", "session_id": sid, "sdp": "offer"}))
            try:
                await wait_for("rtc_answer")
                stats["answer_ms"].append((time.perf_counter() - t1) * 1000)
            except asyncio.TimeoutError:
                stats["errors"] += 1
            for _ in range(random.randint(1, 3)):
                await asyncio.sleep(random.uniform(0.5, 2))
                await ws.send(json.dumps({"type": "activity", "session_id": sid}))
            await ws.send(json.dumps({"type": "close", "session_id": sid}))
            await asyncio.sleep(random.uniform(0.2, 1))


def pct(values: list[float], p: float) -> float:
    return sorted(values)[min(len(values) - 1, int(len(values) * p))] if values else float("nan")


async def main(a):
    admin = await login(a.base, a.admin_email, a.admin_password, a.admin_totp_secret)
    tag = f"lt{int(time.time())}"

    print(f"pairing {a.phones} simulated phones…")
    phones = []
    for i in range(a.phones):
        code = (await admin.post("/api/devices/pairing-codes")).json()["code"]
        while (r := await admin.post("/api/devices/pair", json={"code": code, "model": f"{tag}-{i}"})).status_code == 429:
            print("  pairing rate limit hit, waiting a minute…")
            await asyncio.sleep(61)
        r.raise_for_status()
        phones.append(r.json())
    ids = [p["device_id"] for p in phones]

    print(f"creating {a.operators} operators…")
    cookies = []
    for i in range(a.operators):
        u = (await admin.post("/api/users", json={"email": f"{tag}-op{i}@loadtest.invalid", "password": PASSWORD,
                                                  "role": "operator"})).json()
        await admin.put(f"/api/users/{u['id']}/devices", json={"device_ids": ids})
        c = await login(a.base, u["email"], PASSWORD, None)  # new users start without 2FA
        cookies.append(f"mt5_session={c.cookies['mt5_session']}")
        await c.aclose()

    stats = {"open_ms": [], "answer_ms": [], "errors": 0, "denied": {}, "session_starts": 0}
    stop = asyncio.Event()
    tasks = [asyncio.create_task(phone(a.base, p["token"], a.status_every, stop, stats)) for p in phones]
    await asyncio.sleep(2)
    tasks += [asyncio.create_task(operator(a.base, ck, ids, stop, stats)) for ck in cookies]
    print(f"running for {a.duration}s…")
    await asyncio.sleep(a.duration)
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)

    online = sum(d["online"] for d in (await admin.get("/api/devices")).json() if d["model"].startswith(tag))
    print("\n=== results")
    print(f"sessions opened     {len(stats['open_ms'])}  (agents saw {stats['session_starts']} session_start)")
    print(f"open → opened       p50 {pct(stats['open_ms'], .5):.0f} ms   p95 {pct(stats['open_ms'], .95):.0f} ms")
    print(f"offer → answer      p50 {pct(stats['answer_ms'], .5):.0f} ms   p95 {pct(stats['answer_ms'], .95):.0f} ms")
    print(f"denied              {stats['denied']}  (locked is expected with operators racing)")
    print(f"errors / timeouts   {stats['errors']}")
    print(f"phones online after {online} (should be 0 once agents have disconnected)")

    if a.cleanup:
        for p in phones:
            await admin.delete(f"/api/devices/{p['device_id']}")
        print("revoked simulated phones (operators stay; disable them on the Users page)")
    await admin.aclose()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--admin-email", required=True)
    ap.add_argument("--admin-password", required=True)
    ap.add_argument("--admin-totp-secret", help="only if the admin has turned on 2FA")
    ap.add_argument("--phones", type=int, default=30)
    ap.add_argument("--operators", type=int, default=10)
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--status-every", type=float, default=60)
    ap.add_argument("--cleanup", action="store_true")
    asyncio.run(main(ap.parse_args()))
