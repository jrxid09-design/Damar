import asyncio
import json
import os
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from gemini_webapi import GeminiClient


app = FastAPI()


client = GeminiClient(
    os.environ.get("GEMINI_1PSID"),
    os.environ.get("GEMINI_1PSIDTS"),
)


class SimpleChatRequest(BaseModel):
    prompt: str


class Message(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[Message]
    stream: bool = False


@app.on_event("startup")
async def startup():
    await client.init(timeout=30)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {
                "id": "gemini-web",
                "object": "model",
                "owned_by": "google-web",
            }
        ],
    }


def build_prompt(messages):
    parts = []

    for message in messages:
        parts.append(
            f"{message.role.upper()}: {message.content}"
        )

    return "\n\n".join(parts)


@app.post("/chat")
async def simple_chat(req: SimpleChatRequest):
    try:
        response = await client.generate_content(req.prompt)

        return {
            "text": response.text
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc)
        )


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):

    try:
        prompt = build_prompt(req.messages)

        response = await client.generate_content(prompt)

        text = response.text or ""

        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())
        model = req.model or "gemini-web"

        # ---------------------------------------
        # NON-STREAM
        # ---------------------------------------

        if not req.stream:

            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": text,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                },
            }

        # ---------------------------------------
        # OPENAI-COMPATIBLE SSE STREAM
        # ---------------------------------------

        async def event_stream():

            first = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant"
                        },
                        "finish_reason": None,
                    }
                ],
            }

            yield f"data: {json.dumps(first)}\n\n"

            # Gemini Web API sudah menghasilkan response utuh.
            # Pecah menjadi chunk agar pipeline streaming Aether
            # tetap menerima format OpenAI SSE yang diharapkan.

            chunk_size = 40

            for i in range(0, len(text), chunk_size):

                content = text[i:i + chunk_size]

                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "content": content
                            },
                            "finish_reason": None,
                        }
                    ],
                }

                yield f"data: {json.dumps(chunk)}\n\n"

                await asyncio.sleep(0)

            final = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                },
            }

            yield f"data: {json.dumps(final)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    except Exception as exc:

        raise HTTPException(
            status_code=500,
            detail=str(exc)
        )