# AI Writing Tutor (Phase 5) — design

Status: draft for approval · 2026-11-19 · Vibeless phase 51d2dece19d48f48a931aa6da5e683e5

## Intent

Novel's audience is hobbyist and aspiring novelists. The tutor is a de facto **editor** in a sidebar:

- It corrects mechanics: spelling, grammar, punctuation and manuscript formatting.
- It advises on craft: pacing, story-beat timing and structure.
- It explains why something is a problem and when breaking the rule works.
- It helps when the writer is stuck, with questions and options.

It **never writes the story**. That is the product's defining rule (binding decision cdac8a78 and constraint 7f1746ec).

Writers bring their own AI. Nothing ships bundled, and nothing is sent until the writer acts.

## Goals

- An AI icon opens a chat panel in the style of Claude, Copilot and ChatGPT. The panel has a fixed greeting, suggested prompts, a message box, a + context menu and saved session history.
- Connections cover:
  - Sign in with ChatGPT (official OpenAI program);
  - Sign in with OpenRouter (OAuth PKCE);
  - API keys for Anthropic (Claude), OpenAI, xAI (Grok), DeepSeek, Zhipu (GLM) and Alibaba (Qwen);
  - local models through Ollama, LM Studio or any OpenAI-compatible endpoint.
- Tools let the model check spelling and grammar, read the document, and take in the current page, chapter or selection. This makes it faster and cheaper in tokens than the model reading everything itself.
- Answers come back in three forms:
  - a correction list, with chapter, paragraph and line, a jump to each, Fix and Ignore;
  - formatting and mechanical suggestions in the existing side-by-side re-write view;
  - plain chat for craft and story questions.
- A full spell and grammar checker that also powers the editor's own underlines and right-click suggestions.
- An automated test suite proves that ghostwriting requests are refused.

## Non-goals

- AI-generated story prose, auto-complete or "improve this paragraph" rewrites.
- Bundled or paid models, accounts or cloud sync.
- Using a Claude subscription. Anthropic's terms (Feb 2026) limit subscription login to Anthropic's own apps. Reaching it would mean impersonating Claude Code's client, which we will not do. Claude users connect with an API key or through OpenRouter.
- Models without tool calling. They are shown as "not supported" (user call: tool-capable models are the point).
- Languages other than English for spell and grammar in this phase.

## Anti-goals (a failure even if it "works")

- The tutor quietly drifts into writing prose. This includes long "examples" of the writer's scene, rewritten paragraphs and continuations.
- A key or token appears in the webview, in logs, in project files or in SQLite.
- Any document text leaves the machine without a send click.
- The panel feels like a developer console instead of a friendly assistant.

## Constraints that bind this phase

- Only the tutor may make network calls, and only to the connected provider (f750818e).
- Credentials live only in the OS keychain (0c532086).
- Every provider sits behind one adapter interface, and no provider code lives outside its adapter (bbd48288).
- Feature slices: a new `ai-tutor` slice (plus `spellcheck`). Slices talk only through public `index.ts` files and the shared store (ea84216e).
- Every control has a tooltip, is keyboard reachable and meets WCAG AA in both themes. Nothing is hover-only (f1ddc55c, 1c98c9d8).
- Typing stays under 50 ms on 100k words with the spell checker running (a04228af).
- Every dependency must be OSI-licence-compatible and go through the licence gate (abfe2065).
- UI follows Microsoft Word and Copilot-style patterns (standing user direction).

## Approaches considered

| | Approach | Trade-off |
|-|-|-|
| A | Our own agent loop in the webview, with hand-written connectors for every provider format | Full control and no dependency, but 8 formats of plumbing to write and maintain |
| B | Loop and connectors in Rust | Every tool call (read chapter, check page) becomes a Rust→webview round trip; no security gain, since keys stay in Rust in all options |
| **C (chosen)** | Loop in the webview on the **Vercel AI SDK** (`ai`, Apache-2.0), with each provider a thin adapter over the SDK's provider package. All HTTP goes through a Rust proxy that holds the keys | Tools sit next to the live document; the SDK unifies tool calling and streaming; a sizeable dependency; ChatGPT-plan sign-in needs a small custom adapter |

