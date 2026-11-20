# Sign in with ChatGPT: research (Phase 5, Task 12)

Status: **viable.** OpenAI documents a self-serve flow for open-source, locally run apps. It uses
dynamic client registration and the public Responses API, and Novel qualifies. Novel ships it.

Researched 2026-11-19, from OpenAI's official pages only. Each claim below names its source. Every
source was read on 2026-11-19.

## The question and the rule

Can an open-source desktop app let a writer use their ChatGPT plan, through a path OpenAI documents
for third parties? Controller ruling R21 sets the bar. The path must be an officially documented
third-party registration or OAuth flow. It must not reuse the Codex CLI's `client_id` or any other
OpenAI first-party app's. It must not present the app as Codex, and it must not call undocumented
ChatGPT backend endpoints. Any of those would be impersonation, the principle behind the refusal of
Claude-subscription login (decision 6a07d777).

## Findings

### 1. Who may use it, and whether an open-source desktop app qualifies

- The Help Center article on using a ChatGPT plan in other apps addresses developers directly. It
  says: "If you're an open source developer, explore our developer docs" (developers.openai.com/siwc).
  Commercial partners are sent to an interest form instead.
  Source: https://help.openai.com/en/articles/20001542
- The Quickstart: "ChatGPT plan usage is available to all open-source partners and selected private
  clients." It also says the open-source flow "registers your client and issues OAuth credentials for
  eligible Responses API requests, without a client secret or partner API key."
  Source: https://developers.openai.com/siwc/quickstart
- The plan-usage overview: "These docs explain ChatGPT plan usage for open-source and locally hosted
  apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest
  form." Source: https://developers.openai.com/siwc/token-sharing-open-source
- OpenAI's cookbook article, "Integrating Sign in with ChatGPT in your open-source app", answers the
  question most directly. Its worked example, "Paste Perfect", is "an open-source desktop app". Its
  "Usage policy and terms" section says: "The ChatGPT plan usage integration described here is
  available for open-source tools and personal projects that run locally. If you're building a paid
  or remotely hosted app, join the waitlist." It also says "At launch, ChatGPT plan usage is available
  to open-source projects, personal projects that run locally, and selected private apps."
  Source: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- Novel is MIT-licensed (`LICENSE`), free, and runs locally on the writer's computer. That is the
  case the cookbook describes.
- The "Request a client ID" page says Sign in with ChatGPT is "offered to a select group of commercial
  partners". That page covers identity-only sign-in for websites, which needs a provisioned `oaiapp_`
  client. Open-source plan usage does not need one, because the client is registered during sign-in.
  Sources: https://developers.openai.com/siwc/request-client-id ,
  https://developers.openai.com/siwc/website
- The ChatGPT Learn page lists four "Open-source integrations": OpenClaw, OpenCode, Pi and T3. The
  developer docs never make a listing a precondition of the self-serve flow.
  Source: https://learn.chatgpt.com/docs/sign-in-with-chatgpt

### 2. How an app registers

There is no form and no shared client id. The app registers itself during the user's first sign-in.

- "Start first-time registration with `client_id=dynamic_agent_client`, include the host's
  `ext_agent_host_id`, and set `agent_name_hint` to your app's actual name, used consistently across
  installations. After the user names and authorizes the agent, the callback returns its issued
  `client_id`. … `dynamic_agent_client` is the first-time registration entrypoint, not the client ID to
  save or use for token exchange. This direct flow needs neither a client secret nor a partner API key."
  Source: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- Each issued `client_id` is "bound to the authenticated user and the workspace selected during
  registration". Source: https://developers.openai.com/siwc/token-sharing-open-source
- The host id is a stable, opaque value per installation: `urn:uuid:` with a v4 UUID, a JWK thumbprint
  URI, or `did:key`. It must not identify the user. "A host ID is not an authentication credential."
  Source: https://developers.openai.com/siwc/token-sharing-open-source
- Novel sends `agent_name_hint=Novel`, its own name. It never sends another app's client id. This is
  the opposite of impersonation, and it meets R21.

### 3. Endpoints

