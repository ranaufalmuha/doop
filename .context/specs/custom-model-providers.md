# Custom model providers (OpenAI-compatible)

Status: spec, not built. Parent: [ANT-1057](/ANT/issues/ANT-1057). Spec issue:
[ANT-1060](/ANT/issues/ANT-1060).

Planned code: `server/modelAccounts.ts`, `server/agentModel.ts`, `server/agentRunners.ts`,
`server/modelCatalog.ts`, `server/index.ts`, `shared/modelMenu.ts`, `shared/agentRunner.ts`,
`src/components/ModelAccount.tsx`, `src/components/ModelPicker.tsx`, `src/lib/api.ts`; new
`server/customEndpoint.ts` (screening, normalization, one guarded request helper); migration
`server/db/migrations/0049_custom_model_provider.sql`.

## Why

Today the Doop Agent can run on five fixed providers (ChatGPT, OpenAI, Claude API, OpenRouter,
Gemini) and their fixed URLs. People running **9Router**, LiteLLM, vLLM, Ollama behind a gateway,
or any other OpenAI-compatible router cannot point doop at it. The thing that looks like a small
config field is actually a server-side fetch target, which is why
`server/chatCompletionsAgent.ts` currently refuses a user-supplied URL. This spec replaces the
blanket refusal with an **explicit, gated, screened** custom provider: one OpenAI-compatible
endpoint per user, authenticated with their key, validated on connect, and safe to run inside the
deployment's network.

Outcome: a person adds "9Router" in Settings → Doop Agent, pastes `http://9router.local:20128/v1`
(self-host with the instance flag on) or `https://router.example.com/v1`, and their next task runs
on the model they chose there — no code change, no server env edit per provider.

## Scope

In scope (v1):

- One custom connection per user, `kind='custom'`, with provider label, base URL, API key, model,
  and a manual vision flag.
- OpenAI Chat Completions transport: `POST {base}/chat/completions`, `GET {base}/models`.
- SSRF screening of the user-supplied base URL at save time and before every outbound request.
- Settings connect / validate / replace / disconnect / on-off, composer runner listing, default
  routing, clear provider errors.
- Manual model-id fallback when the provider has no `/models` catalog.

Out of scope (v1, see Follow-ups): more than one custom provider per user; Anthropic-compatible
custom endpoints; Azure-style deployments; per-workspace providers; extra auth headers; keyless
endpoints; streaming; custom image models; cost caps; per-model capability probes.

## Data model

Extend `model_accounts` (one row per `user_id + kind`; migration `0049_custom_model_provider`):

| column     | type      | notes                                                    |
| ---------- | --------- | -------------------------------------------------------- |
| `base_url` | `text`    | nullable; normalized, see below; only set on `custom`    |
| `label`    | `text`    | nullable; 1–40 chars; shown as the connection's name     |
| `vision`   | `boolean` | `not null default false`; only meaningful on `custom`    |

Reuse: `api_key` (already `sealedText`), `model`, `enabled`, `connected_at`, `updated_at`.
`kind` gains `'custom'`.

**Why one, not many.** `model_accounts` is keyed by `(user_id, kind)`, and every downstream
abstraction is keyed by that kind: `RunnerProvider`, `agent_defaults.provider`, runner keys and
`tasks.runner` JSON, the Settings table, `menus` keyed by kind. A second custom provider needs a
synthetic id (`custom:<uuid>`) threaded through all of them, plus a per-row picker. That is a
second project, not the smallest thing that satisfies "9Router + any OpenAI-compatible endpoint".
One `custom` row proves the transport, the screening and the UX.

**How later providers are added.** v2 moves custom providers out of `model_accounts` into a
`custom_providers` table with its own `id`; `RunnerProvider` becomes
`'custom:' + id` (a string, so `agent_defaults.provider` and stored picks keep working); the
single v1 row migrates to the first id. Existing picks for built-in kinds are untouched.

**Rollback safety.** An older build's `toAccount` already ignores a kind it does not know and
logs a warning, so a rollback treats `custom` as disconnected rather than running it as some
other provider. The three new columns are nullable or defaulted.

## Endpoint contract

A custom connection stores the **normalized API base**. Two endpoints derive from it:

- models: `GET {base}/models`
- chat: `POST {base}/chat/completions`

### Accepted URL forms and normalization

Input is the API root the user sees in their provider's docs.

