"""
Proximity Voice - central server (Starlette + SSE)

Position sources (either one works):
  POST /update_coords           the VC_Carry addon's own protocol (same as the Discord bot's)
  POST /s/{secret}/update_coords  same, with the secret in the path (recommended: the addon has no auth header)
  POST /api/positions           simple protocol (X-API-Key header)

App side:
  POST /api/join, GET /events?token=, POST /api/signal, POST /api/ping, GET /api/config, GET /

Env vars:
  PORT              default 8080
  VC_API_KEY        secret for the addon (default: change-me)
  VC_OPEN_UPDATE    "1" = also accept /update_coords with no secret (NOT secure), default 0
  VC_MAX_DISTANCE   blocks, default 32 (the addon's range setting overrides it)
  VC_WHISPER        range factor when a player is sneaking, default 0.5
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
game = {"range": 0.0, "calls": []}  # calls: list of (key1, key2)
sessions = {}  # token -> session dict
by_key = {}    # lowercase name -> token


def key_of(name):
    return str(name).strip().lower()


def sse(event, payload):
    return {"event": event, "data": json.dumps(payload)}


def current_range():
    return game["range"] if game["range"] > 0 else MAX_DISTANCE


def positions_payload_for(key):
    """What one listener needs: everyone's state + only the calls that involve them."""
    pairs = []
    for a, b in game["calls"]:
        if key in (a, b) and a in players and b in players:
            pairs.append([players[a]["name"], players[b]["name"]])
    return {
        "players": [
            {k: p[k] for k in ("name", "x", "y", "z", "ry", "dim", "mic", "hear", "bot", "range")}
            for p in players.values()
        ],
        "calls": pairs,
    }


def broadcast(event, payload, exclude=None):
    msg = sse(event, payload)
    for s in sessions.values():
        if s["connected"] and s is not exclude:
            s["queue"].put_nowait(msg)


def broadcast_positions():
    for s in sessions.values():
        if s["connected"]:
            s["queue"].put_nowait(sse("positions", positions_payload_for(s["key"])))


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
    base = num(body.get("range"))
    base = base if base > 0 else MAX_DISTANCE
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
            "range": base * WHISPER if sneaking else base,
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
    return JSONResponse({"maxDistance": current_range(), "iceServers": ice_servers()})


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
    requested = key_of(body.get("name", ""))
    p = players.get(requested)
    if not p or p["bot"]:
        return JSONResponse({"error": "not_online",
                             "message": "ไม่พบผู้เล่นชื่อนี้ในเซิร์ฟเวอร์ (ต้องเข้าเกมก่อน)"}, status_code=404)
    old_token = by_key.get(requested)
    if old_token:
        old = sessions.get(old_token)
        if old and alive(old):
            return JSONResponse({"error": "taken",
                                 "message": "ชื่อนี้กำลังถูกใช้งานอยู่ ลองใหม่อีกครั้งใน 20-30 วินาที"},
                                status_code=409)
        drop_session(old_token)
    token = secrets.token_urlsafe(24)
    sessions[token] = {
        "token": token, "name": p["name"], "key": requested,
        "queue": asyncio.Queue(), "connected": False, "last_seen": time.time(),
    }
    by_key[requested] = token
    return JSONResponse({"token": token, "name": p["name"], "maxDistance": current_range()})


async def events_get(request):
    token = request.query_params.get("token", "")
    s = sessions.get(token)
    if s is None or s["connected"]:
        return JSONResponse({"error": "bad_token"}, status_code=403)
    s["connected"] = True
    s["last_seen"] = time.time()
    q = s["queue"]
    peers = [x["name"] for x in sessions.values() if x["connected"] and x is not s]
    q.put_nowait(sse("joined", {"name": s["name"], "peers": peers, "maxDistance": current_range()}))
    q.put_nowait(sse("positions", positions_payload_for(s["key"])))
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
    Route("/api/positions", positions_post, methods=["POST"]),
    Route("/update_coords", update_coords_post, methods=["POST"]),
    Route("/s/{secret}/update_coords", update_coords_post, methods=["POST"]),
    Route("/api/join", join_post, methods=["POST"]),
    Route("/api/signal", signal_post, methods=["POST"]),
    Route("/api/ping", ping_post, methods=["POST"]),
    Route("/events", events_get),
    Mount("/static", app=StaticFiles(directory=str(STATIC)), name="static"),
]

app = Starlette(routes=routes, lifespan=lifespan)

if __name__ == "__main__":
    import uvicorn

    if API_KEY == "change-me":
        print("WARNING: VC_API_KEY is not set (using 'change-me')")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
