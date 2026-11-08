"""
Proximity Voice - central server (Starlette + SSE)

Position sources (either one works):
  POST /update_coords           the VC_Carry addon's own protocol (same as the Discord bot's)
  POST /s/{secret}/update_coords  same, with the secret in the path (recommended: the addon has no auth header)
  POST /api/positions           simple protocol (X-API-Key header)

App side:
  POST /api/join, GET /events?token=, POST /api/signal, POST /api/ping, GET /api/config, GET /
  POST /api/range            a player changes their own mic range (blocks; -1 = whole world, admins only)
  POST /api/admin/login      unlock admin powers with VC_ADMIN_KEY
  POST /api/admin/logout
  POST /api/admin/action     mute | player_range | base_range | reset_player

Env vars:
  PORT              default 8080
  VC_API_KEY        secret for the addon (default: change-me)
  VC_OPEN_UPDATE    "1" = also accept /update_coords with no secret (NOT secure), default 0
  VC_MAX_DISTANCE   blocks, default 32 (the addon's range setting overrides it)
  VC_WHISPER        range factor when a player is sneaking, default 0.5
  VC_ADMIN_KEY      password that unlocks the admin panel in the app (admin disabled when unset)
  VC_STUN           comma-separated STUN urls (default: Google STUN)
  VC_TURN_URL       optional TURN url, e.g. turn:example.com:3478
  VC_TURN_USER / VC_TURN_PASS
"""
import asyncio
import hmac
import json
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from sse_starlette.sse import EventSourceResponse
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

BASE = Path(__file__).parent
STATIC = BASE / "static"

PORT = int(os.environ.get("PORT", "8080"))
API_KEY = os.environ.get("VC_API_KEY", "change-me")
OPEN_UPDATE = os.environ.get("VC_OPEN_UPDATE", "0") == "1"
MAX_DISTANCE = float(os.environ.get("VC_MAX_DISTANCE", "32"))
WHISPER = float(os.environ.get("VC_WHISPER", "0.5"))
ADMIN_KEY = os.environ.get("VC_ADMIN_KEY", "")
GLOBAL = -1.0            # range value meaning "the whole world" (every dimension, full volume)
RANGE_MIN = 2.0
RANGE_MAX = 1000.0
FAIL_LIMIT = 10          # wrong admin passwords per window per IP
FAIL_WINDOW = 300.0
POSITION_STALE = float(os.environ.get("VC_STALE_SECONDS", "6"))
SESSION_TIMEOUT = 25.0  # no ping/signal for this long -> session is dead


