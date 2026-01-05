import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import websockets

DATA_DIR = Path("/data")
PROMPTS_DIR = DATA_DIR / "prompts"
SETTINGS_FILE = DATA_DIR / "settings.json"
REPEAT_STATE_FILE = DATA_DIR / "repeat_state.json"

app = FastAPI()

templates = Jinja2Templates(directory="app/templates")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

_object_info_cache: Dict[str, Any] = {}
_repeat_state: Dict[str, Any] = {}
_repeat_task: Optional[asyncio.Task] = None
_repeat_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_base_url(base_url: str) -> str:
    if not base_url:
        raise HTTPException(status_code=400, detail="base_url is required")
    return base_url.rstrip("/")


def _ws_url_from_base(base_url: str, client_id: str) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    netloc = parsed.netloc
    if not netloc:
        raise HTTPException(status_code=400, detail="Invalid base_url")
    return f"{scheme}://{netloc}/ws?{urlencode({'clientId': client_id})}"


def _ensure_data_dirs() -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Failed to create data directories: {exc}")


def _default_repeat_state() -> Dict[str, Any]:
    return {
        "active": False,
        "base_url": "",
        "prompt": None,
        "last_prompt_id": None,
        "last_error": None,
        "last_started_at": None,
        "last_finished_at": None,
        "runs": 0,
    }


def _load_repeat_state() -> Dict[str, Any]:
    if not REPEAT_STATE_FILE.exists():
        return _default_repeat_state()
    try:
        data = json.loads(REPEAT_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Failed to read repeat state: {exc}")
        return _default_repeat_state()
    default = _default_repeat_state()
    if isinstance(data, dict):
        default.update(data)
    return default


def _save_repeat_state(data: Dict[str, Any]) -> None:
    try:
        REPEAT_STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save repeat state: {exc}")


async def _set_repeat_state(update: Dict[str, Any]) -> Dict[str, Any]:
    async with _repeat_lock:
        _repeat_state.update(update)
        _save_repeat_state(_repeat_state)
        return dict(_repeat_state)


async def _get_repeat_state() -> Dict[str, Any]:
    async with _repeat_lock:
        return dict(_repeat_state)


async def _repeat_active() -> bool:
    async with _repeat_lock:
        return bool(_repeat_state.get("active"))


async def _wait_for_history(client: httpx.AsyncClient, base_url: str, prompt_id: str) -> bool:
    while await _repeat_active():
        resp = await client.get(f"{base_url}/history/{prompt_id}")
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict) and prompt_id in data:
            return True
        await asyncio.sleep(2)
    return False


async def _repeat_loop() -> None:
    global _repeat_task
    try:
        while await _repeat_active():
            async with _repeat_lock:
                base_url = _repeat_state.get("base_url") or ""
                prompt = _repeat_state.get("prompt")
            if not base_url or prompt is None:
                await _set_repeat_state(
                    {
                        "active": False,
                        "last_error": "連続実行の設定が不足しています。",
                    }
                )
                break
            started_at = _now_iso()
            await _set_repeat_state({"last_started_at": started_at, "last_error": None})
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.post(
                        f"{base_url}/prompt",
                        json={"prompt": prompt, "client_id": str(uuid.uuid4())},
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    prompt_id = data.get("prompt_id") or data.get("id")
                    if not prompt_id:
                        raise HTTPException(status_code=502, detail="Invalid response from ComfyUI")
                    await _set_repeat_state({"last_prompt_id": prompt_id})
                    completed = await _wait_for_history(client, base_url, prompt_id)
                if completed:
                    state = await _get_repeat_state()
                    await _set_repeat_state(
                        {
                            "last_finished_at": _now_iso(),
                            "runs": int(state.get("runs") or 0) + 1,
                        }
                    )
            except Exception as exc:
                await _set_repeat_state({"last_error": str(exc)})
                await asyncio.sleep(5)
    finally:
        _repeat_task = None


def _ensure_repeat_task() -> None:
    global _repeat_task
    if _repeat_task is None or _repeat_task.done():
        _repeat_task = asyncio.create_task(_repeat_loop())


def _load_settings() -> Dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Failed to read settings: {exc}")
        return {}


def _save_settings(data: Dict[str, Any]) -> None:
    try:
        SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save settings: {exc}")


def _prompt_file(prompt_id: str) -> Path:
    return PROMPTS_DIR / f"{prompt_id}.json"


@app.on_event("startup")
async def _startup() -> None:
    _ensure_data_dirs()
    global _repeat_state
    _repeat_state = _load_repeat_state()
    if _repeat_state.get("active"):
        _ensure_repeat_task()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    settings = _load_settings()
    default_base_url = settings.get("default_comfy_base_url", "")
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "default_base_url": default_base_url},
    )


@app.get("/api/settings")
async def get_settings() -> JSONResponse:
    settings = _load_settings()
    return JSONResponse(settings)