1. Trim. Reject over 2,000 characters.
2. Parse with `new URL`. Scheme must be `https:`. `http:` is accepted **only** when the instance
   flag `CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS=true` **and** the host is loopback or private (see
   Security). Public hosts stay https-only even with the flag on, so a key never travels in clear
   text across the internet.
3. Reject `username`/`password`, any query string, and any fragment.
4. Strip trailing `/` from the path.
5. If the path is empty or `/`, append `/v1`. Otherwise, if the path does not end in `/v1`, append
   `/v1`.
6. Store and echo the normalized value.

| input                                | stored                                 |
| ------------------------------------ | -------------------------------------- |
| `https://router.example.com`         | `https://router.example.com/v1`        |
| `https://router.example.com/`        | `https://router.example.com/v1`        |
| `https://router.example.com/v1/`     | `https://router.example.com/v1`        |
| `https://router.example.com/openai/v1` | `https://router.example.com/openai/v1` |
| `https://router.example.com/api`     | `https://router.example.com/api/v1`    |
| `http://10.0.0.5:20128/v1` (flag on) | `http://10.0.0.5:20128/v1`             |

Build each endpoint as `base + '/models'` / `base + '/chat/completions'` after the check above —
never resolve a user-supplied path with `new URL(path, base)`. Paths outside this shape (`/v1beta`,
`/openai/deployments/...`) are out of scope; the user needs an OpenAI-compatible root.

### Auth and headers

`Authorization: Bearer <apiKey>` on both endpoints; `Accept: application/json`; `Content-Type:
application/json` on the POST. No extra user-supplied headers in v1 (some gateways want `api-key`
or `x-api-key`; follow-up). The key never appears in the URL, logs, responses or error bodies.

### Connect and validation

`POST /api/model-account/custom` does, in order:

1. Feature gate: if `CUSTOM_MODEL_DISABLED=true`, `404 {error}`.
2. Validate `label`, screen `baseUrl` (syntax + DNS/IP), validate `apiKey` shape. Nothing is
   fetched before all three pass.
3. **Live check** with an 8 s budget: `GET {base}/models` with the key.
   - `2xx` with a usable `{data:[{id,...}]}`: catalog available.
   - `401`/`403`: reject the connection — the key is wrong.
   - `3xx`: reject — redirects are not followed.
   - `404`/`405`/`501`, or an unparsable body: catalog unavailable, but the connection is allowed
     (manual model id path).
   - `429`: reject with "rate-limited the check, try again" (we cannot claim it works).
   - timeout, DNS failure, connection refused, `5xx`: reject — the URL is likely wrong.
4. Resolve the model: request `model` if valid, else the existing row's `model` (rotation), else
   the first catalog id, else `400 "Enter a model id — the provider did not list any."`.
5. Upsert the row with `enabled=true`, the given (or previous) `vision`, and `connectedAt=now`.
6. Answer with the full `AccountsView` (below).

Connect never sends a chat completion: providers may bill it, and `GET /models` is enough to
prove URL + key. Model capability is proven by the first real task.

### Catalog

`GET /api/model-account/models?kind=custom` calls `GET {base}/models` with an 8 s budget and a
1 MiB cap. Accept `{data:[{id,name?}]}`; keep entries whose `id` passes the model-id rule and does
not match the existing `NOT_AN_AGENT_MODEL` filter (embeddings/audio/image/etc.); de-duplicate;
cap 1,000; keep provider order. Each entry gets `vision: <account.vision>` so the badge matches
what will actually run. A shape with no eligible entries counts as "no catalog".

When the provider cannot be asked, answer `live:false` with `models: [{id: storedModel, ...}]`
and a caption — never an empty picker. The manual path is `PATCH {model}` with any valid id; the
stored id is always allowed even when the catalog does not list it.

### Replace, enable, default, delete

- Replace (base URL, label, key, vision, or model) = `POST /api/model-account/custom` again. It
  re-runs screening and validation, preserves `model` when omitted, and keeps the old row if the
  new one fails validation.
- `PATCH /api/model-account/custom` with exactly one of `{model}`, `{vision}`, `{enabled}`.
- `DELETE /api/model-account/custom` deletes the row; the runner disappears.
- Default = `PUT /api/agent-runners/default {provider:'custom'}`; only accepted while the account
  is connected and on.

## Security

The base URL is untrusted input used by the server as a fetch target. Implement one shared helper
(`server/customEndpoint.ts`) used by connect, catalog and every completion turn so no path can
skip a check. Reuse the existing address classification where possible
(`isPrivateAddress` in `server/webhooks.ts`, `server/publicUrl.ts`), hardened to the list below.

