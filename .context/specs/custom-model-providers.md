# Custom model providers (OpenAI-compatible)

Status: spec, not built. Parent: [ANT-1057](/ANT/issues/ANT-1057). Spec issue:
[ANT-1060](/ANT/issues/ANT-1060). Research input: [ANT-1059](/ANT/issues/ANT-1059). Security
review: [ANT-1063](/ANT/issues/ANT-1063).

Planned code: `server/modelAccounts.ts`, `server/agentModel.ts`, `server/agentRunners.ts`,
`server/modelCatalog.ts`, `server/index.ts`, `shared/modelMenu.ts`, `shared/agentRunner.ts`,
`src/components/ModelAccount.tsx`, `src/components/ModelPicker.tsx`, `src/lib/api.ts`; new
`server/customEndpoint.ts` (policy, screening, resolve-and-pin transport, one guarded request
helper); migration `server/db/migrations/0049_custom_model_provider.sql`.

## Why

Today the Doop Agent can run on five fixed providers (ChatGPT, OpenAI, Claude API, OpenRouter,
Gemini) and their fixed URLs. People running **9Router**, LiteLLM, vLLM, Ollama or LocalAI cannot
point doop at it. The thing that looks like a small config field is actually a server-side fetch
target, which is why `server/chatCompletionsAgent.ts` currently refuses a user-supplied URL. This
spec replaces the blanket refusal with an **explicit, gated, screened** custom provider: one
OpenAI-compatible endpoint per user, authenticated with their key (or a placeholder for a keyless
local gateway), validated on connect, and safe to run inside the deployment's network.

Outcome: a person adds "9Router" in Settings → Doop Agent, pastes
`http://127.0.0.1:20128/v1` (self-host, policy `private`) or `https://api.9router.dev/v1`
(hosted), and their next task runs on the model they chose there — no code change, no server env
edit per provider.

## Scope

In scope (v1):

- One custom connection per user, `kind='custom'`, with provider label, origin, optional API key,
  model id, vision toggle and output budget.
- OpenAI Chat Completions transport: `POST {origin}/v1/chat/completions`,
  `GET {origin}/v1/models`.
- Server-level endpoint policy (`off` / `public` / `private`) and SSRF screening at save time and
  on every outbound request.
- Connect validation: `/models` suggestions + one small tool-call **probe** (and a 1×1 image when
  vision is claimed), with manual model-id fallback.
- Settings connect / validate / replace / disconnect / on-off, composer runner listing, default
  routing, clear provider errors.

Out of scope (v1, see Follow-ups): more than one custom provider per user; Anthropic-compatible
custom endpoints; Google-compatible endpoints; per-workspace providers; extra auth headers;
per-account proxy/TLS options; streaming; custom image models; cost caps; arbitrary base paths
behind a reverse proxy.

## Data model

Extend `model_accounts` (one row per `user_id + kind`; migration `0049_custom_model_provider`):

| column              | type      | notes                                                            |
| ------------------- | --------- | ---------------------------------------------------------------- |
| `base_url`          | `text`    | nullable; normalized **origin** (see below); only on `custom`    |
| `label`             | `text`    | nullable; 1–40 chars; shown as the connection's name             |
| `vision`            | `boolean` | `not null default false`; only meaningful on `custom`            |
| `max_output_tokens` | `integer` | `not null default 8192`; 1024–16000; only meaningful on `custom` |

Reuse: `api_key` (already `sealedText`, nullable — a keyless local gateway stores null), `model`,
`enabled`, `connected_at`, `updated_at`. `kind` gains `'custom'`.

**Why one, not many.** `model_accounts` is keyed by `(user_id, kind)`, and every downstream
abstraction is keyed by that kind: `RunnerProvider`, `agent_defaults.provider`, runner keys and
`tasks.runner` JSON, the Settings table, `menus` keyed by kind. A second custom provider needs a
synthetic id (`custom:<uuid>`) threaded through all of them, plus a per-row picker. That is a
second project, not the smallest thing that satisfies "9Router + any OpenAI-compatible endpoint".
One `custom` row proves the transport, the screening and the UX.

**How later providers are added.** v2 moves custom providers out of `model_accounts` into a
`custom_providers` table with its own `id`; `RunnerProvider` becomes `'custom:' + id` (a string, so
`agent_defaults.provider` and stored picks keep working); the single v1 row migrates to the first
id. A future Anthropic-compatible endpoint is a second kind (`custom-anthropic`) with its own
transport, not a second row of this one.

**Rollback safety.** An older build's `toAccount` already ignores a kind it does not know and logs
a warning, so a rollback treats `custom` as disconnected rather than running it as some other
provider. The new columns are nullable or defaulted.

## Endpoint contract

A custom connection stores the **origin only** (`scheme://host[:port]`). The two endpoints are
fixed:

- models: `GET {origin}/v1/models`
- chat: `POST {origin}/v1/chat/completions`

No arbitrary path, method or header is accepted. This is deliberate: the server-side fetch
surface is two literal paths.

### Accepted URL forms and normalization

