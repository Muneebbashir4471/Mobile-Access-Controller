import time

import pyotp
import pytest
from starlette.websockets import WebSocketDisconnect

from app.redis_state import get_redis, k_lock

from .conftest import PASSWORD, add_user, login, pair_device, run

STATUS = {"type": "status", "battery": 80, "charging": True, "signal": -95, "carrier": "Jazz",
          "network_type": "LTE", "capture_ready": False, "input_ready": False}


def _admin(client):
    uid, secret = add_user(client, "admin@example.com", "admin")
    login(client, "admin@example.com", secret)
    return uid


def _agent(client, token):
    return client.websocket_connect("/ws/agent", headers={"Authorization": f"Bearer {token}"})


def _recv_until(ws, kind, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg
    raise AssertionError(f"no {kind}")


def test_password_login_then_optional_2fa(client):
    add_user(client, "op@example.com")
    creds = {"email": "op@example.com", "password": PASSWORD}
    assert client.post("/api/auth/login", json={**creds, "password": "wrong"}).status_code == 401
    r = client.post("/api/auth/login", json=creds)  # no code needed while 2FA is off
    assert r.status_code == 200 and r.json()["totp_enabled"] is False

    # Turn 2FA on from Settings: setup gives a secret, enable needs a matching code.
    secret = client.post("/api/auth/2fa/setup").json()["secret"]
    assert client.post("/api/auth/2fa/enable", json={"code": "000000"}).status_code == 400
    assert client.post("/api/auth/2fa/enable", json={"code": pyotp.TOTP(secret).now()}).json()["totp_enabled"]
    client.post("/api/auth/logout")

    # Now the code is required; asking for it is not a failed attempt.
    r = client.post("/api/auth/login", json=creds)
    assert r.status_code == 401 and r.json()["detail"] == "one_time_code_required"
    assert client.post("/api/auth/login", json={**creds, "code": "000000"}).status_code == 401
    assert client.post("/api/auth/login", json={**creds, "code": pyotp.TOTP(secret).now()}).status_code == 200

    # Disabling needs password and a code.
    assert client.post("/api/auth/2fa/disable", json={"password": PASSWORD, "code": "000000"}).status_code == 400


def test_lockout_after_five_failures(client):
    add_user(client, "op@example.com")
    for _ in range(5):
        client.post("/api/auth/login", json={"email": "op@example.com", "password": "wrong"})
    r = client.post("/api/auth/login", json={"email": "op@example.com", "password": PASSWORD})
    assert r.status_code == 423


def test_pairing_code_is_single_use(client):
    _admin(client)
    code = client.post("/api/devices/pairing-codes").json()["code"]
    assert client.post("/api/devices/pair", json={"code": code.lower()}).status_code == 200
    assert client.post("/api/devices/pair", json={"code": code}).status_code == 400


def test_agent_presence_and_status(client):
    _admin(client)
    dev = pair_device(client)

    with pytest.raises(WebSocketDisconnect):  # no token
        with client.websocket_connect("/ws/agent"):
            pass
    with _agent(client, dev["token"]) as ws:
        assert ws.receive_json()["type"] == "config"
        ws.send_json({"type": "hello", "device_id": dev["device_id"], "app_version": "0.1.1",
                      "android_version": "14", "model": "Pixel 7"})
        ws.send_json(STATUS)
        time.sleep(0.2)
        d = client.get("/api/devices").json()[0]
        assert d["online"] is True
        assert d["status"]["battery"] == 80 and d["status"]["ip"]
        assert d["app_version"] == "0.1.1" and d["sim_carrier"] == "Jazz"
    time.sleep(0.2)
    assert client.get("/api/devices").json()[0]["online"] is False

    # A revoked device disappears and its token no longer connects.
    client.delete(f"/api/devices/{dev['device_id']}")
    assert client.get("/api/devices").json() == []
    with pytest.raises(WebSocketDisconnect):
        with _agent(client, dev["token"]):
            pass


def test_open_lock_signaling_and_takeover(client):
    admin_id = _admin(client)
    dev = pair_device(client)
    did = dev["device_id"]
    op_id, op_secret = add_user(client, "op@example.com")
    client.put(f"/api/users/{op_id}/devices", json={"device_ids": [did]})

    from fastapi.testclient import TestClient

    op = TestClient(client.app, base_url="https://testserver")
    op.portal = client.portal  # share the running app loop
    login(op, "op@example.com", op_secret)
    assert [d["id"] for d in op.get("/api/devices").json()] == [did]

    with _agent(client, dev["token"]) as agent:
        agent.receive_json()  # config
        agent.send_json(STATUS)
        time.sleep(0.1)

        with op.websocket_connect("/ws/operator") as ows:
            ows.send_json({"type": "open", "device_id": did})
            opened = _recv_until(ows, "opened")
            sid = opened["session_id"]
            assert opened["turn"]["username"].endswith(sid)

            start = _recv_until(agent, "session_start")
            assert start["session_id"] == sid and start["video"]["fps"] == 30 and start["video"]["bitrate"] == 3_000_000

            # Signaling relays both ways.
            ows.send_json({"type": "rtc_offer", "session_id": sid, "sdp": "v=0 offer"})
            assert _recv_until(agent, "rtc_offer")["sdp"] == "v=0 offer"
            agent.send_json({"type": "rtc_answer", "session_id": sid, "sdp": "v=0 answer"})
            assert _recv_until(ows, "rtc_answer")["sdp"] == "v=0 answer"

            # Admin is denied while locked, then takes over.
            with client.websocket_connect("/ws/operator") as aws:
                aws.send_json({"type": "open", "device_id": did})
                denied = _recv_until(aws, "denied")
                assert denied["reason"] == "locked" and denied["held_by"] == "op@example.com"
                aws.send_json({"type": "takeover", "device_id": did})
                assert _recv_until(aws, "opened")["session_id"] != sid
                ended = _recv_until(ows, "session_ended")
                assert ended["reason"] == "takeover" and ended["by"] == "admin@example.com"
                assert _recv_until(agent, "session_stop")["session_id"] == sid

    time.sleep(0.2)
    sessions = client.get("/api/sessions").json()
    reasons = sorted(s["end_reason"] for s in sessions)
    assert reasons == ["closed", "takeover"]
    assert any(a["action"] == "takeover" for a in client.get("/api/audit").json())
    assert admin_id


def test_unassigned_and_offline_are_denied(client):
    _admin(client)
    dev = pair_device(client)
    with client.websocket_connect("/ws/operator") as ws:
        ws.send_json({"type": "open", "device_id": dev["device_id"]})
        assert _recv_until(ws, "denied")["reason"] == "offline"
        ws.send_json({"type": "open", "device_id": "00000000-0000-0000-0000-000000000000"})
        assert _recv_until(ws, "denied")["reason"] == "not_assigned"


def test_lock_expiry_ends_session(client):
    _admin(client)
    dev = pair_device(client)
    with _agent(client, dev["token"]) as agent:
        agent.receive_json()
        agent.send_json(STATUS)
        time.sleep(0.1)
        with client.websocket_connect("/ws/operator") as ws:
            ws.send_json({"type": "open", "device_id": dev["device_id"]})
            _recv_until(ws, "opened")
            run(client, get_redis().delete, k_lock(dev["device_id"]))  # simulate the 300 s expiry
            assert _recv_until(ws, "session_ended")["reason"] == "timeout"


def test_account_search_respects_assignment(client):
    _admin(client)
    d1, d2 = pair_device(client, "A"), pair_device(client, "B")
    client.post(f"/api/devices/{d1['device_id']}/accounts", json={"login": "5001234", "broker_server": "X-Live"})
    client.post(f"/api/devices/{d2['device_id']}/accounts", json={"login": "5009999", "broker_server": "X-Live"})
    assert len(client.get("/api/accounts", params={"q": "500"}).json()) == 2
    res = client.get("/api/accounts", params={"q": "5001"}).json()
    assert res[0]["device_id"] == d1["device_id"]


APK = b"PK\x03\x04" + b"fake apk body" * 100


def _upload_apk(client, code="2"):
    return client.post("/api/agent/releases", data={"version_code": code, "version_name": f"0.{code}.0"},
                       files={"apk": ("agent.apk", APK, "application/octet-stream")})


def test_agent_apk_upload_and_public_download(client):
    import hashlib
    assert client.get("/api/agent/download/agent.apk").status_code == 404
    _admin(client)
    r = _upload_apk(client)
    assert r.status_code == 201, r.text
    assert r.json()["sha256"] == hashlib.sha256(APK).hexdigest()
    # Same or lower version is refused; non-APK refused.
    assert _upload_apk(client, "2").status_code == 400
    assert client.post("/api/agent/releases", data={"version_code": "3", "version_name": "x"},
                       files={"apk": ("a.apk", b"not a zip")}).status_code == 400
    # A factory-reset phone has no token: the download is public.
    client.post("/api/auth/logout")
    body = client.get("/api/agent/download/agent.apk")
    assert body.status_code == 200 and body.content == APK


def test_device_owner_provisioning_qr_pairs_the_phone(client):
    _admin(client)
    assert client.post("/api/devices/provisioning-qr", json={}).status_code == 400  # no APK yet
    _upload_apk(client)
    r = client.post("/api/devices/provisioning-qr", json={"wifi_ssid": "Office", "wifi_password": "secret-pass"})
    assert r.status_code == 200, r.text
    p = r.json()["qr_payload"]
    x = "android.app.extra."
    assert p[x + "PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME"] == "com.yourorg.agent/.AdminReceiver"
    assert p[x + "PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION"] == "https://testserver/api/agent/download/agent.apk"
    assert p[x + "PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM"]
    assert p[x + "PROVISIONING_WIFI_SSID"] == "Office" and p[x + "PROVISIONING_WIFI_SECURITY_TYPE"] == "WPA"
    extras = p[x + "PROVISIONING_ADMIN_EXTRAS_BUNDLE"]
    assert extras["server"] == "https://testserver"
    # The embedded one-time code pairs the phone once setup finishes.
    r = client.post("/api/devices/pair", json={"code": extras["code"], "model": "Pixel 8", "android_version": "15",
                                               "app_version": "0.6.0"})
    assert r.status_code == 200, r.text


def test_admin_must_turn_on_2fa(client):
    add_user(client, "boss@example.com", "admin", totp_enabled=False)
    me = client.post("/api/auth/login", json={"email": "boss@example.com", "password": PASSWORD}).json()
    assert me["must_enable_2fa"] is True
    # Admin features and phones stay locked; Settings (2FA setup) still works.
    assert client.post("/api/devices/pairing-codes").status_code == 403
    assert client.get("/api/devices").json() == []
    secret = client.post("/api/auth/2fa/setup").json()["secret"]
    me = client.post("/api/auth/2fa/enable", json={"code": pyotp.TOTP(secret).now()}).json()
    assert me["must_enable_2fa"] is False
    assert client.post("/api/devices/pairing-codes").status_code == 200
    # And an admin cannot switch it off again.
    r = client.post("/api/auth/2fa/disable", json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 400


def test_superuser_outranks_admin(client):
    admin_id = _admin(client)
    new = {"password": PASSWORD}
    # An admin may create and manage other admins, but never superusers.
    a2 = client.post("/api/users", json={**new, "email": "a2@example.com", "role": "admin"})
    assert a2.status_code == 201
    assert client.patch(f"/api/users/{a2.json()['id']}", json={"password": "another-long-pass"}).status_code == 200
    assert client.post("/api/users", json={**new, "email": "s2@example.com", "role": "superuser"}).status_code == 403
    assert client.patch(f"/api/users/{a2.json()['id']}", json={"role": "superuser"}).status_code == 403
    assert client.post("/api/users", json={**new, "email": "op2@example.com", "role": "operator"}).status_code == 201
    sid, ssecret = add_user(client, "owner@example.com", "superuser")
    assert client.patch(f"/api/users/{sid}", json={"active": False}).status_code == 403
    client.post("/api/auth/logout")
    login(client, "owner@example.com", ssecret)
    assert client.patch(f"/api/users/{admin_id}", json={"role": "operator"}).status_code == 200
    assert client.post("/api/users", json={**new, "email": "a3@example.com", "role": "admin"}).status_code == 201


def test_fallback_alert_after_grace_period(client, monkeypatch):
    from app.config import get_settings
    _admin(client)
    dev = pair_device(client)
    monkeypatch.setattr(get_settings(), "fallback_alert_seconds", 0)
    with client.websocket_connect("/ws/operator") as op, _agent(client, dev["token"]) as agent:
        agent.receive_json()  # config
        agent.send_json({**STATUS, "capture_mode": "fallback"})
        alert = _recv_until(op, "alert", limit=50)
        assert alert["kind"] == "fallback" and "1 fps" in alert["message"]


def test_change_own_password(client):
    _admin(client)
    bad = client.post("/api/auth/password", json={"current_password": "wrong", "new_password": "x" * 12})
    assert bad.status_code == 400
    ok = client.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "brand-new-password"})
    assert ok.status_code == 200
    short = client.post("/api/auth/password", json={"current_password": "brand-new-password", "new_password": "short"})
    assert short.status_code == 422


def test_user_name_and_last_sign_in(client):
    _admin(client)
    me = next(u for u in client.get("/api/users").json() if u["email"] == "admin@example.com")
    assert me["last_login_at"] is not None
    new = client.post("/api/users", json={"email": "op9@example.com", "password": PASSWORD,
                                          "role": "operator", "name": "  Talha  "}).json()
    assert new["name"] == "Talha" and new["last_login_at"] is None
    renamed = client.patch(f"/api/users/{new['id']}", json={"name": "Talha Abbasi"}).json()
    assert renamed["name"] == "Talha Abbasi"