**Tobias verification checklist**

1. Scheme allowlist: `https:` always; `http:` only with `CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS=true`
   and a private/loopback host. Public `http:` rejected with or without the flag.
2. URL hygiene: no credentials, no query, no fragment, length ≤ 2,000, and no user path is ever
   joined into the endpoint (only the fixed `/models` / `/chat/completions` suffixes).
3. Host screening at **save time and immediately before every outbound request** (connect,
   catalog, each completion turn): resolve with `dns.lookup(host, {all:true})`; every returned
   address must be public. A hostname that fails to resolve is rejected.
4. Private/denied IPv4 ranges: `0.0.0.0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`,
   `192.168/16`, `100.64/10` (CGNAT), `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`,
   `203.0.113/24`, `224/4` (multicast), `240/4` (reserved/broadcast).
5. IPv6: `::`, `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), and
   IPv4-mapped forms in both dotted and hex spellings (`::ffff:127.0.0.1`,
   `::ffff:7f00:1`). `localhost` and `*.localhost` are private.
6. Redirects: **never followed** on any request (`redirect:'manual'`; treat every `3xx` as an
   error). A public URL must not be able to bounce the request inward.
7. Timeouts: connect and catalog 8 s; a chat completion 10 min via its own
   `AbortController`, composed with the run's abort signal so Stop still cancels.
8. Response caps: catalog 1 MiB, completion 5 MiB, 1,000 catalog entries. Read through a capped
   reader and cancel the body past the cap; never call bare `res.json()` on these responses.
   Error bodies are read to 400 chars for the message and then discarded.
9. Key handling: sealed at rest (`sealedText`), absent from every status/JSON body, absent from
   logs. The `Authorization` header is never logged, and any provider error text is scrubbed of
   the exact key before it reaches a log or the browser.
10. Authz: every query filters `user_id`. A pick or default resolves only against the requesting
    payer's rows; Bob's connection can never run Alice's task or appear in her view. No caching
    of accounts across users.
11. DNS-rebinding residual: the lookup-then-connect window is the same accepted risk documented
    for outbound webhooks. Mitigated by re-checking before **every** request, not just at save.
    Follow-up: pin the checked IP in the fetch dispatcher if the risk is later judged material.
12. No new env is read outside `server/env.ts`; both flags are declared there and documented in
    `.env.example` (`CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS`, `CUSTOM_MODEL_DISABLED`).
13. Concurrency: upsert by primary key, no shared mutable config. Two concurrent connects end in
    one of the two saved states, never a half-row; a failed validation leaves the previous row
    intact.

Instance flags (declared in `server/env.ts`):

| flag                                | default | effect                                                       |
| ----------------------------------- | ------- | ------------------------------------------------------------ |
| `CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS` | `false` | allow http + private/loopback hosts (self-host 9Router/LiteLLM) |
| `CUSTOM_MODEL_DISABLED`             | `false` | hide the feature and answer the custom routes with 404       |

## Capabilities and behaviour

- **Transport requirement**: the endpoint must implement OpenAI Chat Completions with `tools` and
  `tool_calls`. This is documented in the form's help text, not probed. A model without tool
  support fails the first turn with the provider's own error, mapped as below.
- **Output budget**: the resident asks for 16,000 output tokens per turn (`server/modelCatalog.ts`
  `TURN_OUTPUT_TOKENS`). Send `max_tokens: 16000`, like the other Chat Completions transports. A
  provider that caps lower returns 400; map a 400 mentioning `max_tokens`/`max output`/context to
  a message that names the 16k budget. `max_completion_tokens`/Responses API variants are a
  follow-up.
- **Streaming**: v1 is non-streaming, one request per turn, 10-minute cap. A provider that only
  streams is out of scope.
- **Vision**: manual toggle, default **off**. Off is the safe default: a text-only model would
  400 on the first screenshot, while stripping images only degrades the review. Off sets
  `AgentModel.vision=false`, which the resident already turns into a no-screenshot run (the
  "no visual review" path); it is never an error. On sends images as `image_url` data URLs. The
  toggle can change between runs.
- **Model id**: trimmed, 1–120 chars, no whitespace/control characters and no `"`, `'`, `<`, `>`,
  `\`. That admits `openai/gpt-5.2`, `moonshotai/kimi-k3`, `qwen3:32b`, `meta.llama-4`,
  `@cf/meta/llama-3.1-8b-instruct`. Empty/oversized ids are 400.
- **No reasoning-effort dial**: effort stays an OpenAI-only concept in v1.
- **Degraded/error states**:
  - `401`/`403` on a turn → `ModelAuthError`: "Custom provider rejected your API key — replace it
    in Settings."
  - `404` with a model-shaped provider message → `ModelUnavailableError`: model cannot run.
  - other `404` → "Endpoint not found — check the base URL."
  - `429` → rate-limited error with the provider status; no silent fallback.
  - `5xx` → provider-failed error with the status.
  - timeout / DNS / refused → `ModelConfigurationError`: "Could not reach <label> — check the base
    URL."
  - empty or unparsable choice → the existing "returned an empty response" error.
  - none of these ever contain the API key or retry against another provider.

## API contract

All routes are session-authenticated and owner-scoped. Every mutation answers with the whole
Settings view, as the existing account routes do. Errors are always `{ "error": "<sentence>" }`.
No custom route ever returns `api_key`.

### Shared view additions

`AccountStatus` gains, for `kind='custom'` only:

```json
{
  "kind": "custom",
  "enabled": true,
  "label": "9Router",
  "baseUrl": "https://router.example.com/v1",
  "model": "openai/gpt-5.2",
  "vision": false,
  "connectedAt": 1762680000000
}
```

`AccountsView` gains `customEnabled: boolean` (mirrors `chatgptEnabled`) and
`menus.custom: []` — the custom provider has no curated menu; its list is live or the one stored
model.

### `POST /api/model-account/custom`

Request (all strings trimmed; `apiKey` is required on every connect/rotate):

```json
{
  "baseUrl": "https://router.example.com/v1",
  "label": "9Router",
  "apiKey": "sk-...",
  "model": "openai/gpt-5.2",
  "vision": false
}
```

`model` and `vision` are optional on the first connect (`model` falls back to the first catalog
id; `vision` to `false`). On rotate, omitted `model`/`vision` keep the stored values.

- `200` → `AccountsView`
- `400` → `{error}` for an invalid URL/label/key/model, an unreachable provider, a rejecting key,
  a redirect, or a rate-limited check.
- `404` → `{error: "Custom provider connections are disabled on this server"}` when
  `CUSTOM_MODEL_DISABLED=true`.

### `PATCH /api/model-account/custom`

Request: exactly one of `{ "model": "..." }`, `{ "vision": true }`, `{ "enabled": false }`.
`400` if zero or more than one field is present, the id is invalid, or the account is not
connected. `200` → `AccountsView`. Turning `enabled` on wakes queued work for that user.

### `DELETE /api/model-account/custom`

`200` → `AccountsView`; idempotent when nothing is connected.

### `GET /api/model-account/models?kind=custom`

- Not connected: `{ "models": [], "live": false }`
- Catalog reachable: `{ "models": [{ "id", "name", "blurb", "vision": false }], "live": true }`
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
  "model": "openai/gpt-5.2",
  "vision": false,
  "models": [{ "id": "openai/gpt-5.2", "name": "openai/gpt-5.2", "blurb": "" }]
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
new kind automatically; its display label becomes the account label where available.

## UX

Settings → Doop Agent, under "Add a connection", a row **Custom provider (OpenAI-compatible)**
(sits beside the five built-ins; hidden when `customEnabled` is false).

Fields while connecting:

- **Provider name** — text, 1–40, placeholder "9Router".
- **Base URL** — text, placeholder `https://router.example.com/v1`; help: "The OpenAI-compatible
  API root. We add `/v1` if you leave it off."