Input is the API root from the provider's docs. The form accepts either the origin or the
`/v1` root that 9Router/LiteLLM/vLLM/Ollama/LocalAI documents show.

1. Trim. Reject over 2,000 characters.
2. Reject if the raw input and `new URL(raw)` disagree on the host (backslash/userinfo tricks),
   per the OWASP SSRF guidance.
3. Parse with `new URL`. Scheme must be `https:`. `http:` is accepted **only** under
   `CUSTOM_ENDPOINT_POLICY=private`.
4. Reject `username`/`password`, any query string, and any fragment.
5. Path must be empty, `/`, or `/v1` (optionally with a trailing `/`). Anything else — `/api`,
   `/openai/v1`, `/v1/chat/completions`, a proxy prefix — is rejected with "Use the server's
   origin or its `/v1` root."
6. Store `scheme://host[:port]` (no path, no trailing slash). Echo it back in status.

| input                                            | stored                    |
| ------------------------------------------------ | ------------------------- |
| `https://api.9router.dev`                        | `https://api.9router.dev` |
| `https://api.9router.dev/v1`                     | `https://api.9router.dev` |
| `https://api.9router.dev/v1/`                    | `https://api.9router.dev` |
| `http://127.0.0.1:20128/v1` (private)            | `http://127.0.0.1:20128`  |
| `http://localhost:20128/v1` (private)            | `http://localhost:20128`  |
| `http://10.0.0.5:4000/v1` (private)              | `http://10.0.0.5:4000`    |
| `https://router.example.com/api`                 | rejected                  |
| `https://router.example.com/v1/chat/completions` | rejected                  |

9Router has two products and the UI says so: the **local gateway** is
`http://localhost:20128/v1` (self-host, `private`; the README prefers `127.0.0.1` because of
IPv6 — both are accepted and `localhost` is stored verbatim, classified as private), the
**hosted service** is `https://api.9router.dev/v1` (`public`).
They have different catalogues and model ids. On Doop Cloud the server cannot reach a user's
laptop: the form says a public URL or a tunnel is required.

### Auth and headers

`Authorization: Bearer <key>` on both endpoints. `x-api-key` is also accepted by 9Router, but v1
sends one scheme only. When the stored key is absent (keyless local gateway), send the literal
placeholder `Authorization: Bearer doop-local` — many clients reject a missing header, and 9Router
local defaults to `REQUIRE_API_KEY=false`. The placeholder is not a secret and is never stored.
`Accept: application/json`; `Content-Type: application/json` on the POST. No user-supplied
headers in v1 (follow-up).

### Connect, catalog and probe

`POST /api/model-account/custom` does, in order:

1. Policy gate: `CUSTOM_ENDPOINT_POLICY=off` → `404 {error}`.
2. Validate `label`, screen `baseUrl` (syntax + DNS/IP + resolve-and-pin), validate `apiKey` if
   present. Nothing is fetched before all three pass.
3. **Catalog (advisory)**: `GET {origin}/v1/models` with a 5 s budget and 2 MiB cap. A usable
   `{data:[{id,...}]}` becomes the suggestion list. Any failure (401, 404, 5xx, timeout at the
   budget, over-cap, bad shape) is recorded as "no catalog", the catalog step is abandoned, and
   connect **continues to the probe** — `/models` is a suggestion list, not a capability contract,
   so it never decides the connect result. Only the probe does.
4. Resolve the model: request `model` if valid, else the existing row's `model` (rotation), else
   the first catalog id, else `400 "Enter a model id — the provider did not list any."`.
5. **Probe (the gate)**: one non-streaming `chat/completions` with `max_tokens: 32`, a single
   trivial tool `doop_ping`, the prompt "Call the doop_ping tool now.", and — when `vision` is
   requested — a 1×1 PNG data URL in the same message. Success requires a `2xx` body with at least
   one `tool_calls` entry. This proves the endpoint, the key, the model id, tool calling, and (when
   asked) image input in one request. A provider that cannot call tools cannot run the Doop Agent
   and is rejected with that sentence.
6. Upsert the row with `enabled=true`, the given (or previous) `vision` and `maxOutputTokens`, and
   `connectedAt=now`.
7. Answer with the full `AccountsView` (below).

Probe failures map to the error table. The probe is a few dozen tokens; connect/probe attempts are
rate-limited to 10 per user per minute (`429 {error:"Too many connection attempts — wait a moment."}`).
A failed probe leaves an existing row untouched.

### Catalog

`GET /api/model-account/models?kind=custom` calls `GET {origin}/v1/models` with a 5 s budget and a
2 MiB cap. Accept `{data:[{id,name?,capabilities?,max_completion_tokens?}]}`; keep entries whose
`id` passes the model-id rule and does not match the **custom non-chat filter**; de-duplicate;
cap 1,000; keep provider order. Each entry gets `vision: <account.vision>` so the badge matches
what will actually run.