def ice_servers():
    stun = os.environ.get("VC_STUN", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    servers = [{"urls": [u.strip() for u in stun.split(",") if u.strip()]}]
    turn = os.environ.get("VC_TURN_URL")
    if turn:
        servers.append({
            "urls": [turn],
            "username": os.environ.get("VC_TURN_USER", ""),
            "credential": os.environ.get("VC_TURN_PASS", ""),
        })
    return servers


# lowercase name -> {name, x, y, z, ry, dim, mic, hear, bot, range, ts}
players = {}
game = {"range": 0.0, "override": 0.0, "calls": []}  # calls: list of (key1, key2)
prefs = {}      # key -> range the player chose for themselves (blocks, or GLOBAL for admins)
forced = {}     # key -> range an admin set for that player (blocks, or GLOBAL)
smuted = set()  # keys an admin muted for everyone
fails = {}      # ip -> [timestamps of failed admin logins]
sessions = {}  # token -> session dict
by_key = {}    # lowercase name -> token


def key_of(name):
    return str(name).strip().lower()


def sse(event, payload):
    return {"event": event, "data": json.dumps(payload)}


def current_range():
    """Base range for everybody: the admin override if set, otherwise the addon's setting."""
    if game["override"] > 0:
        return game["override"]
    return game["range"] if game["range"] > 0 else MAX_DISTANCE


def is_admin_key(key):
    s = sessions.get(by_key.get(key))
    return bool(s and s["connected"] and s["admin"])


def player_cap():
    """Highest range a normal (non-admin) player may pick for themselves."""
    return max(current_range() * 2, RANGE_MIN)


def chosen_range(key):
    """The range a player is speaking at, before the sneaking/whisper factor."""
    base = current_range()
    if key in forced:
        return forced[key]
    if key in prefs:
        r = prefs[key]
        if is_admin_key(key):
            return r
        return base if r == GLOBAL else min(r, player_cap())
    return base


def effective_range(key):
    r = chosen_range(key)
    if r != GLOBAL and players[key]["sneaking"]:
        r *= WHISPER
    return r


def positions_payload_for(key):
    """What one listener needs: everyone's state + only the calls that involve them."""
    pairs = []
    for a, b in game["calls"]:
        if key in (a, b) and a in players and b in players:
            pairs.append([players[a]["name"], players[b]["name"]])
    out = []
    for k, p in players.items():
        out.append({
            "name": p["name"], "x": p["x"], "y": p["y"], "z": p["z"], "ry": p["ry"], "dim": p["dim"],
            "mic": p["mic"] and k not in smuted, "hear": p["hear"], "bot": p["bot"],
            "range": effective_range(k), "smuted": k in smuted, "forced": k in forced,
        })
    return {
        "players": out,
        "calls": pairs,
        "self": {
            "admin": is_admin_key(key),
            # Always respect the player's chosen range (even while Waiting for Minecraft).
            # Previously this fell back to current_range() when offline, which pinned the UI at 32.
            "range": chosen_range(key),
            "locked": key in forced,
            "cap": player_cap(),
            "base": current_range(),
            "override": game["override"] > 0,
            "adminEnabled": bool(ADMIN_KEY),
        },
    }


def broadcast(event, payload, exclude=None):
    msg = sse(event, payload)
    for s in sessions.values():
        if s["connected"] and s is not exclude:
            s["queue"].put_nowait(msg)


def broadcast_positions():
    """Push fresh positions to every connected session and promote waiting sessions to in-game."""
    for s in sessions.values():
        if not s["connected"]:
            continue
        was_in_game = s.get("in_game", False)
        now_in_game = s["key"] in players and not players[s["key"]].get("bot")
        s["in_game"] = now_in_game
        # Prefer the live casing from the game when available
        if now_in_game:
            s["name"] = players[s["key"]]["name"]
        s["queue"].put_nowait(sse("positions", positions_payload_for(s["key"])))
        # First time this session is confirmed in Minecraft → tell everyone else
        if now_in_game and not was_in_game:
            broadcast("peer_joined", {"name": s["name"]}, exclude=s)
            # Also tell the session itself so the UI can flip to Connected
            s["queue"].put_nowait(sse("status", {
                "status": "connected",
                "in_game": True,
                "name": s["name"],
            }))
        elif not now_in_game and was_in_game:
            s["queue"].put_nowait(sse("status", {
                "status": "waiting",
                "in_game": False,
                "name": s["name"],
            }))


def num(v, default=0.0):
    try:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):
            return default
        return f
    except (TypeError, ValueError):
        return default


def flag(v):
    return v is True or v == 1 or str(v).lower() == "true"


def is_bot(name):
    return name.lower().startswith("botvc")  # the addon's test bot (armor stand named "botvc")


def ingest(body, users):
    """Replace the world state from either protocol (the sender always sends everyone online)."""
    now = time.time()
    snapshot = {}
    for p in users or []:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name", "")).strip()
        if not name:
            continue
        sneaking = flag(p.get("sneaking"))
        snapshot[key_of(name)] = {
            "name": name,
            "x": num(p.get("x")),
            "y": num(p.get("y")),
            "z": num(p.get("z")),
            "ry": num(p.get("ry")),
            "dim": str(p.get("dim") or "overworld").replace("minecraft:", ""),
            "mic": not flag(p.get("mic_disabled")),
            "hear": not flag(p.get("headphone_disabled")),
            "bot": flag(p.get("bot")) or is_bot(name),
            "sneaking": sneaking,
            "ts": now,
        }
    players.clear()
    players.update(snapshot)

    game["range"] = num(body.get("range")) if num(body.get("range")) > 0 else 0.0
    calls = []
    for c in body.get("calls", []) or []:
        if isinstance(c, dict):
            a, b = key_of(c.get("p1", "")), key_of(c.get("p2", ""))
        elif isinstance(c, (list, tuple)) and len(c) == 2:
            a, b = key_of(c[0]), key_of(c[1])
        else:
            continue
        if a and b and a != b:
            calls.append((a, b))
    game["calls"] = calls
    broadcast_positions()