- **API key** — password; help: "Encrypted at rest and never shown again."
- **Model id** — optional text; help: "Leave blank to use the first model the provider lists."
- **This model can see screenshots** — checkbox, default off, with the warning that leaving it off
  skips visual review.

States:

- idle → busy (Connect disabled, spinner) → connected row.
- Invalid URL, key rejected, unreachable, or a bad model id: the server's `{error}` appears under
  the matching field, the row stays unconnected, the previous connection (if rotating) is intact.
- Catalog unavailable: the row connects with the typed/stored model and the dropdown carries the
  "enter a model id" caption.
- Connected row: label as its name; the line under it shows `host` and the model; model dropdown
  (live list once fetched, otherwise the one stored id); "No visual review" badge when vision is
  off; on/off switch; "…" menu with Make default, Replace key, Disconnect. A `Default` badge
  appears when it is the `agent_defaults` pick.
- Replace key: the same form, prefilled with label/base URL/model/vision, empty key; submitting
  re-validates and keeps the stored model/vision when they are not edited.
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

- **AC1 — Connect a private 9Router.** Given `CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS=true` and a
  stub provider at `http://10.0.0.5:20128/v1` returning `{data:[{id:"openai/gpt-5.2"}]}`, when
  Alice POSTs `{baseUrl:"http://10.0.0.5:20128", label:"9Router", apiKey:"sk-test"}` then the
  response is 200, and `GET /api/model-account` shows one `kind:"custom"` account with
  `baseUrl:"http://10.0.0.5:20128/v1"`, `label:"9Router"`, `model:"openai/gpt-5.2"`,
  `enabled:true`, `vision:false`.
