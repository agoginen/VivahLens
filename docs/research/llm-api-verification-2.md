# LLM API verification (round 2)

Condensed from a research pass on **2026-11-22** (primary sources: vendor docs, API references, Google's own Discovery document). Facts marked **UNVERIFIED** were not found in a primary source. Treat every request shape as a contract to be re-proved by the per-provider conformance test, not as a constant: vendor surfaces moved quickly (Anthropic's current `anthropic-version` is `2026-10-21`; Google calls `generateContent` "legacy"; Azure has an `/openai/v1/` surface without `api-version`).

## Changes against the previous note

| Earlier | Now |
|---|---|
| Anthropic batch discount UNVERIFIED | **50 %** of standard prices, all models |
| Gemini 258-token tile rule | Gemini 4 and 3 charge a **flat 1,120 tokens per image** at the default resolution (LOW 280, MEDIUM 560, HIGH 1,120, ULTRA_HIGH 2,240); the tile rule is the older-model rule |
| Azure image limits UNVERIFIED | 10 images per request, 20 MB per image, JPEG/PNG/GIF (first frame)/WEBP |
| Anthropic accepts `temperature` | `anthropic-version: 2026-10-21` returns 400 for `temperature`, `top_p`, `top_k`; the repo's `2023-06-01` still works |

## 1. Schema-enforced structured output

- **OpenAI Chat**: `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`. `strict` defaults to **false**, so send `true`. Responses API: `text.format` with the same fields. Name: letters, digits, `_`, `-`, ≤ 64.
- **Anthropic Messages**: `output_config: {format: {type: "json_schema", schema}}`; GA, no beta header; the JSON arrives as a string in the first `text` block. Never route Anthropic through an OpenAI-compatibility layer with `json_object` (400: that layer accepts only `json_schema` with `strict: true`). Forced `tool_choice` returns 400 on the newest models, so do not use it as the fallback.
- **Gemini generateContent**: `generationConfig.responseFormat.text.{mimeType: "APPLICATION_JSON", schema}` (the older `responseSchema` is deprecated). **Ollama** `/api/chat`: `format` is `"json"` or a schema object, and `stream` defaults to **true** (send `false`). **LM Studio** `/v1/chat/completions`: OpenAI-style `json_schema`; small models (< 7B) may not comply.
- Strict-mode rules differ. **Portable subset** (intersection): root object; every object `additionalProperties: false`; **every property required, optional values as `["T","null"]`**; shallow nesting; enums and `anyOf` (not at root); **no** recursion, `oneOf`, `allOf`, numeric or string bounds, `minItems > 1`. Enforce ranges after parsing. Anthropic caps optional parameters at 24 and union-typed ones at 16. Azure rejects numeric bounds, string constraints and `minItems`/`maxItems`.
- Failure signals: OpenAI `message.refusal` or `finish_reason: "length"`; Anthropic `stop_reason: "refusal"` (HTTP 200, billed) or `"max_tokens"`; Gemini `finishReason`, `promptFeedback.blockReason`. Keep client-side validation and the repair loop regardless.
- Consequence for `packages/core/src/llm`: the OpenAI-compatible provider sent only `json_object`; Anthropic sent no enforcement. Add a schema field to the request, send the schema form where supported, and degrade to JSON mode plus the repair loop when an endpoint refuses it.

## 2. Azure OpenAI

- **v1 API** (recommended): base `https://{resource}.openai.azure.com/openai/v1/`, no `api-version`, `model` = your **deployment name**, key auth in header **`api-key`** (or `Authorization: Bearer` with an Entra token, scope `https://ai.azure.com/.default`). A stock OpenAI client works. Dated API: `…/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21`.
- A filtered prompt returns **HTTP 400 `content_filter`**; a filtered completion has `finish_reason: "content_filter"`. Wedding and child photos can trip it: map to a distinct non-retryable per-photo error.
- Rate limits: 429 with **`retry-after-ms`** and `x-ratelimit-*` headers. Batch uses the same Files + `/batches` flow, `completion_window` must be `24h`.

## 3. Batch APIs (all 50 % of standard price)

| | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| Submit | upload JSONL (`purpose=batch`), then `POST /v1/batches` (`input_file_id`, `endpoint`, `completion_window: "24h"`) | `POST /v1/messages/batches` with `{requests: [{custom_id, params}]}`; `custom_id` matches `^[a-zA-Z0-9_-]{1,64}$` | `POST /v1beta/models/{model}:batchGenerateContent` |
| Status | `validating, in_progress, finalizing, completed, failed, expired, cancelling, cancelled` | `processing_status`: `in_progress, canceling, ended` plus `request_counts` | `BATCH_STATE_*` (SUCCEEDED, FAILED, …) |
| Results | `output_file_id` and `error_file_id`; **order not guaranteed**; key on `custom_id` | `results_url` JSONL `{custom_id, result: {type: succeeded/errored/canceled/expired}}`; order not guaranteed | responses file in input order, or inlined |
| Limits | 50,000 requests and 200 MB per file | 100,000 requests or 256 MB | inline < 20 MB; file ≤ 2 GB |
| Expiry | 24 h | 24 h | 48 h |

Anthropic validates each request's `params` only when the batch ends, so prove the request shape with the Messages API first. Base64 inflates JPEGs by about 33 %: 500 inline previews of ~300 KB are close to OpenAI's 200 MB cap, so chunk by bytes as well as count. Persist batch ids in job state; treat output order as unspecified; feed per-request errors into the "needs attention" lane.

## 4. Image input token costs (estimator)

- **OpenAI patch families** (gpt-6-astra, gpt-5.6-*, gpt-5.5, gpt-5.4*, gpt-5.2, gpt-5-mini/nano, gpt-4.1-mini/nano, o4-mini): fit to the level's maximum dimension, `patches = ⌈w/32⌉·⌈h/32⌉`, shrink when over the patch budget, `tokens = ⌈patches × multiplier⌉` with multipliers 1.2 (most), 1.5 (gpt-5-nano), 1.62 (gpt-4.1-mini), 2.46 (gpt-4.1-nano), 1.72 (o4-mini). Tile families (gpt-4o, gpt-4.1, gpt-5, o-series): base + 512-px tiles × per-tile (gpt-4o/4.1: 85 + 170/tile). Example: 1500×1000 at `high` on a 1.2× family → 1,805 tokens.
- **Anthropic**: `tokens = ⌈w/28⌉ × ⌈h/28⌉` on the resized image; standard tier long edge 1,568 px (≤ 1,568 tokens), high-resolution tier (4.7 and later, including 5.x) 2,576 px (≤ 4,784 tokens). 1500×1000 on the high tier = 1,944 tokens.
- **Gemini 4/3**: flat per image (above). **Azure**: formula for GPT-5/6 deployments UNVERIFIED. **Ollama / LM Studio**: no documented image-token cost; meter with the response's token counts.
- Per-request limits: OpenAI 1,500 images; Anthropic 100 to 600 (10 MB per image, ≤ 8000×8000); Gemini 3,600; Azure 10.

## 5. Reasoning controls and metering

- Output caps (`max_completion_tokens`, `max_tokens`, `maxOutputTokens`) **include reasoning tokens**, so a recipe call of 1 to 2k tokens still needs thinking headroom or it can end with no visible text (still billed).
- Billing: reasoning/thinking tokens are billed as output. OpenAI: `usage.completion_tokens` already **includes** `completion_tokens_details.reasoning_tokens`; do not add them again. Anthropic: `output_tokens` is inclusive; total input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. **Gemini: billable output = `candidatesTokenCount + thoughtsTokenCount`** (separate fields).
- Controls: OpenAI `reasoning_effort` (`none` is rejected by some models, use `low`); Anthropic `output_config.effort` (manual `thinking: {type: "enabled", budget_tokens}` is a 400 on 5.x models); Gemini 3/4 `thinkingLevel` (never `thinkingBudget`; thinking cannot be disabled on Gemini 4). GPT-6.2 models reject `temperature`/`top_p`; Anthropic `2026-10-21` removes them everywhere.

## 6. Usage fields and errors