async def read_json(request):
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def secret_ok(supplied):
    return hmac.compare_digest(str(supplied).encode(), API_KEY.encode())


async def positions_post(request):
    body = await read_json(request)
    supplied = request.headers.get("x-api-key") or str(body.get("key", ""))
    if not secret_ok(supplied):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    ingest(body, body.get("players"))
    return JSONResponse({"ok": True, "count": len(players)})


async def update_coords_post(request):
    """VC_Carry addon protocol: {users:[{name,x,y,z,mic_disabled,headphone_disabled,...}], range, calls:[{p1,p2}]}."""
    secret = request.path_params.get("secret")
    if secret is None:
        if not OPEN_UPDATE:
            return JSONResponse({"error": "secret_required",
                                 "message": "ใส่ลิงก์เป็น https://โดเมน/s/<VC_API_KEY> ในมอด"}, status_code=401)
    elif not secret_ok(secret):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await read_json(request)
    ingest(body, body.get("users"))
    return JSONResponse({"ok": True, "ic_map": {}})


async def config_get(request):
    return JSONResponse({"maxDistance": current_range(), "iceServers": ice_servers(), "adminEnabled": bool(ADMIN_KEY)})


async def app_version_get(request):
    """Latest Android APK version — the native shell polls this on launch."""
    data = {
        "versionCode": 6,
        "versionName": "0.3.3",
        "apkUrl": "https://github.com/Pip0909/proxvoice/releases/latest/download/ProximityVoice.apk",
        "releaseUrl": "https://github.com/Pip0909/proxvoice/releases/latest",
        "notes": "อัปเดตแอปเพื่อฟีเจอร์ใหม่และความเสถียร",
        "force": False,
    }
    # Optional overrides from Render env (no redeploy of logic needed for version bumps)
    if os.environ.get("APP_VERSION_CODE"):
        try:
            data["versionCode"] = int(os.environ["APP_VERSION_CODE"])
        except ValueError:
            pass
    if os.environ.get("APP_VERSION_NAME"):
        data["versionName"] = os.environ["APP_VERSION_NAME"]
    if os.environ.get("APP_APK_URL"):
        data["apkUrl"] = os.environ["APP_APK_URL"]
    if os.environ.get("APP_RELEASE_URL"):
        data["releaseUrl"] = os.environ["APP_RELEASE_URL"]
    if os.environ.get("APP_UPDATE_NOTES"):
        data["notes"] = os.environ["APP_UPDATE_NOTES"]
    if os.environ.get("APP_FORCE_UPDATE", "").lower() in ("1", "true", "yes"):
        data["force"] = True
    # Prefer static file if present (easy to edit / CI can overwrite)
    path = STATIC / "app-version.json"
    if path.is_file():
        try:
            file_data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(file_data, dict):
                data.update({k: file_data[k] for k in (
                    "versionCode", "versionName", "apkUrl", "releaseUrl", "notes", "force"
                ) if k in file_data})
        except Exception:
            pass
    return JSONResponse(data, headers={"Cache-Control": "no-cache"})


def drop_session(token):
    s = sessions.pop(token, None)
    if s is None:
        return
    if by_key.get(s["key"]) == token:
        del by_key[s["key"]]
    if s["connected"]:
        s["connected"] = False
        broadcast("peer_left", {"name": s["name"]})
    s["queue"].put_nowait(None)  # ends its SSE stream


def alive(s):
    return time.time() - s["last_seen"] < SESSION_TIMEOUT