- **AC2 — https by default.** Given the flag off, when the base URL is `http://example.com/v1`,
  then POST is 400 with a message naming `https://`, and no outbound request is made.
- **AC3 — Private addresses are refused by default.** Given the flag off, when the base URL has
  host `localhost`, `127.0.0.1`, `10.x`, `172.16.x`, `192.168.x`, `169.254.169.254`,
  `100.64.x`, `[::1]`, or a hostname whose A/AAAA records include any of these, then POST is 400
  with the "private to the server's own network" message and no request is made. The same holds
  when the URL is syntactically `https://`.
- **AC4 — Public http stays refused with the flag on.** Given `CUSTOM_MODEL_ALLOW_PRIVATE_NETWORKS=true`,
  when the base URL is `http://example.com/v1`, then POST is still 400.
- **AC5 — Normalization.** Given each row of the normalization table, when it is normalized, then
  the stored value matches, and a run calls `{stored}/chat/completions` while the picker calls
  `{stored}/models`.
- **AC6 — Redirects are never followed.** Given a provider answering `302 Location:
  http://169.254.169.254/latest`, when Alice connects, then POST is 400 ("redirected; redirects
  are not followed"), the redirect target is not fetched, and no row is written.
- **AC7 — Bad key does not save.** Given `/models` answers 401, when Alice connects, then POST is
  400 naming the key, and `GET /api/model-account` has no custom account. If a previous custom
  account existed, it is unchanged and still enabled.
- **AC8 — Catalog and manual fallback.** Given `/models` answers 404, when Alice connects with
  `model:"my-model"`, then the account is saved and `GET /api/model-account/models?kind=custom`
  returns `{models:[{id:"my-model",...}], live:false, error:<string>}`. Given `/models` returns
  five agent-capable ids, then the same route returns `live:true` with all five and no error.
- **AC9 — Manual id beats the catalog.** Given a live catalog without `my-model`, when Alice
  PATCHes `{model:"my-model"}`, then it is accepted, stored and echoed; an empty, whitespace or
  121-char id is 400 and changes nothing.
- **AC10 — Replace and delete.** Given a connected custom account, when Alice POSTs again with a
  new key and no model, then 200, the model is unchanged, and the next completion uses the new
  key. When she DELETEs, then 200, `GET /api/model-account` has no custom row, and
  `GET /api/agent-runners` no longer lists it.
- **AC11 — Key secrecy.** Given any successful connect, then the key appears in no response body
  (`GET /api/model-account`, models, runners), and the stored `api_key` column is ciphertext
  (`sealedText`), not the plaintext. Logs for the connect contain the host, outcome and duration
  but no key.
- **AC12 — Owner isolation.** Given Alice has a custom account and Bob has none, when Bob calls
  `GET /api/model-account`, `GET /api/model-account/models?kind=custom`, and
  `PUT /api/agent-runners/default {provider:"custom"}`, then Bob sees no account, gets an empty
  catalog, and is refused the default; a task that Bob pays for never uses Alice's row.
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
- **AC16 — Error mapping.** Given a connected provider, when a turn answers 401/403 then the
  error is `ModelAuthError` naming the key replacement; 404 with a model message →
  `ModelUnavailableError`; other 404 → endpoint/base-URL message; 429 → rate-limit message; 5xx →
  provider-failed message; a timeout → `ModelConfigurationError`; no message contains the key.
- **AC17 — Caps and timeouts.** Given `/models` streams more than 1 MiB, then the catalog is
  abandoned at the cap and `GET models` answers `live:false` with an error rather than growing
  memory. Given `/models` never answers, connect fails at 8 s. Given a completion runs past 10
  min, it aborts and maps to a configuration error, and the run's Stop still cancels earlier.
- **AC18 — Model-id validation.** Given ids `openai/gpt-5.2`, `qwen3:32b`,
  `@cf/meta/llama-3.1-8b-instruct`, `meta.llama-4`, then each connects; given `""`, `" "`,
  a 121-char id, or one containing a quote/backslash, then each is 400.
- **AC19 — Feature flags.** Given `CUSTOM_MODEL_DISABLED=true`, then POST/PATCH/DELETE custom
  return 404 and `AccountsView.customEnabled` is false. Given the flag flips off after a connect,
  then the account no longer appears as a runner. Both env vars are in `.env.example` and
  `tests/env.test.ts` passes.
- **AC20 — One-change PATCH.** Given `{model, vision}` or `{}`, then PATCH is 400 and the row is
  unchanged.
- **AC21 — Existing providers unchanged.** Given the five built-in kinds, when the suite runs,
  then their connect/rotate/model/effort/default behavior and `menus` entries are unchanged;
  `menus.custom` is `[]`; every `Record<AccountKind, …>` typechecks.
- **AC22 — Rollback tolerance.** Given a row with `kind='custom'` read by a build without the
  kind, then it is ignored as disconnected (existing `toAccount` behavior) and nothing throws.
- **AC23 — Tests exist and pass.** The test files listed below exist, and
  `bun run test` (or the repo's vitest invocation for the touched files) passes with them.
- **AC24 — Evidence.** The PR body carries the branch name, commit SHA, base `paperclip`, and
  `git rev-list --count paperclip..HEAD` / `HEAD..origin/main` freshness evidence.

## Tests to add

- `tests/customProvider.test.ts` — HTTP happy path (AC1), https/private refusal (AC2–AC4), bad
  key (AC7), catalog/manual (AC8), replace/delete (AC10), key secrecy (AC11), owner isolation
  (AC12), default/off (AC13), vision (AC15), flags (AC19), one-change PATCH (AC20).
- `tests/customEndpoint.test.ts` — normalization table (AC5), address classifier (AC3), redirect
  policy (AC6), caps/timeouts (AC17), model-id rule (AC18).
- `tests/customProviderTransport.test.ts` — config built from the stored base URL, request body
  shape (`tools`, `max_tokens:16000`), vision on/off image handling, error mapping (AC16), and
  that a redirect response is surfaced, not followed.
- `tests/customProviderCatalog.test.ts` — parse/filter/cap, `live:false` fallback (AC8),
  `vision` stamped from the account.
- `tests/customProviderSettings.test.tsx` — form fields, error under the right field, replace,
  disconnect, off state, default badge (AC1/AC7/AC10/AC14).
- extend `tests/modelPickerRunners.test.tsx` — custom label/models/no-vision in the composer
  (AC14); extend `tests/defaultRouting.test.ts` for the custom default (AC13).

## NFRs

- Connect validation: p95 ≤ 3 s for a reachable provider; hard 8 s timeout; one `/models` call.
- Catalog: 8 s, 1 MiB, ≤ 1,000 entries, no caching (same as the existing catalogs).
- Completion: 10 min hard cap, 5 MiB response cap, no change to per-turn output budget (16,000).
- Screening overhead: one DNS resolution per outbound request (OS-cached); ≤ 50 ms p95 added.
- Secrecy: 0 occurrences of the API key in responses/logs; 0 plaintext keys at rest.
- Isolation: 0 cross-user reads/uses in tests.
- Availability: a custom provider failure fails only that run with a clear message; it never
  changes another account's behavior and never silently falls back to the server key.

## Follow-ups

1. Multiple custom providers per user (v2 data model above).
2. Anthropic-compatible custom endpoints and Azure-style deployments.
3. Extra auth headers (`api-key`, `x-api-key`, custom) and keyless local endpoints.
4. Streaming Chat Completions; `max_completion_tokens` and Responses-API providers.
5. A capability probe/test button (a cheap completion) and cost caps.
6. Per-workspace providers and admin policy.
7. Pin the screened IP in the fetch dispatcher if security wants the DNS-rebinding window closed.

## Open questions

- **Keyless local endpoints** (Ollama, a LiteLLM with no key): v1 requires a non-empty key.
  Recommendation: keep required for v1; add an explicit "no key" mode only with a follow-up
  security review. Owner: Axel (CTO), with Tobias.
- **Default-enabled on hosted doop.design**: recommendation is enabled with the SSRF controls
  above and `CUSTOM_MODEL_DISABLED` as the operator escape hatch. Owner: Axel with Tobias.
- **Extra auth-header style**: defer; recommendation is one follow-up after 9Router/LiteLLM
  feedback. Owner: Tyler.