From the sign-in guide and OpenAI's discovery document, which the website guide names as the
authoritative source (https://auth.openai.com/.well-known/openid-configuration):

| Use | Endpoint |
| --- | --- |
| Authorization (system browser) | `https://auth.openai.com/api/accounts/authorize` |
| Code exchange and refresh (form POST) | `https://auth.openai.com/api/accounts/oauth/token` |
| Revocation (sign-out) | `https://auth.openai.com/api/accounts/oauth/revoke` (the discovery document's `revocation_endpoint`) |
| ID token keys (RS256) | `https://auth.openai.com/.well-known/jwks.json` |
| Issuer | `https://auth.openai.com` |
| Models | `GET https://api.openai.com/v1/models` |
| Inference | `POST https://api.openai.com/v1/responses` |

Authorization parameters: `client_id` (`dynamic_agent_client` the first time, then the issued id),
`agent_name_hint` (first time only), `ext_agent_host_id`, `response_type=code`, and `redirect_uri`.
The redirect URI is an HTTP loopback on `127.0.0.1` with the path `/auth/callback`. Only the port may
vary, and `localhost` must not be used. The other parameters are `scope=openid profile email
offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`,
`state`, `nonce`, `code_challenge_method=S256` and `code_challenge`. A renewal adds `id_token_hint`
and `login_hint`.
Sources: https://developers.openai.com/siwc/token-sharing-open-source/sign-in ,
https://developers.openai.com/siwc/website

### 4. Token type and refresh

- The token response includes "`access_token`, `refresh_token`, `id_token`, `token_type`,
  `expires_in`, `scope`, and `earliest_refresh_at`". "Access tokens are valid for one hour
  (`expires_in: 3600`)." "Refresh tokens are valid for 30 days. Each successful refresh returns a
  replacement refresh token with a fresh 30-day lifetime."
  Source: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- The access token is a Bearer JWT with audience `https://api.openai.com/v1`. Its OpenAI metadata is
  opaque. Source: the same page.
- To refresh, POST form-encoded `grant_type=refresh_token`, the issued `client_id`, the
  `refresh_token` and `resource=https://api.openai.com/v1`, and "omit `scope` to retain the grant".
  The guide also says to "serialize refreshes for the same session so two processes do not race a
  rotating token."
  Source: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- These refresh errors mean the user has to sign in again: `invalid_grant`, `invalid_refresh_token`,
  `token_expired`, `refresh_token_expired`, `refresh_token_invalidated` and `refresh_token_reused`.
  `invalid_client` means the client configuration is wrong.
  Source: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- The app must check the ID token's signature against the JWKS, its issuer, its audience (the issued
  client id), its expiry and its nonce. "A valid ID token alone does not authorize ChatGPT plan usage":
  the granted scopes must include `chatgpt.tokens.use.direct`.
  Source: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- To sign out, revoke the refresh token at the `revocation_endpoint`
  (`token`, `token_type_hint=refresh_token`, `client_id`). "An empty HTTP 200 is the revocation
  success response." If revocation is not confirmed, tell the user. The user can also disconnect the
  app in ChatGPT Settings.
  Source: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Where to keep tokens: the docs suggest local files with owner-only permissions. They also say to
  "keep tokens out of browser storage, source control, logs, analytics". Novel keeps them in the OS
  keychain instead, which is stricter.

### 5. Which API the token calls

- "Send the OAuth access token as `Authorization: Bearer` to `POST https://api.openai.com/v1/responses`
  … do not point it at ChatGPT's `backend-api` endpoints."
  Source: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- The model list is `GET https://api.openai.com/v1/models` with the same token. It answers a `models`
  array of `{ slug, display_name, visibility }`. Show the entries with `visibility: "list"`, in the
  server's order. Source: the same page.
- These preview limits apply to every request:
  - set `store: false` and `stream: true`;
  - send `input` as an array;
  - use instructions or developer messages, because explicit `system` items are rejected;
  - omit `temperature`, `top_p`, `max_output_tokens`, `metadata`, `user`, `previous_response_id` and
    the other fields the page lists;
  - group function tools in namespaces;
  - do not use hosted tools such as file search or code interpreter.

  Source: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

### 6. Usage terms

- "Review OpenAI's terms and policies before distributing your integration."
  Source: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt , pointing to
  https://openai.com/policies/
- Usage counts against the user's plan, and users manage per-app limits at ChatGPT Settings ▸ Usage.
  Apps should link there with a **Manage usage** action, show **Using ChatGPT plan** where requests use
  the plan, and confirm plan use after the first sign-in. The recommended button label is **Continue
  with ChatGPT**, with approved OpenAI branding.
  Sources: https://developers.openai.com/siwc/ui-ux-guidelines ,
  https://developers.openai.com/siwc/quickstart ,
  https://help.openai.com/en/articles/20001542
- No terms page specific to Sign in with ChatGPT was found. None of the pages read adds a
  registration agreement beyond OpenAI's general policies.

## Ambiguities, and how Novel handles them

1. **"Open-source partners."** The Quickstart's word "partners", together with the Learn page's list
   of four integrations, could suggest a vetted list. The overview, the sign-in guide, the Help Center
   and the cookbook all describe a self-serve flow for open-source and locally run apps, with no
   registration step outside the sign-in itself. The cookbook's example is an open-source desktop app.
   Novel reads the flow as self-serve. If OpenAI refuses a registration, the sign-in fails closed with
   a message, and the writer can still use an API key or OpenRouter.
2. **`earliest_refresh_at`.** It is named but not described. Novel uses it only when it reads as a
   plausible Unix time, never refreshes before it unless the token has expired, and otherwise
   refreshes five minutes before expiry.
3. **Branding.** The guidelines ask for approved OpenAI branding on the button. Novel uses a
   text-only **Continue with ChatGPT** button, with no logo, so it does not use OpenAI's marks at all.
4. **A declined plan scope, and sign-out.** The docs ask apps to keep the account/client mapping on
   sign-out and after a declined plan scope, and to sign in again with the saved issued client id.
   Novel does: `chatgpt-host.json` (no secret) lists each account it registered, with its issued
   client id and the connection that uses it. Remove and a declined scope keep the entry. The next
   Continue with ChatGPT reuses the one known account without a connection, with `login_hint`, and
   with `prompt=consent` if the plan was declined. A declined scope still adds no connection: the
   tutor cannot use a sign-in without the plan. If two such accounts are known, Novel does not guess
   and registers instead. Settings names the account it will reuse and offers **Use Another Account**.
   A reuse that fails for any reason other than a cancel or a no is not tried again. A client OpenAI no
   longer knows (`invalid_client`, for example after the writer disconnected Novel in ChatGPT Settings)
   is forgotten.

## What Novel built

- **Rust.** `src-tauri/src/ai/chatgpt.rs` holds the flow, and `providers.rs` holds the endpoints
  (`PlanSignIn`). The sign-in uses PKCE S256 with a fresh `state` and `nonce`, on the loopback
  listener shared with Sign in with OpenRouter. The code exchange happens in Rust. The ID token's
  RS256 signature is checked with `ring`, which was already a direct dependency. Refresh happens in
  Rust inside `ai_fetch`, five minutes before expiry and one at a time. Sign-out revokes the refresh
  token. Sign In Again reuses the issued client id and keeps only the same account.
- **Keychain only.** The tokens, the issued client id and the account are one record, the
  connection's keychain secret. Windows Credential Manager holds about 1,280 characters per entry, so
  a long record is split. The split is written as a new generation of parts, then a manifest entry
  (generation, part count, SHA-256) is switched in one write, then the old generation is deleted. A
  failed or interrupted write leaves the old record readable, and a read that does not match the
  manifest is retried, then reported as transient (never as signed out). A refreshed record the
  keychain refuses is used and kept in memory until it can be stored.
- **Not secret, outside the keychain.** `chatgpt-host.json` holds the host id and the known accounts
  (`sub`, email and the issued client id of each account; a public client's id is not a credential).
- **Pinned routes.** Rust sends the plan token only to `/responses` and `/models`.
- **Webview.** `src/features/ai-tutor/providers/chatgpt.ts` is the Responses API adapter with the
  preview rules applied. The Settings page has **Continue with ChatGPT**, the one-time ban warning
  (`prompts/scripted/ban-warning.md`), **Manage Usage** and **Sign In Again**.
- **No new dependencies.**