async def join_post(request):
    body = await read_json(request)
    raw_name = str(body.get("name", "")).strip()
    requested = key_of(raw_name)
    if not requested or len(raw_name) > 32:
        return JSONResponse({"error": "bad_name",
                             "message": "กรุณากรอก Gamertag ที่ถูกต้อง (ไม่เกิน 32 ตัวอักษร)"},
                            status_code=400)

    # Prefer the live in-game name (casing) when the player is already online.
    p = players.get(requested)
    if p and p.get("bot"):
        return JSONResponse({"error": "not_online",
                             "message": "ชื่อนี้เป็นบอทในเกม ไม่สามารถใช้เข้าร่วมได้"},
                            status_code=404)
    display_name = p["name"] if p else raw_name

    old_token = by_key.get(requested)
    if old_token:
        old = sessions.get(old_token)
        if old and alive(old):
            return JSONResponse({"error": "taken",
                                 "message": "ชื่อนี้กำลังถูกใช้งานอยู่ ลองใหม่อีกครั้งใน 20-30 วินาที"},
                                status_code=409)
        drop_session(old_token)

    token = secrets.token_urlsafe(24)
    in_game = bool(p)
    sessions[token] = {
        "token": token,
        "name": display_name,
        "key": requested,
        "queue": asyncio.Queue(),
        "connected": False,
        "last_seen": time.time(),
        "admin": False,
        "in_game": in_game,
    }
    by_key[requested] = token
    return JSONResponse({
        "token": token,
        "name": display_name,
        "maxDistance": current_range(),
        "in_game": in_game,
        "status": "connected" if in_game else "waiting",
    })


async def events_get(request):
    token = request.query_params.get("token", "")
    s = sessions.get(token)
    if s is None or s["connected"]:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["connected"] = True
    s["last_seen"] = time.time()
    # Refresh in_game from current world state
    s["in_game"] = s["key"] in players and not players[s["key"]].get("bot")
    q = s["queue"]
    # Only introduce voice peers that are already confirmed in-game
    peers = [
        x["name"] for x in sessions.values()
        if x["connected"] and x is not s and x.get("in_game")
    ]
    q.put_nowait(sse("joined", {
        "name": s["name"],
        "peers": peers,
        "maxDistance": current_range(),
        "in_game": s["in_game"],
        "status": "connected" if s["in_game"] else "waiting",
    }))
    q.put_nowait(sse("positions", positions_payload_for(s["key"])))
    # Announce this session to others only once it is in-game (or immediately if already)
    if s["in_game"]:
        broadcast("peer_joined", {"name": s["name"]}, exclude=s)

    async def gen():
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        finally:
            if sessions.get(token) is s:
                drop_session(token)

    return EventSourceResponse(gen(), ping=10)


async def signal_post(request):
    body = await read_json(request)
    s = sessions.get(str(body.get("token", "")))
    if s is None or not s["connected"]:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["last_seen"] = time.time()
    target_token = by_key.get(key_of(body.get("to", "")))
    target = sessions.get(target_token) if target_token else None
    if target is None or not target["connected"]:
        return JSONResponse({"ok": False, "error": "peer_gone"})
    target["queue"].put_nowait(sse("signal", {"from": s["name"], "data": body.get("data")}))
    return JSONResponse({"ok": True})


async def ping_post(request):
    body = await read_json(request)
    s = sessions.get(str(body.get("token", "")))
    if s is None:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["last_seen"] = time.time()
    return JSONResponse({"ok": True})


def session_from(body):
    s = sessions.get(str(body.get("token", "")))
    return s if s is not None and s["connected"] else None


def client_ip(request):
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def too_many_failures(ip):
    now = time.time()
    recent = [t for t in fails.get(ip, []) if now - t < FAIL_WINDOW]
    fails[ip] = recent
    return len(recent) >= FAIL_LIMIT


def clamp_range(v):
    return min(max(num(v, RANGE_MIN), RANGE_MIN), RANGE_MAX)


async def range_post(request):
    """A player changes their own mic range. null = back to the default."""
    body = await read_json(request)
    s = session_from(body)
    if s is None:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["last_seen"] = time.time()
    val = body.get("range")
    if val is None:
        prefs.pop(s["key"], None)
    elif num(val) == GLOBAL:
        if not s["admin"]:
            return JSONResponse({"error": "admin_only", "message": "ทั้งโลกใช้ได้เฉพาะแอดมิน"}, status_code=403)
        prefs[s["key"]] = GLOBAL
    else:
        r = clamp_range(val)
        prefs[s["key"]] = r if s["admin"] else min(r, player_cap())
    broadcast_positions()
    return JSONResponse({"ok": True, "range": chosen_range(s["key"])})