@app.post("/api/settings")
async def save_settings(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    default_base_url = payload.get("default_comfy_base_url", "")
    _save_settings({"default_comfy_base_url": default_base_url})
    return JSONResponse({"status": "ok"})


@app.get("/api/object_info")
async def get_object_info(base_url: str) -> JSONResponse:
    base_url = _safe_base_url(base_url)
    if base_url in _object_info_cache:
        return JSONResponse(_object_info_cache[base_url])
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(f"{base_url}/object_info")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    data = resp.json()
    _object_info_cache[base_url] = data
    return JSONResponse(data)


@app.get("/api/object_info/{node_class}")
async def get_object_info_class(node_class: str, base_url: str) -> JSONResponse:
    base_url = _safe_base_url(base_url)
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(f"{base_url}/object_info/{node_class}")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return JSONResponse(resp.json())


@app.post("/api/queue")
async def queue_prompt(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    base_url = _safe_base_url(payload.get("base_url", ""))
    prompt = payload.get("prompt")
    if prompt is None:
        raise HTTPException(status_code=400, detail="prompt is required")
    client_id = str(uuid.uuid4())
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            resp = await client.post(
                f"{base_url}/prompt",
                json={"prompt": prompt, "client_id": client_id},
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    data = resp.json()
    prompt_id = data.get("prompt_id") or data.get("id")
    if not prompt_id:
        raise HTTPException(status_code=502, detail="Invalid response from ComfyUI")
    return JSONResponse({"prompt_id": prompt_id, "client_id": client_id})


@app.get("/api/repeat/status")
async def repeat_status() -> JSONResponse:
    state = await _get_repeat_state()
    state.pop("prompt", None)
    return JSONResponse(state)


@app.post("/api/repeat/start")
async def repeat_start(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    base_url = _safe_base_url(payload.get("base_url", ""))
    prompt = payload.get("prompt")
    if prompt is None:
        raise HTTPException(status_code=400, detail="prompt is required")
    state = await _set_repeat_state(
        {
            "active": True,
            "base_url": base_url,
            "prompt": prompt,
            "last_error": None,
        }
    )
    _ensure_repeat_task()
    state.pop("prompt", None)
    return JSONResponse(state)


@app.post("/api/repeat/stop")
async def repeat_stop() -> JSONResponse:
    state = await _set_repeat_state({"active": False})
    state.pop("prompt", None)
    return JSONResponse(state)


@app.get("/api/history")
async def get_history(base_url: str, prompt_id: str) -> JSONResponse:
    base_url = _safe_base_url(base_url)
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(f"{base_url}/history/{prompt_id}")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return JSONResponse(resp.json())


@app.get("/api/view")
async def proxy_view(
    base_url: str,
    filename: str,
    subfolder: Optional[str] = None,
    type: Optional[str] = None,
) -> StreamingResponse:
    base_url = _safe_base_url(base_url)
    params = {"filename": filename}
    if subfolder:
        params["subfolder"] = subfolder
    if type:
        params["type"] = type
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            resp = await client.get(f"{base_url}/view", params=params)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return StreamingResponse(resp.aiter_bytes(), media_type=resp.headers.get("content-type"))


@app.get("/api/prompts")
async def list_prompts() -> JSONResponse:
    items = []
    for path in sorted(PROMPTS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append(
            {
                "id": data.get("id"),
                "title": data.get("title"),
                "created_at": data.get("created_at"),
                "updated_at": data.get("updated_at"),
            }
        )
    return JSONResponse({"items": items})


@app.get("/api/prompts/{prompt_id}")
async def get_prompt(prompt_id: str) -> JSONResponse:
    path = _prompt_file(prompt_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Prompt not found")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read prompt: {exc}")
    return JSONResponse(data)


@app.post("/api/prompts")
async def save_prompt(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    title = (payload.get("title") or "").strip()
    prompt_json = payload.get("prompt_json")
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    if prompt_json is None:
        raise HTTPException(status_code=400, detail="prompt_json is required")
    prompt_id = payload.get("id") or str(uuid.uuid4())
    now = _now_iso()
    data = {
        "id": prompt_id,
        "title": title,
        "created_at": payload.get("created_at") or now,
        "updated_at": now,
        "prompt_json": prompt_json,
    }
    path = _prompt_file(prompt_id)
    try:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save prompt: {exc}")
    return JSONResponse({"status": "ok", "id": prompt_id})


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str) -> JSONResponse:
    path = _prompt_file(prompt_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Prompt not found")
    try:
        path.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete prompt: {exc}")
    return JSONResponse({"status": "ok"})


@app.websocket("/api/ws")
async def ws_proxy(websocket: WebSocket, base_url: str, client_id: str) -> None:
    await websocket.accept()
    base_url = _safe_base_url(base_url)
    ws_url = _ws_url_from_base(base_url, client_id)
    try:
        async with websockets.connect(ws_url) as upstream:
            async def receive_from_comfy() -> None:
                async for message in upstream:
                    await websocket.send_text(message)

            async def receive_from_client() -> None:
                while True:
                    await websocket.receive_text()

            await asyncio.gather(receive_from_comfy(), receive_from_client())
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await websocket.send_text(json.dumps({"type": "proxy_error", "message": str(exc)}))
        await websocket.close()