The custom non-chat filter drops only unambiguous non-chat modalities. Match, case-insensitively,
the tokens `embedding|audio|tts|whisper|transcrib|realtime|moderation|image|robotics` as whole
tokens inside the id's last path segment. Custom catalogs **do not reuse `NOT_AN_AGENT_MODEL`**
(`server/modelCatalog.ts:49`): that regex also drops `instruct|chat|live|search`, which are
legitimate parts of chat ids, so it would silently hide `llama3.1:8b-instruct-q4_K_M`,
`qwen2.5:7b-instruct`, `meta.llama-4-instruct` and similar. `instruct`, `chat`, `live` and
`search` are therefore not filtered. Like the rest of the catalog this list is advisory: a
dropped or unknown id is still usable by typing it, and the probe remains the capability gate.

`name` falls back to the `id` when the provider omits it (or sends a blank string); `blurb`
falls back to `""` (no supported provider returns one in `/models`). The same rule fills the
unavailable/manual fallback row and every `models` entry on `GET /api/agent-runners`, so `name`
is never empty and `blurb` is always a string.

`capabilities.vision` / `capabilities.tools` (9Router) and LiteLLM's `/model/info` are **hints**:
they may prefill the form or annotate a suggestion, but never override the user's toggle and never
enable a capability automatically. The probe is the contract.

When the provider cannot be asked, answer `live:false` with
`models: [{id: storedModel, ...}]` and a caption — never an empty picker. The manual path is
`PATCH {model}` with any valid id; the stored id is always allowed even when the catalog does not
list it.

### Model ids are opaque

Store and send the id verbatim. Never strip a prefix, split on `/`, lowercase, or infer capability
from the name. Valid ids include `anthropic/claude-opus-4-6`, `9router/auto`, `premium-coding`,
`moonshotai/kimi-k3`, `qwen3:32b`, `meta.llama-4`, `@cf/meta/llama-3.1-8b-instruct` (HF repo ids
and 9Router combos both contain `/`).

### Replace, enable, default, delete

- Replace (origin, label, key, model, vision, budget) = `POST /api/model-account/custom` again.
  It re-runs screening and the probe, preserves fields omitted from the request, and keeps the old
  row if validation fails.
- `PATCH /api/model-account/custom` with exactly one of `{model}`, `{vision}`, `{maxOutputTokens}`,
  `{enabled}`.
- `DELETE /api/model-account/custom` deletes the row; the runner disappears.
- Default = `PUT /api/agent-runners/default {provider:'custom'}`; accepted only while the account
  is connected and on.

## Security

The origin is untrusted input used by the server as a fetch target. Implement one shared helper
(`server/customEndpoint.ts`) used by connect, catalog, probe and every completion turn so no path
can skip a check. The server-level policy is the product decision; per-user opt-ins are not
allowed.

| `CUSTOM_ENDPOINT_POLICY` | meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `off`                    | feature hidden, custom routes answer 404                              |
| `public` (default)       | https only, global addresses only, metadata ranges always blocked     |
| `private`                | self-host only: `http` + loopback/RFC1918/ULA, metadata still blocked |

Doop Cloud ships `public` and never sets `private`; a single-tenant self-host may. The UI shows
the current policy in the connect form's help text.

**Tobias verification checklist** (aligned with [ANT-1063](/ANT/issues/ANT-1063))

1. **Scheme**: `https:` in `public`; `http:` only in `private`. Public `http:` rejected even in
   `private`.
2. **URL hygiene**: no credentials, query or fragment; path only empty/`/`/`/v1`; length ≤ 2,000;
   raw-vs-parsed host must agree (backslash/userinfo tricks). Only the two literal paths are ever
   requested.
3. **Policy is server-level**: a user cannot opt into private networks; `off` makes every custom
   route 404 and hides the UI row.
4. **Resolve, then pin**: resolve all A/AAAA records once; reject if **any** address is non-global
   (loopback, RFC1918, CGNAT `100.64/10`, link-local, multicast, unspecified, IPv4-mapped, NAT64,
   ULA). Connect to the **validated IP** through a pinned dispatcher (undici `Agent` with
   `connect.lookup`, preserving Host/SNI/cert validation). The pinned IP is the DNS-rebinding
   defence — not a second independent lookup.
5. **Metadata ranges always blocked**, even in `private`: `169.254.0.0/16` (incl.
   `169.254.169.254` and Alibaba `100.100.100.200`), `fd00:ec2::254`, and the host name
   `metadata.google.internal`.
