from __future__ import annotations
import asyncio
import base64
import os
from collections import OrderedDict
from pathlib import Path
import edge_tts
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from visemes import make_timeline

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Avatar Head · EdgeTTS", docs_url=None, redoc_url=None)
VOICES = ("zh-TW-HsiaoChenNeural", "zh-TW-HsiaoYuNeural")
cache: OrderedDict[tuple, dict] = OrderedDict()
generation_lock = asyncio.Semaphore(2)

class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str = VOICES[0]
    rate: int = Field(default=0, ge=-30, le=30)
    pitch: int = Field(default=0, ge=-20, le=20)

@app.get("/api/health")
async def health():
    return {"ok": True, "tts": "edge-tts", "voices": VOICES}

@app.post("/api/tts")
async def tts(body: SpeechRequest, request: Request):
    # Local demo only. Reject cross-origin requests to the loopback service.
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "請從本機試說頁面操作。")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "請先輸入想說的文字。")
    if body.voice not in VOICES:
        raise HTTPException(400, "請選擇提供的台灣女聲。")
    key = (text, body.voice, body.rate, body.pitch)
    if key in cache:
        cache.move_to_end(key)
        return cache[key]
    async with generation_lock:
        # Re-check after waiting; another request may have populated the cache.
        if key in cache:
            return cache[key]
        async def generate():
            # Optional explicit CA bundle for a trusted corporate proxy.
            # Verification stays enabled; no unverified SSL fallback is used.
            if ca_bundle := os.environ.get("AVATAR_TTS_CA_BUNDLE"):
                from edge_tts.communicate import _SSL_CTX
                _SSL_CTX.load_verify_locations(ca_bundle)
            communicate = edge_tts.Communicate(
                text, body.voice, rate=f"{body.rate:+d}%", pitch=f"{body.pitch:+d}Hz",
                boundary="WordBoundary", connect_timeout=10, receive_timeout=30,
            )
            audio = bytearray()
            words = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    words.append({k: chunk[k] for k in ("offset", "duration", "text")})
            if not audio:
                raise RuntimeError("沒有收到音訊。")
            return {
                "audio": base64.b64encode(audio).decode("ascii"),
                "mime": "audio/mpeg", "words": words,
                "visemes": make_timeline(words), "text": text,
                "voice": body.voice, "timing": "word-boundary-pinyin-approximation",
            }
        try:
            result = await asyncio.wait_for(generate(), timeout=60)
        except asyncio.TimeoutError as exc:
            raise HTTPException(504, "EdgeTTS 回應逾時，請稍後再試。") from exc
        except Exception as exc:
            print(f"EdgeTTS error: {type(exc).__name__}: {exc}")
            raise HTTPException(502, "目前無法連上 EdgeTTS，請確認網路後再試。") from exc
        cache[key] = result
        while len(cache) > 12:
            cache.popitem(last=False)
        return result

@app.get("/")
async def index():
    return FileResponse(ROOT / "public" / "index.html")

@app.get("/api/character")
async def character():
    return FileResponse(ROOT / "data" / "Mio 米歐.vrm", media_type="model/gltf-binary")

app.mount("/", StaticFiles(directory=ROOT / "public"), name="public")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AVATAR_PORT", "8765")))