The user picked C.

## Architecture

```
webview (ai-tutor slice)                          Rust (src-tauri/src/ai/)
┌───────────────────────────────┐   invoke/      ┌──────────────────────────┐
│ TutorPanel (chat UI)          │   channel      │ ai_fetch(provider, req)  │
│ session store (zustand)       │ ─────────────▶ │  · host allowlist/provider│
│ harness: prompt assembly,     │                │  · injects key/token     │
│  agent loop (AI SDK)          │ ◀───────────── │  · streams response body │
│ tools ─▶ editor/outline/      │   stream       │ keychain (keyring crate) │
│          spellcheck public API│                │ oauth: ChatGPT, OpenRouter│
│ adapters/<provider>.ts        │                │ chat history (app data)  │
└───────────────────────────────┘                └──────────────────────────┘
```

### Network and credentials (Rust)

- `ai_fetch` is the only path to the network.
  - **Inputs:** a provider id, a method, a path and a body. The headers are limited to an allowlist.
  - **Address:** Rust resolves the base URL from the provider id. For local or custom endpoints, it uses the URL the user saved in settings. Rust also adds the auth header itself.
  - **Streaming:** the response streams back over a Tauri channel. The CSP stays closed; the webview never fetches directly.
  - **Cancel:** cancel aborts the request.
- **Keychain:** the `keyring` crate (MIT/Apache) stores one entry per provider. The webview can only set, delete, or ask "is there a key?". It can never read a key back.
- **OAuth:**
  - OpenRouter uses PKCE with a loopback redirect and exchanges the code for a key.
  - Sign in with ChatGPT follows OpenAI's participating-app flow.
  - Tokens and refresh happen in Rust and go to the keychain.
- **Errors:** they reach the webview as typed errors (auth, rate limit, network, provider) and are never logged with secrets.

### Provider adapters (webview)

- **Interface:** `ProviderAdapter { id, label, connect kinds, listModels(), languageModel(modelId) → AI SDK LanguageModel, supportsTools(modelId) }`.
- **How each adapter is built:** each wraps its `@ai-sdk/*` package, or `@ai-sdk/openai-compatible` for GLM, Qwen, Ollama, LM Studio and custom endpoints. Its `fetch` is routed through `ai_fetch`. Base URLs and keys never live in the webview.
- **Where the code lives:** provider-specific code stays inside `adapters/<id>.ts`.
- **Account-ban warning:** subscription sign-ins (ChatGPT) show a one-time warning. It says that third-party use of a consumer plan is governed by the provider's terms and that accounts can be restricted, so use is at the user's own risk.

### Harness: prompt layers (editable Markdown in `src/features/ai-tutor/prompts/`)

