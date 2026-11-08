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
GLOBAL = -1.0
RANGE_MIN = 2.0
RANGE_MAX = 1000.0
FAIL_LIMIT = 10
FAIL_WINDOW = 300.0
POSITION_STALE = float(os.environ.get("VC_STALE_SECONDS", "6"))
SESSION_TIMEOUT = 25.0

# SEE LOCAL FILE FOR FULL CONTENT - THIS IS A TEST
