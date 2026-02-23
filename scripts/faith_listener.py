"""Operation Faith – Agent Listener v8.1.0 (localhost:1337).

FAITH CONSTITUTION COMPLIANT — Pure Passthrough Relay.

This listener is the NERVOUS SYSTEM, not the brain.
It does exactly three things:
  1. Receives support bundles from ComfyUI → prints to stdout for the Architect
  2. Accepts workflow installs from the Architect → queues for frontend
  3. Returns structured acknowledgements

ZERO classification. ZERO workflow building. ZERO keyword matching.
ZERO canned responses. All intelligence lives in the Resident Architect (LLM).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import socket
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

from aiohttp import web

_LISTENER_VERSION = "8.1.0"
_BOOT_TIME = time.time()
_REQUEST_LOG: list[dict[str, Any]] = []
_SUPPORT_INBOX: list[dict[str, Any]] = []
_PENDING_INSTALL: dict[str, Any] | None = None
_AVAILABLE_MODELS: list[dict[str, Any]] = []
_DEFAULT_MODEL_FAMILY: str = "gpt-4o-mini"
_MAX_LOG = 50
_MAX_INBOX = 20
_WORKSPACE_ROOT = ""
_STATE_FILE_PATH: str = "" # Set during main() → LOGS/listener_state.json
_LIBRARY_ROOT: str = ""    # Set during main() → Release/workflow_library

# Logger setup


# ── Utilities ──────────────────────────────────────────────────────────

def _load_env(path: str) -> None:
    """Load .env file into os.environ."""
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip()
    except Exception as e:
        print(f"Failed to load .env: {e}")



def _cleanup_old_logs(log_dir: str, days: int = 7) -> None:
    """Delete log files older than N days."""
    if not log_dir or not os.path.exists(log_dir):
        return
    cutoff = time.time() - (days * 86400)
    # Check regular logs and rotated ones
    for f in glob.glob(os.path.join(log_dir, "*.log*")):
        try:
            if os.path.isfile(f) and os.path.getmtime(f) < cutoff:
                os.remove(f)
                # Print to stdout only, as logger might not be ready or we don't want to clutter it
                print(f"[Maintenance] Cleaned up old log: {f}")
        except OSError:
            pass




def _safe_print(*parts: Any) -> None:
    text = " ".join(str(p) for p in parts)
    try:
        print(text)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))
        sys.stdout.flush()


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Accept",
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_request(route: str, summary: str) -> None:
    entry = {"route": route, "summary": summary, "timestamp": _now_iso()}
    _REQUEST_LOG.append(entry)
    if len(_REQUEST_LOG) > _MAX_LOG:
        _REQUEST_LOG[:] = _REQUEST_LOG[-_MAX_LOG:]

# ── Persistence ───────────────────────────────────────────────────────

def _save_state() -> None:
    """Persist inbox and pending actions to disk."""
    if not _STATE_FILE_PATH:
        return
    state = {
        "inbox": _SUPPORT_INBOX,
        "pending": _PENDING_INSTALL,
        "timestamp": _now_iso()
    }
    try:
        with open(_STATE_FILE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        _file_log(f"Failed to save state: {e}")

def _load_state() -> None:
    """Load persisted state from disk."""
    global _SUPPORT_INBOX, _PENDING_INSTALL
    if not _STATE_FILE_PATH or not os.path.exists(_STATE_FILE_PATH):
        return
    try:
        with open(_STATE_FILE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
            _SUPPORT_INBOX = state.get("inbox", [])
            _PENDING_INSTALL = state.get("pending")
            _safe_print(f"[Persistence] Restored {_SUPPORT_INBOX.__len__()} inbox items and pending action.")
    except Exception as e:
        _file_log(f"Failed to load state: {e}")

# ── Support Bundle Printer (stdout → Architect reads this) ────────────

def _print_support_bundle(bundle: dict[str, Any]) -> None:
    support_id = str(bundle.get("support_id") or "")
    message = str(bundle.get("message") or "")
    graph = bundle.get("graph") if isinstance(bundle.get("graph"), dict) else {}
    logs = bundle.get("logs") if isinstance(bundle.get("logs"), list) else []
    errors = bundle.get("errors") if isinstance(bundle.get("errors"), list) else []
    selected_nodes = bundle.get("selected_nodes") if isinstance(bundle.get("selected_nodes"), list) else []
    session_history = bundle.get("session_history") if isinstance(bundle.get("session_history"), list) else []
    selected_family = str(bundle.get("selected_family") or "")
    use_gguf = bool(bundle.get("use_gguf"))

    avail = bundle.get("available_resources") if isinstance(bundle.get("available_resources"), dict) else {}
    models_map = avail.get("models") if isinstance(avail.get("models"), dict) else {}
    model_count = sum(len(v) for v in models_map.values()) if models_map else 0

    node_count = len(graph.get("nodes", [])) if isinstance(graph.get("nodes"), list) else 0

    printable = {
        "support_id": support_id,
        "message": message,
        "graph_node_count": node_count,
        "log_count": len(logs),
        "error_count": len(errors),
        "selected_nodes": selected_nodes,
        "session_history_count": len(session_history),
        "selected_family": selected_family or "(auto-detect)",
        "use_gguf": use_gguf,
        "available_models": model_count,
        "timestamp": _now_iso(),
    }

    _safe_print("\n[Operation Faith] SUPPORT_BUNDLE_RECEIVED")
    _safe_print(json.dumps(printable, ensure_ascii=False, indent=2))
    _safe_print("[Operation Faith] END_SUPPORT_BUNDLE\n")


# ── Payload Extraction (for install_workflow route) ───────────────────

def _extract_operation_payload(data: dict[str, Any]) -> dict[str, Any] | None:
    """Extract an ACTION payload from incoming data.

    Supports direct ACTION payloads, raw workflow objects,
    and OPERATION_FAITH_INSTALL blocks.
    """
    direct_payload = data.get("action_payload")
    if isinstance(direct_payload, dict):
        data = direct_payload

    if str(data.get("response_type") or "").upper() == "ACTION" and isinstance(data.get("operation"), dict):
        return {
            "response_type": "ACTION",
            "text_response": str(data.get("text_response") or "Architect action queued."),
            "operation": data.get("operation"),
        }

    workflow = data.get("workflow")
    if isinstance(workflow, dict):
        return {
            "response_type": "ACTION",
            "text_response": str(data.get("text_response") or "Architect workflow overwrite queued."),
            "operation": {
                "type": "overwrite",
                "workflow": workflow,
            },
        }

    if isinstance(workflow, str):
        try:
            parsed = json.loads(workflow)
            if isinstance(parsed, dict):
                return {
                    "response_type": "ACTION",
                    "text_response": str(data.get("text_response") or "Architect workflow overwrite queued."),
                    "operation": {"type": "overwrite", "workflow": parsed},
                }
        except Exception:
            pass

    block_text = str(data.get("install_block") or data.get("workflow_code") or data.get("content") or "")
    if "OPERATION_FAITH_INSTALL" in block_text:
        start = block_text.find("{")
        end = block_text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(block_text[start: end + 1])
                if isinstance(parsed, dict):
                    return _extract_operation_payload(parsed)
            except Exception:
                pass

    return None


# ── Route Handlers ────────────────────────────────────────────────────

async def handle_ping(_request: web.Request) -> web.Response:
    uptime = round(time.time() - _BOOT_TIME, 1)
    _log_request("GET /", "ping")
    return web.json_response(
        {
            "status": "ready",
            "agent": f"Operation Faith Relay v{_LISTENER_VERSION}",
            "mode": "passthrough",
            "uptime_s": uptime,
        },
        headers=_cors_headers(),
    )


async def handle_health(_request: web.Request) -> web.Response:
    _log_request("GET /health", "health")
    return web.json_response({"ok": True}, headers=_cors_headers())


async def handle_options(_request: web.Request) -> web.Response:
    return web.Response(status=204, headers=_cors_headers())


async def handle_support_request(request: web.Request) -> web.Response:
    """Receive support bundle from ComfyUI panel.

    PURE PASSTHROUGH — logs the bundle to stdout for the Architect to read.
    Returns a simple acknowledgement. The Architect (LLM) does ALL reasoning
    and sends actions back via /agent/install_workflow.
    """
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"ok": False, "error": "Invalid JSON."},
            status=400, headers=_cors_headers(),
        )

    message = str(data.get("message") or "").strip()
    graph = data.get("graph") if isinstance(data.get("graph"), dict) else {}
    logs = data.get("logs") if isinstance(data.get("logs"), list) else []
    errors = data.get("errors") if isinstance(data.get("errors"), list) else logs
    selected_nodes = data.get("selected_nodes") if isinstance(data.get("selected_nodes"), list) else []
    session_history = data.get("session_history") if isinstance(data.get("session_history"), list) else []
    support_id = str(data.get("support_id") or f"support-{uuid.uuid4().hex[:8]}")
    model_family = str(data.get("model_family") or "").strip()
    mode = str(data.get("mode") or "ask").strip().lower()
    selected_family = str(data.get("selected_family") or "").strip()
    use_gguf = bool(data.get("use_gguf"))
    intent = str(data.get("intent") or "").strip()
    raw_arch = data.get("architecture")
    architecture = raw_arch if isinstance(raw_arch, dict) else {}

    summary = (f"support_id={support_id} msg={len(message)}ch graph_nodes={len(graph.get('nodes', []))}"
               f" errors={len(errors)} model={model_family or 'default'} mode={mode}"
               f" selected_family={selected_family or '(auto)'} use_gguf={use_gguf}"
               f" intent={intent or '(none)'} arch={architecture.get('family', '?')}/{architecture.get('engine', '?')}")
    _log_request("POST /agent/support_request", summary)

    # ── REQUEST BOUNDARY: keep listener log history, append marker ──
    if _logger.handlers:
         _logger.info(f"=== New request boundary (logs preserved, support_id={support_id}) ===")

    # Archive to inbox
    inbox_entry = {
        "support_id": support_id,
        "message": message,
        "graph": graph,
        "logs": logs,
        "errors": errors,
        "selected_nodes": selected_nodes,
        "session_history": session_history,
        "model_family": model_family,
        "mode": mode,
        "selected_family": selected_family,
        "use_gguf": use_gguf,
        "intent": intent,
        "architecture": architecture,
        "available_resources": data.get("available_resources") if isinstance(data.get("available_resources"), dict) else {},
        "family_data": data.get("family_data") if isinstance(data.get("family_data"), dict) else {},
        "timestamp": _now_iso(),
    }
    _SUPPORT_INBOX.append(inbox_entry)
    if len(_SUPPORT_INBOX) > _MAX_INBOX:
        _SUPPORT_INBOX[:] = _SUPPORT_INBOX[-_MAX_INBOX:]
    
    # Persist state
    _save_state()

    # Print to stdout — this is the Architect's eyes
    _print_support_bundle(inbox_entry)

    # Pure passthrough acknowledgement — NO classification, NO responses
    return web.json_response(
        {
            "ok": True,
            "mode": "passthrough",
            "response_type": "WAITING",
            "text_response": "Architect is reviewing your request...",
            "support_id": support_id,
        },
        headers=_cors_headers(),
    )


async def handle_review(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"ok": False, "error": "Invalid JSON."},
            status=400, headers=_cors_headers(),
        )

    msg = str(data.get("message") or "")
    _log_request("POST /agent/review_request", f"msg_len={len(msg)}")
    _safe_print(f"[{_now_iso()}] Review request: {msg[:160]}")

    return web.json_response(
        {
            "ok": True,
            "received": True,
            "review_id": f"rev-{int(time.time())}",
            "message": "Review bundle received and logged.",
        },
        headers=_cors_headers(),
    )


async def handle_install_workflow(request: web.Request) -> web.Response:
    """POST /agent/install_workflow — Architect pushes workflow to frontend.

    This is the Architect's hand. When the LLM builds a workflow or patch,
    it POSTs here and the frontend picks it up via GET /agent/get_pending.
    """
    global _PENDING_INSTALL

    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"ok": False, "error": "Invalid JSON."},
            status=400, headers=_cors_headers(),
        )

    action_payload = _extract_operation_payload(data)
    if not isinstance(action_payload, dict):
        return web.json_response(
            {
                "ok": False,
                "error": "Provide ACTION payload, workflow object, or OPERATION_FAITH_INSTALL block.",
            },
            status=400, headers=_cors_headers(),
        )

    install_id = str(data.get("id") or f"install-{int(time.time())}")
    reasoning = str(data.get("reasoning") or "Resident Architect install")
    operation_type = str(action_payload.get("operation", {}).get("type") or "overwrite")

    _PENDING_INSTALL = {
        "id": install_id,
        "reasoning": reasoning,
        "action_payload": action_payload,
        "timestamp": _now_iso(),
    }
    _save_state()
    _log_request("POST /agent/install_workflow", f"id={install_id} type={operation_type}")
    _safe_print(f"[INSTALL] Architect pushed: {install_id} ({operation_type})")

    return web.json_response(
        {"ok": True, "status": "queued_for_gui", "id": install_id},
        headers=_cors_headers(),
    )


async def handle_respond(request: web.Request) -> web.Response:
    """POST /agent/respond — Architect pushes ANY response (CHAT or ACTION).

    This is the Architect's voice. For text responses, push:
        {"response_type": "CHAT", "text_response": "..."}

    For workflow installs, push:
        {"response_type": "ACTION", "text_response": "...", "operation": {...}}

    The frontend picks these up via GET /agent/get_pending.
    """
    global _PENDING_INSTALL

    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"ok": False, "error": "Invalid JSON."},
            status=400, headers=_cors_headers(),
        )

    response_type = str(data.get("response_type", "CHAT")).upper()
    text_response = str(data.get("text_response", ""))
    respond_id = str(data.get("id") or f"respond-{int(time.time())}")

    action_payload: dict[str, Any] = {
        **(data if isinstance(data, dict) else {}),
        "response_type": response_type,
        "text_response": text_response,
    }

    pending: dict[str, Any] = {
        "id": respond_id,
        "reasoning": str(data.get("reasoning", "Architect response")),
        "action_payload": action_payload,
        "timestamp": _now_iso(),
    }

    if data.get("workflow_name"):
        pending["workflow_name"] = str(data["workflow_name"])

    _PENDING_INSTALL = pending
    _save_state()
    _log_request("POST /agent/respond", f"id={respond_id} type={response_type}")
    _safe_print(f"[RESPOND] Architect pushed: {respond_id} ({response_type})")

    return web.json_response(
        {"ok": True, "status": "queued", "id": respond_id, "response_type": response_type},
        headers=_cors_headers(),
    )


async def handle_get_pending(_request: web.Request) -> web.Response:
    """GET /agent/get_pending — frontend polls for Architect responses (CHAT or ACTION)."""
    global _PENDING_INSTALL

    pending = _PENDING_INSTALL
    _PENDING_INSTALL = None
    if pending:
        # State changed (cleared pending), so save
        _save_state()
        _log_request("GET /agent/get_pending", f"delivered id={pending.get('id')}")
        return web.json_response({"ok": True, **pending}, headers=_cors_headers(),
    )

    return web.json_response({"ok": True, "workflow": None}, headers=_cors_headers())


async def handle_log(_request: web.Request) -> web.Response:
    return web.json_response(
        {"ok": True, "log": _REQUEST_LOG, "count": len(_REQUEST_LOG)},
        headers=_cors_headers(),
    )


async def handle_workspace(_request: web.Request) -> web.Response:
    _log_request("GET /workspace", f"root={_WORKSPACE_ROOT}")
    return web.json_response(
        {"ok": True, "workspace": _WORKSPACE_ROOT},
        headers=_cors_headers(),
    )


async def handle_inbox(_request: web.Request) -> web.Response:
    return web.json_response(
        {"ok": True, "count": len(_SUPPORT_INBOX), "items": _SUPPORT_INBOX[-10:]},
        headers=_cors_headers(),
    )


async def handle_get_models(_request: web.Request) -> web.Response:
    """GET /agent/models — frontend fetches available LLM models for selector."""
    _log_request("GET /agent/models", f"count={len(_AVAILABLE_MODELS)}")
    return web.json_response(
        {"ok": True, "models": _AVAILABLE_MODELS, "default_family": _DEFAULT_MODEL_FAMILY},
        headers=_cors_headers(),
    )


async def handle_set_models(request: web.Request) -> web.Response:
    """POST /agent/models — extension pushes available models with cost tiers."""
    global _AVAILABLE_MODELS
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"ok": False, "error": "Invalid JSON."},
            status=400, headers=_cors_headers(),
        )

    models = data.get("models")
    if not isinstance(models, list):
        return web.json_response(
            {"ok": False, "error": "Expected 'models' array."},
            status=400, headers=_cors_headers(),
        )

    _AVAILABLE_MODELS = models

    # Update default family if extension specifies one
    global _DEFAULT_MODEL_FAMILY
    pushed_default = str(data.get("default_family") or "").strip()
    if pushed_default:
        _DEFAULT_MODEL_FAMILY = pushed_default
    else:
        _DEFAULT_MODEL_FAMILY = "gpt-4o-mini"

    _log_request("POST /agent/models", f"received {len(models)} models, default={_DEFAULT_MODEL_FAMILY}")
    _safe_print(f"[MODELS] Extension pushed {len(models)} available models")
    return web.json_response(
        {"ok": True, "count": len(models)},
        headers=_cors_headers(),
    )


async def handle_library_list(_request: web.Request) -> web.Response:
    """GET /library/list — List available workflows in the library."""
    if not _LIBRARY_ROOT or not os.path.exists(_LIBRARY_ROOT):
        return web.json_response({"ok": False, "error": "Library path not configured or missing."}, headers=_cors_headers())
    
    files = []
    try:
        for f in os.listdir(_LIBRARY_ROOT):
            if f.endswith(".json"):
                files.append(f)
        files.sort()
        _log_request("GET /library/list", f"found {len(files)} workflows")
        return web.json_response({"ok": True, "files": files}, headers=_cors_headers())
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, headers=_cors_headers())


async def handle_library_load(request: web.Request) -> web.Response:
    """GET /library/load/{filename} — Load a specific workflow file."""
    filename = request.match_info.get("filename", "")
    if not filename or ".." in filename or "/" in filename or "\\" in filename: # Basic traversal protection
         return web.json_response({"ok": False, "error": "Invalid filename."}, status=400, headers=_cors_headers())

    filepath = os.path.join(_LIBRARY_ROOT, filename)
    if not os.path.exists(filepath):
        return web.json_response({"ok": False, "error": "File not found."}, status=404, headers=_cors_headers())
    
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = json.load(f)
        _log_request(f"GET /library/load/{filename}", "served workflow")
        return web.json_response({"ok": True, "workflow": content}, headers=_cors_headers())
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, headers=_cors_headers())


async def handle_catch_all(request: web.Request) -> web.Response:
    route = f"{request.method} {request.path}"
    _log_request(route, "catch-all")
    _safe_print(f"[{_now_iso()}] Unmatched route: {route}")
    return web.json_response(
        {"ok": True, "note": f"Listener acknowledged {route}"},
        headers=_cors_headers(),
    )


# ── Error Middleware ──────────────────────────────────────────────────

@web.middleware
async def safe_error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except Exception as exc:
        route = f"{request.method} {request.path}"
        _log_request(route, f"internal_error={type(exc).__name__}")
        _safe_print(f"[Operation Faith] INTERNAL ERROR on {route}: {exc}")
        _safe_print(traceback.format_exc())
        return web.json_response(
            {
                "ok": True,
                "mode": "passthrough",
                "text_response": "Listener recovered from an internal error. Retry once.",
                "listener_error": str(exc),
            },
            headers=_cors_headers(),
        )


# ── App Factory ───────────────────────────────────────────────────────

def build_app() -> web.Application:
    application = web.Application(middlewares=[safe_error_middleware])
    application.add_routes([
        web.get("/", handle_ping),
        web.get("/health", handle_health),
        web.get("/log", handle_log),
        web.get("/workspace", handle_workspace),
        web.get("/inbox", handle_inbox),
        web.get("/agent/models", handle_get_models),
        web.post("/agent/models", handle_set_models),
        web.post("/agent/install_workflow", handle_install_workflow),
        web.post("/agent/respond", handle_respond),
        web.get("/agent/get_pending", handle_get_pending),
        web.post("/agent/support_request", handle_support_request),
        web.post("/agent/review_request", handle_review),
        web.get("/library/list", handle_library_list),
        web.get("/library/load/{filename}", handle_library_load),
        web.options("/{path:.*}", handle_options),
    ])
    application.router.add_route("*", "/{path:.*}", handle_catch_all)
    return application


# ── Port Check & Main ─────────────────────────────────────────────────

def _port_in_use(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(1)
        sock.connect((host, port))
        return True
    except (ConnectionRefusedError, OSError):
        return False
    finally:
        sock.close()


def main() -> None:
    global _WORKSPACE_ROOT
    parser = argparse.ArgumentParser(description="Operation Faith Agent Listener")
    parser.add_argument("--port", type=int, default=1337, help="Port (default: 1337)")
    # parser.add_argument("--host", type=str, default="127.0.0.1", help="Host (default: 127.0.0.1)") # REMOVED for security
    parser.add_argument("--workspace", type=str, default="", help="Workspace root path")
    args = parser.parse_args()

    import os
    _WORKSPACE_ROOT = args.workspace.strip() if args.workspace.strip() else os.getcwd()
    
    # Load .env if present
    _load_env(os.path.join(_WORKSPACE_ROOT, ".env"))

    global _STATE_FILE_PATH, _LIBRARY_ROOT
    _STATE_FILE_PATH = os.path.join(_WORKSPACE_ROOT, "LOGS", "listener_state.json")
    _LIBRARY_ROOT = os.path.join(_WORKSPACE_ROOT, "Release", "workflow_library")
    # ── Security & Hygiene ──
    _cleanup_old_logs(os.path.join(_WORKSPACE_ROOT, "LOGS"))
    
    # Load persisted state
    _load_state()

    # STRICT LOCALHOST BINDING
    HOST = "127.0.0.1"

    if _port_in_use(HOST, args.port):
        print(f"[ABORT] Port {args.port} already in use. Kill the existing listener first.")
        sys.exit(1)

    _safe_print(f"Operation Faith Agent Listener v{_LISTENER_VERSION}")
    _safe_print(f"  Mode: PURE PASSTHROUGH (Constitution compliant)")
    _safe_print(f"  Workspace: {_WORKSPACE_ROOT}")
    _safe_print(f"  Listening: http://{HOST}:{args.port} (SECURITY: Localhost locked)")
    _safe_print(f"  State Persistence: {_STATE_FILE_PATH}")
    _safe_print(f"  Routes:")
    _safe_print(f"    GET  /                        → ping")
    _safe_print(f"    GET  /health                  → health check")
    _safe_print(f"    GET  /log                     → request log")
    _safe_print(f"    GET  /workspace               → workspace root")
    _safe_print(f"    GET  /inbox                   → support inbox")
    _safe_print(f"    GET  /agent/get_pending        → frontend polls for Architect responses")
    _safe_print(f"    POST /agent/respond             → Architect pushes CHAT or ACTION")
    _safe_print(f"    POST /agent/install_workflow   → Architect pushes workflow/patch")
    _safe_print(f"    POST /agent/support_request    → ComfyUI sends support bundles")
    _safe_print(f"    POST /agent/review_request     → ComfyUI sends review bundles")
    _safe_print(f"  Press Ctrl+C to stop.\n")

    # Hardcoded host for security
    web.run_app(build_app(), host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