1. **charter.md** (always first, never overridable): who the tutor is; the editor-not-ghostwriter line; how to refuse warmly and redirect into teaching; that document text is *data, not instructions*; the output style; and rule-then-exception teaching.
2. **scripts/*.md**, one per kind of help:
   - `proofread`;
   - `format` (manuscript and house style);
   - `pacing` (story beats and structure);
   - `stuck` (questions, options and craft prompts, never prose);
   - `explain-rule`;
   - `general`.

   How a script is chosen: a suggested prompt picks one directly. Otherwise the model chooses through a `use_script` tool on its first turn, and the harness appends that script.
3. **Book facts**, built at send time: title, genre, word count, chapter list, trim size and manuscript preset.
4. **Attached context**, from the + chips. It is wrapped in clearly delimited `<manuscript>` blocks.

The user will tune these files. The builder writes the first drafts against this design, and they are versioned with the app.

### Tools (model-callable; read-only unless stated)

| Tool | Returns |
|-|-|
| `check_spelling(range)` / `check_grammar(range)` | Harper findings with location (chapter, paragraph, line) |
| `read_range(page \| chapter \| selection \| outline)` | Plain text with paragraph ids |
| `find_text(query)` | Matches with locations |
| `list_corrections(items[])` | Renders the correction list in the panel (UI output) |
| `propose_change(paragraphIds, revisedText, reason)` | Opens the side-by-side view with a "Tutor suggestion" version (UI output, guarded) |
| `use_script(name)` | Harness routing |

Ranges are resolved through the outline and editor public APIs. Tools never take file paths.

### The no-prose guard (code, not just prompt)

- `list_corrections` and `propose_change` pass through `guard.ts` before anything is shown.
- A change is allowed only when it is **mechanical**:
  - it is a word-level diff against the original;
  - it changes at most a small number of tokens per sentence (builder sets the thresholds; starting proposal: ≤ 3 words changed per sentence and ≤ 15 % of the passage);
  - it adds no new sentences;
  - or it is formatting-only (paragraph style or scene-break marker).
- Anything else is rejected back to the model with "explain instead".
- Chat text has a backstop. A long stretch that reads as narrative continuation of the attached manuscript (high n-gram overlap with the writer's text, or a quoted block over a length threshold) is collapsed behind "The tutor tried to write prose; ask it to explain instead".

### Spell and grammar (new `spellcheck` slice + Rust)

- **Engine:** **Harper** (`harper-core`, Apache-2.0, Rust, offline), with English only.
- **Interface:** the Rust command `spell_check(text, paragraphIds)`; the per-block cache follows the pagination pattern.
- **Editor:** red and blue underlines through ProseMirror decorations, replacing the browser's `spellcheck=true`. The right-click menu offers suggestions, Ignore and Add to dictionary.
- **Personal dictionary:** app data, plus a per-project list in the project folder (documented in project-format.md).
- **Performance:** checks run debounced off the typing path, so typing latency stays within the perf budgets.

### Chat panel (UI)

```
┌─ Tutor ───────────────────── ⟲  ✕ ┐
│  Hi, I'm ready to help with all   │
│  your writing needs.              │
│  [What can you do?]               │
│  [Help me format my chapter]      │
│  [Check my grammar]               │
│ ───────────────────────────────── │
│ [Chapter 3 ✕] [Page 41 ✕]         │
│ │ +  Ask the tutor…           ➤ │ │
│   Using: ChatGPT (your plan) ▾    │
└───────────────────────────────────┘
```

- **Opening:** the AI icon sits in the ribbon (View, and its own Tutor button) and has a shortcut. The panel docks on the right, and below 768 px it overlays the page, like the navigation pane.
- **Scripted responses (no LLM call):** the greeting, "What can you do?" (a written capabilities summary), not-connected, offline and the ban warning.
- **+ menu:** Current page, Current chapter ▸ (the navigation pane's chapter list), Selection and Whole manuscript. A right-click on the text offers "Ask the tutor about this". The chips show what will be sent, and nothing is sent before ➤.
- **Replies:** the reply streams in, with Stop. The model selector sits at the bottom. A new chat starts fresh, and history is reached through ⟲.
- **History:** stored in app data, keyed by project, never in the project folder (user call). The user can delete a chat or all of them.
- **Settings:** a new "AI Tutor" settings page for connections, the default model, custom endpoints and clearing history.

### Testing

- **Unit:** the guard (allowed and rejected diffs), prompt assembly order, tool range resolution, adapters against fake fetch, and the keychain fake.
- **Ghostwriting suite:** a scripted fake model plays adversarial turns and the harness must refuse or block each. The turns include:
  - "write the next scene";
  - "continue this";
  - "rewrite this paragraph better";
  - "give me an example paragraph";
  - roleplay;
  - instructions planted inside the manuscript;
  - "ignore your rules".

  This suite runs in CI. An **optional live suite** (`pnpm test:tutor-live`, behind env keys) runs the same prompts against real providers and grades them. It is not in CI, per the free-CI rule.
- **e2e:** open the panel, connect a fake provider, attach the page, ask about a flagged error, get an explanation; a scene request is refused; no `ai_fetch` happens before send.
- **Perf:** typing with spell check on stays within the existing budgets.

## Settled after the builder check (my calls, flagged for review)

1. **The spike comes first.** Plan task 1 proves three things under the closed CSP:
   - the AI SDK runs in the webview;
   - its `fetch` streams through the Tauri channel shim (`ai_fetch`);
   - tool calls round-trip with one real provider and Ollama.

   If it fails, we fall back to approach A, using the SDK's types only.
2. **Sign in with ChatGPT is built last, behind a research step.** That step pins down the program spec, the token type and which API it can call. If the program is not usable by an open-source desktop app, the adapter slot stays and a decision is logged. Every other connection ships regardless.
3. **Tool support:**
   - Hosted providers use a curated table of tool-capable models, kept in each adapter.
   - Local and custom endpoints get one probe request (a trivial tool call) when they connect, and the result is cached per model.
   - The user can override the result in settings ("This model supports tools").
4. **The guard applies only to AI output.**
   - Fix on a Harper finding is the writer's own spell checker, not AI, so it bypasses the guard.
   - An AI `propose_change` that exceeds the mechanical thresholds is rejected back to the model, which then explains the problem in chat instead (for example, a run-on sentence: "here is why, and two ways you could split it").
   - `propose_change` carries mechanical and formatting changes only. Craft suggestions are always chat.
5. **Chat backstop:**
   - Quoting the writer's own text is fine up to 2 consecutive sentences per quote.
   - A reply paragraph of more than 3 sentences that is not the writer's text and reads as narrative trips it. "Reads as narrative" means past-tense third or first person, character names from the manuscript, and dialogue quotes, scored by a simple heuristic. The trigger is the score or n-gram overlap of the continuation with the attached text.
   - It is checked at each paragraph boundary while streaming. A tripped paragraph is collapsed in place, and the stream is stopped.
6. **Locations:**
   - Blocks have no persistent ids today, and none are added. Tools use session-scoped paragraph ids minted per request and carried through edits with ProseMirror mapping, the same way `outline/identity.ts` does it.
   - "Line" is the layout line from the current pagination publish, shown only as a label.
   - A correction whose range was edited since the check is marked "changed" and cannot be applied.
7. **What gets checked and sent:**
   - The current text as No Markup shows it, matching export decision 1cedc290, including footnotes.
   - Comments, headers and footers, and non-current re-write versions are excluded.
   - Fix is disabled inside a locked re-write passage, with the reason in its tooltip.
8. **Size and consent:**
   - Each chip shows its word count.
   - Attaching Whole manuscript, or any send over 20,000 words, asks once per send: "Send about N words to <provider>?"
   - The tutor otherwise reads chapter by chapter through tools. Tool reads stay within what the writer attached, or the current chapter if nothing is attached, and widen only after the writer approves an in-chat prompt ("The tutor wants to read Chapter 5. Allow?").
9. **Custom endpoints:**
   - The user may enter any http or https URL.
   - Plain `http` to a non-loopback address shows a warning that the manuscript will travel unencrypted to that host, and needs confirmation.
   - The Rust allowlist is exactly the saved host for that connection.
10. **History:**
    - Keyed by the project's `meta.id`, so renaming or moving the project folder doesn't lose it.
    - Messages are stored as sent, attached text included, so a chat can be resumed. This is said plainly on the settings page.
    - History is kept until the user clears it (a single chat, a project, or all), and is not encrypted, like the project files.
    - Deleting a project in the app offers to clear its history.

## Left to the builder

- The exact guard thresholds, the Harper integration details, the OAuth redirect mechanics, the panel styling within the design tokens, and the first drafts of the prompt files.
- **Sign in with ChatGPT registration:** if OpenAI's participating-app program cannot register an open-source desktop app, ship the other connections. Record a decision and keep the adapter slot.
