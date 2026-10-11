# Embedding configuration

Sign in to Bottle and open the standalone **Settings** page (`/settings`), then use the **Embeddings** section. Configuration is saved per account and applies to local document search and GitHub Stars indexing/search.

- **Local model:** enter a Sentence Transformers model ID or a local model directory. The default is `Qwen/Qwen3-Embedding-0.6B`. A model ID may require a download on first use; a local directory can be used offline.
- **OpenAI-compatible API:** enter the API Base URL (for example `https://api.openai.com/v1`), embedding model ID, and API key. Bottle sends `POST {base_url}/embeddings` with `input`, `model`, and `encoding_format: float`. Optional dimensions and a request timeout are available under advanced options. The endpoint must support the [OpenAI embeddings format](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

**Test connection** embeds a short sample without saving the form. Testing a remote API can incur provider charges; testing a local model can download it. **Save settings** persists the configuration without making an embedding request.

API keys are stored on the server in its SQLite database, with file permissions restricted to the process owner. They are not encrypted at rest. Settings responses never return the key. Leave the key field empty to retain an existing key for the same endpoint, or choose **Remove saved key**. Changing endpoints does not reuse a stored key. Remote providers receive document passages and search queries to create embeddings.

After changing the provider, model, endpoint, or dimensions, reimport the affected GitHub documents from **Library**. Existing vectors from a different configuration are excluded from search. Local document embeddings are rebuilt on the next search and cached in server memory. Settings cannot be changed while an import worker is active.

Accounts without saved settings use the defaults in `apps/api/.env`. Existing local and Voyage environment configuration remains supported. OpenAI-compatible defaults use `EMBEDDING_PROVIDER=openai`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_API_KEY`, optional `OPENAI_EMBEDDING_DIMENSIONS`, and `EMBEDDING_TIMEOUT_SECONDS` (default 60). The CLI and private `/api/search` requests without `user_id` retain their lightweight TF-IDF retrieval mode.

The browser calls authenticated NestJS endpoints at `GET /api/settings/embedding`, `POST /api/settings/embedding`, and `POST /api/settings/embedding/test`. NestJS supplies the account ID from the session. The Python API is an internal service and should not be exposed publicly.