async def admin_login_post(request):
    body = await read_json(request)
    s = session_from(body)
    if s is None:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    if not ADMIN_KEY:
        return JSONResponse({"error": "admin_disabled",
                             "message": "เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสแอดมิน (VC_ADMIN_KEY)"}, status_code=503)
    ip = client_ip(request)
    if too_many_failures(ip):
        return JSONResponse({"error": "rate_limited",
                             "message": "ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่"}, status_code=429)
    if not hmac.compare_digest(str(body.get("password", "")).encode(), ADMIN_KEY.encode()):
        fails.setdefault(ip, []).append(time.time())
        return JSONResponse({"error": "bad_password", "message": "รหัสแอดมินไม่ถูกต้อง"}, status_code=401)
    s["admin"] = True
    s["last_seen"] = time.time()
    broadcast_positions()
    return JSONResponse({"ok": True})


async def admin_logout_post(request):
    body = await read_json(request)
    s = session_from(body)
    if s is None:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["admin"] = False
    broadcast_positions()
    return JSONResponse({"ok": True})


async def admin_action_post(request):
    body = await read_json(request)
    s = session_from(body)
    if s is None:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    if not s["admin"]:
        return JSONResponse({"error": "forbidden", "message": "ต้องเป็นแอดมิน"}, status_code=403)
    s["last_seen"] = time.time()
    action = str(body.get("action", ""))
    target = key_of(body.get("target", ""))
    value = body.get("value")

    if action == "base_range":
        game["override"] = 0.0 if value in (None, 0) else clamp_range(value)
    elif action in ("mute", "player_range", "reset_player"):
        if target not in players:
            return JSONResponse({"error": "no_such_player", "message": "ไม่พบผู้เล่นคนนี้"}, status_code=404)
        if action == "mute":
            if flag(value):
                smuted.add(target)
            else:
                smuted.discard(target)
        elif action == "player_range":
            if value is None:
                forced.pop(target, None)
            elif num(value) == GLOBAL:
                forced[target] = GLOBAL
            else:
                forced[target] = clamp_range(value)
        else:  # reset_player
            forced.pop(target, None)
            smuted.discard(target)
            prefs.pop(target, None)
    else:
        return JSONResponse({"error": "bad_action"}, status_code=400)
    broadcast_positions()
    return JSONResponse({"ok": True})


async def janitor():
    while True:
        await asyncio.sleep(2)
        now = time.time()
        stale = [k for k, p in players.items() if now - p["ts"] > POSITION_STALE]
        if stale:
            for k in stale:
                players.pop(k, None)
            broadcast_positions()
        for token in [t for t, s in sessions.items() if not alive(s)]:
            drop_session(token)
        for ip in [ip for ip, ts in fails.items() if not any(now - t < FAIL_WINDOW for t in ts)]:
            del fails[ip]


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(janitor())
    try:
        yield
    finally:
        task.cancel()


def static_file(name, media_type=None, no_cache=False):
    async def handler(request):
        headers = {"Cache-Control": "no-cache"} if no_cache else None
        return FileResponse(STATIC / name, media_type=media_type, headers=headers)
    return handler


routes = [
    Route("/", static_file("index.html", no_cache=True)),
    Route("/sw.js", static_file("sw.js", "application/javascript", no_cache=True)),
    Route("/manifest.webmanifest", static_file("manifest.webmanifest", "application/manifest+json")),
    Route("/api/config", config_get),
    Route("/api/app-version", app_version_get),
    Route("/api/positions", positions_post, methods=["POST"]),
    Route("/update_coords", update_coords_post, methods=["POST"]),
    Route("/s/{secret}/update_coords", update_coords_post, methods=["POST"]),
    Route("/api/join", join_post, methods=["POST"]),
    Route("/api/signal", signal_post, methods=["POST"]),
    Route("/api/ping", ping_post, methods=["POST"]),
    Route("/api/range", range_post, methods=["POST"]),
    Route("/api/admin/login", admin_login_post, methods=["POST"]),
    Route("/api/admin/logout", admin_logout_post, methods=["POST"]),
    Route("/api/admin/action", admin_action_post, methods=["POST"]),
    Route("/events", events_get),
    Mount("/static", app=StaticFiles(directory=str(STATIC)), name="static"),
]

app = Starlette(routes=routes, lifespan=lifespan)

if __name__ == "__main__":
    import uvicorn

    if API_KEY == "change-me":
        print("WARNING: VC_API_KEY is not set (using 'change-me')")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