6. **Full IPv4/IPv6 classification**: `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`,
   `192.168/16`, `100.64/10`, `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`,
   `203.0.113/24`, `224/4`, `240/4`; `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and
   IPv4-mapped forms in dotted and hex spellings (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
   `localhost` and `*.localhost` are private.
7. **No redirects**: `redirect:'manual'`; every `3xx` is an error naming the final base URL.
8. **Timeouts**: 5 s to headers for `/models`, 30 s to headers and 120 s overall for the probe and
   every completion; a run's abort signal cancels the body immediately.
9. **Caps**: catalog 2 MiB, completion 8 MiB, 1,000 catalog entries, 300-char error detail. Read
   through a capped reader; cancel past the cap; never call bare `res.json()` on these responses.
10. **Key handling**: sealed at rest (`sealedText`), absent from every status/JSON body, absent
    from logs and analytics. `Authorization` is never logged; any provider text is scrubbed of the
    exact key (and of `doop-local`, which is not secret) before it reaches a log or the browser.
    A keyless connection stores `api_key = null`.
11. **Authz**: every query filters `user_id`. A pick or default resolves only against the
    requesting payer's rows; Bob's connection can never run Alice's task or appear in her view. No
    caching of accounts across users.
12. **Abuse controls**: connect/probe rate-limited to 10 per user per minute; one audit line per
    attempt (`[custom-model] user=<id> host=<host> outcome=<ok|rejected:<status>> duration=<ms>`),
    host only, never the path, key or body.
13. **Concurrency**: upsert by primary key, no shared mutable config. Two concurrent connects end
    in one of the two saved states, never a half-row; a failed probe leaves the previous row
    intact.
14. **No new env outside `server/env.ts`**: `CUSTOM_ENDPOINT_POLICY` is declared there with
    `choices: ['off','public','private']` and documented in `.env.example`; `tests/env.test.ts`
    covers it.

## Capabilities and behaviour

- **Tools are mandatory** and proven by the probe. The Doop Agent cannot edit a canvas without
  function calling. There is no tools toggle: absent tools means the connection is rejected.
  `tool_choice:'auto'` is sent; a provider that rejects it (Ollama documents it as unsupported)
  fails the probe with a clear message (follow-up: per-account tool-choice mode).
- **Vision** is a manual toggle, default **off**. Off is the safe default: a text-only model would
  400 on the first screenshot, while stripping images only degrades the review. When on, the
  connect probe sends a 1×1 PNG; a rejected image fails the connect with "untick 'can see
  screenshots'". When off, `AgentModel.vision=false` drives the resident's existing no-screenshot
  path; it is never an error.
- **Output budget** is per account: `maxOutputTokens`, default **8192**, range **1024–16000**.
  Many local models reject doop's old fixed 16,000. If the selected catalog entry reports
  `max_completion_tokens`, use `min(16000, hint)` as the initial default (floor 1024). The user can
  raise or lower it; the turn sends this value as `max_tokens`.
- **Streaming**: v1 is non-streaming, one request per turn, 120 s cap. A provider that only
  streams is out of scope.
- **Model id**: trimmed, 1–120 chars, no whitespace/control characters and no `"`, `'`, `<`, `>`,
  `\`; otherwise opaque (see above).
- **No reasoning-effort dial**: effort stays an OpenAI-only concept in v1.
- **Degraded/error states**: see the table below. No failure ever silently falls back to another
  provider or the server key.

### Error mapping

Parse JSON defensively with the 300-char cap; tolerate OpenAI/9Router/LiteLLM
`{error:{message,type,code}}`, Anthropic `{type:"error",error:{…}}`, vLLM/FastAPI `{detail:…}` or
`{object:"error",message}`, Ollama `{error:"…"}`, LocalAI `{error:{message}}`, and non-JSON/HTML.

| upstream             | UI message                                                                                                                                                 | retry        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 401                  | "Authentication failed — check the API key."                                                                                                               | no           |
| 403                  | "Key is valid but this model or endpoint is not allowed."                                                                                                  | no           |
| 404                  | "Endpoint or model not found — check the base URL and the model id." + provider detail (`no active credentials for provider` on 9Router is shown verbatim) | no           |
| 400 / 422            | "The model rejected the request." + provider message + capability hint (tools/images/output budget)                                                        | no           |
| 429                  | "Rate limited — retry in Ns." (honour `Retry-After` when present)                                                                                          | yes          |
| 500/502/503/504      | "Provider unavailable."                                                                                                                                    | yes, backoff |
| DNS / TLS / timeout  | "Could not reach the endpoint" — distinguish timeout from certificate                                                                                      | yes          |
| 3xx                  | "Endpoint redirected — use the final base URL."                                                                                                            | no           |
| 200 with `{error:…}` | treat as failure (OpenRouter-style)                                                                                                                        | —            |
| non-JSON body        | "Endpoint returned non-JSON — check the base URL."                                                                                                         | no           |

Turn-time mapping keeps the existing agent classes: 401 → `ModelAuthError` ("replace it in
Settings"); 403 → configuration message (not "bad key"); 404 with a model-shaped message →
`ModelUnavailableError`; 429/5xx/timeout → retryable provider errors; DNS/refused/TLS →
`ModelConfigurationError`. None contains the key.

## API contract

All routes are session-authenticated and owner-scoped. Every mutation answers with the whole
Settings view, as the existing account routes do. Errors are always `{ "error": "<sentence>" }`.
No custom route ever returns `api_key`.

> **Route order.** Register `PATCH` and `DELETE /api/model-account/custom` **before** the existing
> generic handlers `app.patch('/api/model-account/:kind')` (`server/index.ts:1015`) and
> `app.delete('/api/model-account/:kind')` (`server/index.ts:1109`), or branch on
> `kind === 'custom'` at the top of those handlers. Express matches in registration order: a
> custom route registered later is unreachable, because the generic handler sees
> `kind === 'custom'`, `isAccountKind('custom')` fails and it answers
> `400 unknown account kind`. The same ordering applies to the `kind=custom` branch of
> `GET /api/model-account/models` (`server/index.ts:992`), which must handle `custom` (including
> the `off` case below) before the built-in account lookup.

### Shared view additions

`AccountStatus` gains, for `kind='custom'` only:

```json
{
  "kind": "custom",
  "enabled": true,
  "label": "9Router",
  "baseUrl": "https://api.9router.dev",
  "model": "9router/auto",
  "vision": false,
  "maxOutputTokens": 8192,
  "connectedAt": 1762680000000
}
```

`AccountsView` gains `customEnabled: boolean` (`CUSTOM_ENDPOINT_POLICY !== 'off'`) and
`policy: "off" | "public" | "private"` (so the UI can explain what URLs are allowed), plus
`menus.custom: []` — the custom provider has no curated menu; its list is live or the one stored
model.

### `POST /api/model-account/custom`

Request (all strings trimmed; `apiKey` may be omitted):

```json
{
  "baseUrl": "https://api.9router.dev/v1",
  "label": "9Router",
  "apiKey": "sk-...",
  "model": "9router/auto",
  "vision": false,
  "maxOutputTokens": 8192
}
```

`model`, `vision` and `maxOutputTokens` are optional on first connect (`model` falls back to the
first catalog id; `vision` to `false`; budget to 8192 or the catalog hint). On rotate, omitted
fields keep the stored values; an omitted `apiKey` keeps the stored key, and an explicit empty
string clears it (keyless).

- `200` → `AccountsView`
- `400` → `{error}` for an invalid URL/label/model/budget, an unreachable provider, a failed probe,
  an unsupported tool call, a rejected image, a redirect, or a rate-limited check.
- `404` → `{error: "Custom provider connections are disabled on this server"}` when policy is
  `off`.
- `429` → `{error: "Too many connection attempts — wait a moment."}`.

### `PATCH /api/model-account/custom`

Request: exactly one of `{ "model": "..." }`, `{ "vision": true }`,
`{ "maxOutputTokens": 8192 }`, `{ "enabled": false }`. `400` if zero or more than one field is
present, the id/budget is invalid, or the account is not connected. `200` → `AccountsView`.
Turning `enabled` on wakes queued work for that user. Changing `vision` or `maxOutputTokens` takes
effect on the next turn; changing `model` does not re-probe (the first turn surfaces a bad id) —
"Replace key" re-probes.

### `DELETE /api/model-account/custom`

`200` → `AccountsView`; idempotent when nothing is connected.

### `GET /api/model-account/models?kind=custom`

- `CUSTOM_ENDPOINT_POLICY=off`: `404` for the `custom` kind. The route must branch on this before
  the built-in `?kind` lookup, so `custom` never falls through to `400 unknown account kind`. Body:
  `{error:"Custom provider connections are disabled on this server"}`.
- Not connected: `{ "models": [], "live": false }`
- Catalog reachable: `{ "models": [{ "id", "name", "blurb", "vision": false }], "live": true }`;
  `name = entry.name?.trim() || entry.id`, `blurb = ""`.
- Catalog unavailable: `{ "models": [{ "id": "<stored>", "name": "<stored>", "blurb": "",
"vision": false }], "live": false, "error": "Could not load models from 9Router. Enter a model
id instead." }`
- Unknown kind: existing `400 {error:"unknown account kind"}`.

### `GET /api/agent-runners`

A connected, enabled custom account adds one runner:

```json
{
  "provider": "custom",
  "name": "9Router",
  "model": "9router/auto",
  "vision": false,
  "models": [{ "id": "9router/auto", "name": "9router/auto", "blurb": "" }]
}
```

`AgentRunner` gains optional `vision`. `default` may be `"custom"` when that account is the
Settings default. An off or disconnected account is omitted, exactly like the other kinds.

### `PUT /api/agent-runners/default`

Accepts `{ "provider": "custom" }`. `400 {error:"connect and switch that on first"}` when the
custom account is absent or off; `200` → `AccountsView`.

### Type changes

`AccountKind` / `ModelAccountKind` add `'custom'`; `ACCOUNT_KIND_LABELS` adds
`custom: 'Custom provider'`; `RUNNER_NAMES` inherits it; `MODEL_MENUS` adds `custom: []`;
`MODEL_POLICY.custom` resolves the stored model and accepts any valid custom id;
`accountVisionFor` returns the stored `vision` flag for custom. `allowance.byoKind` picks up the
new kind automatically; its display label becomes the account label where available. The
transport config (`ChatCompletionsConfig`) gains an optional `maxTokens`; custom sets it from the
account budget, the other kinds keep `req.maxTokens`.

## UX

Settings → Doop Agent, under "Add a connection", a row **Custom provider (OpenAI-compatible)**
(sits beside the five built-ins; hidden when `customEnabled` is false).

Fields while connecting:

- **Provider name** — text, 1–40, placeholder "9Router".
- **Base URL** — text, placeholder `https://api.9router.dev/v1`; help: "The server origin or its
  `/v1` root — nothing deeper. Local 9Router is usually `http://127.0.0.1:20128/v1` and needs the
  self-host `private` policy; on Doop Cloud use a public URL or tunnel."
- **API key** — password, optional; help: "Encrypted at rest and never shown again. Leave blank
  for a local gateway that does not check keys; we send a placeholder."
- **Model id** — optional text; help: "Leave blank to use the first model the provider lists; you
  can always type one."
- **This model can see screenshots** — checkbox, default off; connecting sends a tiny image, so a
  model that cannot read it is caught here.
- **Output budget** — number, default 8192, range 1024–16000; help: "Lower it for local models
  that reject large responses."

States:

- idle → testing (Connect disabled; "Checking the endpoint and a test tool call…") → connected row.
- Errors appear under the matching field: invalid URL/path, policy refusal (names the env flag),
  key rejected, model rejected, no tool call, image rejected, provider unavailable, rate-limited.
  The row stays unconnected; a rotated connection's previous row is intact.
- Catalog unavailable: the row connects with the typed/stored model (the probe still runs) and the
  dropdown carries the "enter a model id" caption.
- Connected row: label as its name; the line under it shows `host`, model and budget; model
  dropdown (live list once fetched, otherwise the one stored id); "No visual review" badge when
  vision is off; on/off switch; "…" menu with Make default, Replace key, Disconnect. A `Default`
  badge appears when it is the `agent_defaults` pick.
- Replace key: the same form, prefilled with label/origin/model/vision/budget, empty key;
  submitting re-runs the probe and keeps omitted fields.
- Off: row stays, greyed, `Off` badge, gone from the composer; Disconnect deletes it.

Composer (`ModelPicker`): the custom connection appears with its **label** as the caption and its
models; picking one stores `{provider:'custom', model}` on the card. No effort slider. If the
connection is switched off between renders, `resolveRunnerPick` falls back to the Settings default
or the first runner. The composer shows the no-vision badge when `vision:false`.

Default routing (`agent_defaults`): Make default stores `'custom'`; comments, @mentions and
automations then run on it. If it is switched off or disconnected later, `resolveDefault` skips
it and falls back like any other missing kind. "Switch on" wakes queued work.

## Acceptance criteria

Each is a Given/When/Then a test can assert. AC1–AC10 are connect/contract, AC11–AC16 security,
AC17–AC24 runtime/UX/regression.

- **AC1 — Connect self-host 9Router.** Given `CUSTOM_ENDPOINT_POLICY=private` and a stub provider
  at `http://127.0.0.1:20128/v1` whose `/models` returns `[9router/auto]` and whose probe returns
  a `doop_ping` tool call, when Alice POSTs `{baseUrl:"http://127.0.0.1:20128/v1",
label:"9Router", apiKey:"local", model:"9router/auto"}` then the response is 200, and
  `GET /api/model-account` shows one `kind:"custom"` account with
  `baseUrl:"http://127.0.0.1:20128"`, `label:"9Router"`, `model:"9router/auto"`,
  `maxOutputTokens:8192`, `vision:false`, `enabled:true`.
- **AC2 — Public policy is https-only.** Given `CUSTOM_ENDPOINT_POLICY=public`, when the base URL
  is `http://api.9router.dev/v1`, then POST is 400 with a message naming `https://`, and no
  outbound request is made.
- **AC3 — Private addresses refused in public.** Given the `public` policy, when the origin has
  host `localhost`, `127.0.0.1`, `10.x`, `172.16.x`, `192.168.x`, `169.254.169.254`, `100.64.x`,
  `[::1]`, or a hostname whose A/AAAA records include any of these, then POST is 400 with the
  "private to the server's own network" message and no request is made. The same holds when the
  URL is syntactically `https://`.
- **AC4 — Metadata always blocked.** Given the `private` policy, when the origin is
  `http://169.254.169.254/v1`, `http://100.100.100.200/v1`, or
  `http://metadata.google.internal/v1`, then POST is 400 and no request is made.
- **AC5 — Strict URL shape.** Given each accepted row of the normalization table, then the stored
  origin matches. Given `/api`, `/openai/v1`, `/v1/chat/completions`, a query, a fragment,
  `user:pass@host`, or a backslash trick, then each is 400 and nothing is stored.
- **AC6 — Redirects are never followed.** Given a provider answering `302 Location:
http://169.254.169.254/latest`, when Alice connects, then POST is 400 ("redirected — use the
  final base URL"), the redirect target is not fetched, and no row is written.
- **AC7 — The probe is the gate.** Given `/models` answers 401 but the probe succeeds, then the
  account is saved and `GET models` answers `live:false` — the catalog is advisory. Given the
  probe answers 401 (or the key is rejected by both `/models` and the probe), then POST is 400
  "Authentication failed" and no row is written. Given `/models` answers 200 but the probe returns
  content with no `tool_calls`, then POST is 400 naming the missing tool call and no row is
  written. Given `vision:true` and the probe rejects the image, then POST is 400 telling the user
  to untick the box. A previous row is unchanged in every failure case.
- **AC8 — Catalog is advisory; manual ids work.** Given `/models` answers 404 or times out, when
  the probe succeeds for `model:"my-model"`, then the account is saved and
  `GET /api/model-account/models?kind=custom` returns
  `{models:[{id:"my-model",...}], live:false, error:<string>}`. Given `/models` returns five
  agent-capable ids, then the same route returns `live:true` with all five and no error. Given a
  live catalog containing `llama3.1:8b-instruct-q4_K_M`, `qwen2.5:7b-instruct`,
  `text-embedding-3-large` and `whisper-1`, then the first two are returned (the custom non-chat
  filter keeps `instruct` ids) and the last two are dropped. Given a live catalog without
  `my-model`, `PATCH {model:"my-model"}` is accepted and stored.
- **AC9 — Ids are opaque.** Given `anthropic/claude-opus-4-6`, `9router/auto`, `premium-coding`,
  `moonshotai/kimi-k3`, `qwen3:32b`, `meta.llama-4`, `@cf/meta/llama-3.1-8b-instruct`, then each
  is stored and sent byte-for-byte (no prefix stripping, no split on `/`). Given `""`, `" "`, a
  121-char id, or one containing a quote/backslash, then each is 400.
- **AC10 — Key optional, replace, delete.** Given a connect with no `apiKey`, then 200, the status
  has no key, and the probe/next turn sends `Authorization: Bearer doop-local` with
  `api_key = null` at rest. Given a connected account, when Alice POSTs a new key and no model,
  then 200, the model is unchanged, and the next completion uses the new key. When she DELETEs,
  then 200, `GET /api/model-account` has no custom row, and `GET /api/agent-runners` no longer
  lists it.
- **AC11 — Key secrecy.** Given any successful connect with a key, then the key appears in no
  response body (`GET /api/model-account`, models, runners), and the stored `api_key` column is
  ciphertext (`sealedText`), not plaintext. Connect logs contain host, outcome and duration but no
  key; provider error text is scrubbed.
- **AC12 — Owner isolation.** Given Alice has a custom account and Bob has none, when Bob calls
  `GET /api/model-account`, `GET /api/model-account/models?kind=custom`, and
  `PUT /api/agent-runners/default {provider:"custom"}`, then Bob sees no account, gets an empty
  catalog, and is refused the default; a task Bob pays for never uses Alice's row.
- **AC13 — Default routing.** Given a connected, enabled custom account, when Alice sets it
  default, then `GET /api/model-account` has `default:"custom"` and `GET /api/agent-runners` has
  `default:"custom"`. When she switches it off, then `resolveDefault`/`GET` fall back to the next
  enabled connection (or the server tier) and work without a pick no longer resolves to custom.
- **AC14 — Composer.** Given a connected custom account with label "9Router", when
  `GET /api/agent-runners` is read, then it contains one runner `{provider:"custom",
name:"9Router", model:<stored>, vision:false, models:[<stored>]}`; after switching it off the
  runner is absent, and a stored `{provider:"custom"}` pick falls back to the default.
- **AC15 — Vision default and degradation.** Given a connect without `vision`, then status has
  `vision:false` and `AgentModel.vision` is false, so the resident takes its no-screenshot path
  (images replaced with a note, visual review skipped, no provider 400). When Alice PATCHes
  `{vision:true}`, then the next run sends `image_url` parts.
- **AC16 — Error mapping.** Given a connected provider, when a turn answers 401 then the error is
  `ModelAuthError` naming the key; 403 → "key valid but not allowed"; 404 with a model message →
  `ModelUnavailableError`; other 404 → endpoint/model message with the provider detail; 429 →
  rate-limit message honouring `Retry-After`; 5xx → provider-unavailable; a timeout → "could not
  reach"; `200 {error}` and non-JSON → their own messages; none contains the key.
- **AC17 — Caps and timeouts.** Given `/models` streams more than 2 MiB, then the catalog read is
  abandoned at the cap, `GET models` answers `live:false` with an error rather than growing
  memory, and a connect continues to the probe. Given `/models` never answers, then the catalog
  step is abandoned 5 s after the request is sent and connect continues to the probe — a probe
  that succeeds saves the account, one that fails is the connect result. Given a probe or a
  completion runs past 120 s, it aborts and maps to a retryable error; the run's Stop cancels
  earlier. A completion over 8 MiB is abandoned at the cap.
- **AC18 — Output budget.** Given no budget in the request, then the stored default is 8192 (or the
  model's `max_completion_tokens` hint clamped to 1024–16000). Given `PATCH {maxOutputTokens:4096}`,
  then 200 and the next turn sends `max_tokens:4096`. Given 0, 1023, 16001 or a non-integer, then
  400 and the row is unchanged.
- **AC19 — Policy env.** Given `CUSTOM_ENDPOINT_POLICY=off`, then POST/PATCH/DELETE custom and
  `GET /api/model-account/models?kind=custom` return 404, `AccountsView.customEnabled` is false
  and the UI row is hidden. Given `public`/`private`, `customEnabled` is true and `policy` is
  echoed. The variable is in `.env.example` with its three choices and `tests/env.test.ts`
  passes.
- **AC20 — One-change PATCH and probe rate limit.** Given `{model, vision}` or `{}`, then PATCH is
  400 and the row is unchanged. Given 11 connect attempts in one minute, the 11th is 429 and no
  probe is sent.
- **AC21 — Existing providers unchanged.** Given the five built-in kinds, when the suite runs,
  then their connect/rotate/model/effort/default behavior and `menus` entries are unchanged;
  `menus.custom` is `[]`; every `Record<AccountKind, …>` typechecks.
- **AC22 — Rollback tolerance.** Given a row with `kind='custom'` read by a build without the
  kind, then it is ignored as disconnected (existing `toAccount` behavior) and nothing throws.
- **AC23 — Tests exist and pass.** The test files listed below exist, and the repo's vitest
  invocation for the touched files passes with them.
- **AC24 — Evidence.** The PR body carries the branch name, commit SHA, base `paperclip`, and
  `git rev-list --count paperclip..HEAD` / `HEAD..origin/main` freshness evidence.

## Tests to add

- `tests/customProvider.test.ts` — HTTP happy path (AC1), https/private/policy refusal (AC2–AC4),
  probe gate (AC7), catalog/manual (AC8), replace/keyless/delete (AC10), key secrecy (AC11), owner
  isolation (AC12), default/off (AC13), vision (AC15), budget (AC18), policy (AC19), one-change
  PATCH + rate limit (AC20).
- `tests/customEndpoint.test.ts` — normalization table and rejected shapes (AC5), address
  classifier incl. metadata/IPv6 (AC3–AC4), pinned-lookup behaviour, redirect policy (AC6),
  caps/timeouts (AC17), model-id rule (AC9).
- `tests/customProviderTransport.test.ts` — config built from the stored origin, the two literal
  paths, request body shape (`tools`, `max_tokens` from the account), vision on/off image
  handling, error mapping incl. body shapes (AC16), and that a redirect response is surfaced, not
  followed.
- `tests/customProviderCatalog.test.ts` — parse/filter/cap, custom non-chat filter keeps
  `instruct` ids and drops embeddings/audio, hints never authoritative, `live:false` fallback
  (AC8), `vision` stamped from the account, `off` 404 branch (AC19).
- `tests/customProviderSettings.test.tsx` — form fields, probe/error copy under the right field,
  replace, keyless, disconnect, off state, default badge (AC1/AC7/AC10/AC14).
- extend `tests/modelPickerRunners.test.tsx` — custom label/models/no-vision in the composer
  (AC14); extend `tests/defaultRouting.test.ts` for the custom default (AC13).

## NFRs

- Connect: `/models` 5 s to headers; probe 120 s hard; p95 ≤ 10 s for a reachable local provider;
  one catalog call + one probe request; 10 attempts/minute/user.
- Catalog: 5 s, 2 MiB, ≤ 1,000 entries, no caching (same as the existing catalogs).
- Completion: 120 s hard cap, 8 MiB response cap, `max_tokens` from the account (1024–16000).
- Screening overhead: one DNS resolution + pinned connection per request; ≤ 50 ms p95 added.
- Secrecy: 0 occurrences of the API key in responses/logs; 0 plaintext keys at rest; keyless rows
  store null.
- Isolation: 0 cross-user reads/uses in tests.
- Availability: a custom provider failure fails only that run with a clear message; it never
  changes another account's behavior and never silently falls back to the server key.

## Follow-ups

1. Multiple custom providers per user (v2 data model above).
2. Anthropic Messages pass-through (`/v1/messages`) — a better second protocol than Google,
   because the agent loop is already Anthropic-shaped; 9Router, vLLM and LocalAI expose it.
3. Extra auth headers (`x-api-key`, org/project headers), per-account proxy/TLS options, and a
   per-account tool-choice mode for Ollama (which rejects `tool_choice`).
4. SSE streaming; richer discovery (`/model/info`, `capabilities`), auto-learned context window.
5. Cost caps, per-workspace providers, admin policy.
6. A base-path mode for reverse proxies (currently origin or `/v1` only).

## Open questions

- **Extra header styles** (e.g. `x-api-key`, Azure `api-key`): deferred; recommendation is one
  follow-up after 9Router/LiteLLM feedback. Owner: Tyler.
- **Proxy base paths** (`https://host/openai/v1`): rejected in v1 for a two-path fetch surface;
  recommendation is to keep rejecting until a real deployment needs it. Owner: Axel.
- **Tool-choice support** (Ollama): v1 fails the probe with a clear message; per-account mode is a
  follow-up. Owner: Tyler.

Resolved by the [ANT-1059](/ANT/issues/ANT-1059) research: keyless local gateways (optional key +
`Bearer doop-local` placeholder), 9Router local vs hosted base URLs, opaque model ids, 8192 default
output budget, and the server-level `off|public|private` policy.