- Fields: OpenAI Chat `prompt_tokens` / `completion_tokens` (cached in `prompt_tokens_details.cached_tokens`); Responses `input_tokens` / `output_tokens`; Anthropic `input_tokens` / `output_tokens` / `cache_read_input_tokens`; Gemini `usageMetadata.promptTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount`; Ollama `prompt_eval_count` / `eval_count`.
- Rate limits: OpenAI and Anthropic 429 with `Retry-After` (seconds); **Azure `retry-after-ms`**; Gemini 429 `RESOURCE_EXHAUSTED` with **no documented `Retry-After`** (exponential backoff with jitter; retry only 429, 408, 5xx). Overloaded: OpenAI 503, **Anthropic 529**, Gemini 503.
- **Do not retry**: OpenAI 429 with `insufficient_quota`, `credit_balance_exhausted`, spend-limit codes; Anthropic spend-cap 429, 402, 413; Gemini **402** (prepay depleted); Azure 400 `content_filter`. These stop the batch with a clear message instead of burning retries.
- Log Anthropic `request-id` / OpenAI `x-request-id` for support.

## 7. Image embeddings (nearest-neighbour style retrieval)

- **No image embeddings**: OpenAI (text only), Anthropic (none; recommends Voyage), Ollama, LM Studio.
- **Gemini** `gemini-embedding-2` (`:embedContent` with `inline_data` image parts; ≤ 6 images per request; 128 to 3072 dimensions; incompatible with `gemini-embedding-001`), **Vertex** `multimodalembedding@001`, **Cohere** `embed-v4.0`/`v5` (`/v2/embed`, images as data URIs, combined ≤ 20 MB), **Voyage** `voyage-multimodal-3.5` (`/v1/multimodalembeddings`), **Jina** `jina-clip-v2` (weights CC BY-NC 4.0: commercial use needs a licence), **Azure AI Vision** `retrieval:vectorizeImage` (1024 dimensions).
- Store `{provider, model, dimensions, version}` with every vector and never mix spaces. Embedding also sends the client's photos to a third party, so the data-handling disclosure applies to embedding keys too. For fully local use there is no documented image-embedding model in Ollama or LM Studio: use the classical computer-vision signature already in the plan.

## 8. Free tiers and training

- **Gemini API**: unpaid quota content "is used to provide, improve and develop Google products… human reviewers may read, annotate and process"; paid services (Cloud project with active billing) do not train. EEA/Switzerland/UK: paid-service terms apply to all (terms effective 2026-03-23).
- OpenAI: data sent to the API is not used for training unless opted in (no free-tier clause found). Anthropic free credits: data clause UNVERIFIED. Voyage: opt-out of training requires a payment method and an organisation admin.

## Still UNVERIFIED

gpt-6.2 and gpt-6-luna image-sizing rules; Azure image-token formula and retention days; whether Gemini's OpenAI-compatible endpoint accepts `json_object`; Ollama thinking tokens in `eval_count`; LM Studio OpenAI-compat `usage`; Vertex embedding limits; Jina hosted-API commercial and data terms; embedding prices.

## Sources (retrieved 2026-11-22)

OpenAI: developers.openai.com/api/docs/guides/{structured-outputs, batch, images-vision, reasoning, rate-limits, error-codes, your-data}, API reference for chat completions, responses, batches, embeddings. Anthropic: platform.claude.com/docs/en/{build-with-claude/structured-outputs, build-with-claude/batch-processing, build-with-claude/vision, build-with-claude/thinking, api/messages/create, api/errors, api/rate-limits, api/versioning, agents-and-tools/tool-use/define-tools}. Google: aistudio.google.com/docs/{structured-output, batch-api, media-resolution, image-understanding, thinking, api-errors, terms, embeddings, models/gemini-embedding-2} and generativelanguage.googleapis.com/$discovery/rest?version=v1beta. Azure: learn.microsoft.com/en-us/azure/foundry/openai/{api-version-lifecycle, how-to/structured-outputs, how-to/gpt-with-vision, how-to/quota, how-to/batch, concepts/default-safety-policies}. Local: docs.ollama.com/{capabilities/structured-outputs, api/chat, api/usage, api/embed}, lmstudio.ai/docs/developer. Embeddings: docs.cohere.com/v2/reference/embed, docs.voyageai.com/reference/multimodal-embeddings-api, jina.ai/embeddings, cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-embeddings, learn.microsoft.com/en-us/azure/ai-services/computer-vision/how-to/image-retrieval.
