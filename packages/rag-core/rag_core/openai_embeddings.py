"""OpenAI-compatible embeddings over the standard library HTTP client."""

from __future__ import annotations

import json
import math
import ssl
import http.client
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def api_settings() -> dict[str, object]:
    from .embedding_settings import current_config
    config = current_config()
    config.validate()
    return {"base_url": config.base_url, "model": config.model, "dimensions": config.dimensions, "timeout": config.timeout}


def embed(text: str) -> list[float]:
    if not text.strip():
        raise ValueError("Embedding input must not be empty")
    config = api_settings()
    body = {"model": config["model"], "input": [text], "encoding_format": "float"}
    if config["dimensions"] is not None:
        body["dimensions"] = config["dimensions"]
    headers = {"Content-Type": "application/json"}
    from .embedding_settings import current_config
    api_key = current_config().api_key
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif urllib.parse.urlsplit(str(config["base_url"])).hostname == "api.openai.com":
        raise ValueError("OPENAI_API_KEY is required for api.openai.com")
    request = urllib.request.Request(f"{config['base_url']}/embeddings", data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=config["timeout"]) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # Upstream bodies may contain private input or credentials. Do not expose them.
        error.close()
        messages = {401: "Embedding API authentication failed. Check the API key.", 403: "Embedding API access denied.", 404: "Embedding API endpoint or model was not found.", 429: "Embedding API rate limit reached. Please try again later."}
        raise RuntimeError(messages.get(error.code, f"Embedding API request failed (HTTP {error.code}).")) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError, http.client.HTTPException):
        raise RuntimeError("Unable to connect to the embedding API. Check the Base URL, network, and proxy settings.") from None
    except (ValueError, UnicodeError) as error:
        raise RuntimeError("Embedding API returned invalid JSON.") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list) or len(payload["data"]) != 1:
        raise RuntimeError("Embedding API returned an invalid embedding response.")
    item = payload["data"][0]
    vector = item.get("embedding") if isinstance(item, dict) else None
    if not isinstance(vector, list) or not vector or any(type(value) not in {int, float} or not math.isfinite(value) for value in vector):
        raise RuntimeError("Embedding API must return a nonempty vector of finite numbers.")
    if config["dimensions"] is not None and len(vector) != config["dimensions"]:
        raise RuntimeError("Embedding API returned a vector with unexpected dimensions.")
    return [float(value) for value in vector]
