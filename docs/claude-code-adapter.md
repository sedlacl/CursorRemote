# Claude Code adapter

CursorRemote drives two IDE agents through one socket contract and one phone UI:
the Cursor composer and the `anthropic.claude-code` webview panel. Claude
sessions appear as extra chips in the existing tab bar — there is no
"Cursor / Claude" switcher.

## 1. The adapter seam

Everything chat-shaped goes through `ChatHost` ([src/server/hosts/chat-host.ts](../src/server/hosts/chat-host.ts)),
and `ChatHostRegistry` ([chat-host-registry.ts](../src/server/hosts/chat-host-registry.ts))
decides which host a command or a published state belongs to:

```
  client ──command {activeHost}──→ relay.runOnHost()
                                     │ 1. stamp == active host?   else refuse
                                     │ 2. host.capabilities[cap]? else unsupported
                                     ▼
                           ┌────────────────────┐
  extractor tick ────────→ │ ChatHostRegistry   │ ──composeState()──→ state:patch
                           └─────────┬──────────┘
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
      ┌───────────────┐     ┌──────────────────┐    ┌──────────────┐
      │  CursorHost   │     │ ClaudeCodeHost   │    │ (next host,  │
      │  primary      │     │ CDP webview +    │    │  e.g. Codex) │
      │  DOM extractor│     │ VS Code commands │    │              │
      └───────────────┘     └──────────────────┘    └──────────────┘
```

Three rules keep backends from bleeding into each other:

1. **One active host, one conversation.** The registry records the host of the
   tab the user last switched to. `composeState()` publishes `activeHost` and
   `hostCapabilities`, and every conversation-scoped field (`messages`, `mode`,
   `model`, stop, approvals, questionnaire, queue, subagents, …; see
   `ConversationStateKey`) describes that host only. The primary host (Cursor)
   is native to the extraction and publishes no view. Any other host starts
   from `neutralConversationState()` and overlays its own
   `conversationView()`, so none of Cursor's fields survive on its tab.
2. **Every chat command goes through `runOnHost()`.** The relay resolves the
   host (by the target tab for `switch_tab` / `close_tab`, else the active
   host), checks the capability and calls the host method. It never calls a
   backend executor for a chat command and never branches on a host id.
   Cursor-only details live in `CursorHost`: approval selectors from the
   extracted registry, and history paging from the storage DB.
3. **Commands carry the host they were issued from.** The web client stamps
   every command with `activeHost`. When that no longer matches the server's
   active host, for example because the tab changed between the tap and the
   delivery, the relay refuses the command instead of running it on the other
   backend.

The client hides controls the active host lacks: the mode pill without
`setMode`, and the model sheet without `setModel`
([hostCapabilities.ts](../src/client/view-models/hostCapabilities.ts)).

Workflows built on the primary host's extracted state are subagents,
return-to-parent and transcript links. They run only while a primary-host tab
is active (`refuseUnlessPrimary`). `navigate_to_approval` and `return_to_parent`
land on a Cursor tab, so they make Cursor the active host again.

`ChatTab.host` is optional and absent means the primary host. Tabs extracted
before this feature existed keep routing exactly as before.

### Routing table

| Command | Capability | Cursor | Claude Code |
| --- | --- | --- | --- |
| `send_message` | `sendMessage` | composer CDP | `Input.insertText` + Enter into the webview contenteditable |
| `new_chat` | `newChat` | composer CDP new chat | `claude-vscode.newConversation` |
| `switch_tab` | `switchTab` | `switchTab` | `claude-vscode.editor.open(sessionId)` |
| `close_tab` | `closeTab` | editor tab close | — (unsupported) |
| `approve` / `reject` | `chatApproval` | selector from the approval registry | click the live permission control in the webview DOM |
| `approve_all` | `approveAll` | composer CDP | — |
| `stop_agent` | `stopTurn` | stop selector from extracted state | `session.interrupt()` behind the visible Stop |
| `set_mode` | `setMode` | mode picker | — (menu not probed) |
| `set_model`, `get_model_options` | `setModel` | model picker | — (menu not probed) |
| `get_plan_model_options`, `set_plan_model` | `planModel` | plan widget picker | — |
| `click_action` | `clickAction` | selector path from state | — |
| `load_history` | `loadHistory` | storage DB, then scroll | — |
| accept / reject diff | `editorDiff` | in-transcript | `claude-vscode.acceptProposedDiff` / `rejectProposedDiff` |

### Adding a backend (e.g. Codex)

1. Add the id to `ChatHostId` ([types.ts](../src/server/types.ts)) and `CHAT_HOST_IDS`.
2. Implement `ChatHost`, usually by extending `BaseChatHost`. Declare
   capabilities fail-closed, implement only probed operations, return the
   tabs from `listTabs()` and the active tab's state from
   `conversationView()`, and poll in `refresh()`.
3. `hostRegistry.register(new CodexHost(...))` in [index.ts](../src/server/index.ts).

The relay, the registry and the client need no changes. The tab chip and the
header tint read `tab.host` / `activeHost`.

## 2. Two control surfaces, and why both

Claude Code's public VS Code commands open, focus and rename sessions and
accept or reject proposed diffs — but **none of them sends a follow-up message**
into an open session. The documented URI handler
(`vscode://anthropic.claude-code/open?session=…&prompt=…`) only prefills the
prompt. The private host↔webview `postMessage` protocol (`activate_session`,
`focus_input`, `interrupt`, `tool_permission_response`) is unusable from here,
because only a webview's owner may post to it.

So: commands for chrome, CDP for everything inside the panel.

Command execution runs over a request/result file handshake
([src/shared/vscode-command-bridge.ts](../src/shared/vscode-command-bridge.ts)),
the same pattern the git bridge uses, because the relay process has no VS Code
API. The command id allowlist is enforced on **both** sides — the handshake is
deliberately not a general "run any command in the IDE" channel.

## 3. Finding the webview, and getting into it

Two facts, both established by the probe against 2.1.278, decide the whole
design ([claude-webview-client.ts](../src/server/hosts/claude-webview-client.ts)):

**Targets are identified by URL.** Every Claude webview CDP target carries
`extensionId=Anthropic.claude-code` in its query string. No DOM fingerprinting
is needed — and fingerprinting would have been wrong anyway, because the strings
one might guess at (`claudeVSCodePanel`, `claude-vscode`) do not appear in the
target's document. `purpose` is deliberately **not** filtered: Claude Code runs
both as a side panel (`purpose=webviewView`) and as a full editor tab in the
main window, and both must be found.

**The real DOM is one frame down.** The target's own document is only VS Code's
webview shell, about 42 KB of boilerplate identical across every extension. The
Claude UI lives in a nested same-origin iframe, `#active-frame`, so every read
and write goes through its `contentDocument`. Querying the outer document finds
nothing at all — which is exactly how the first probe run produced a false
negative.

Claude Code renders two surfaces this way, told apart by content:

| Surface | Marker | Used for |
| --- | --- | --- |
| chat | `[role="textbox"][aria-label="Message input"]` | send, stop, approvals |
| session list | `[id^="sessions-list-row-<uuid>"]` | the tab list, with real session ids |

The host holds a connection to each: commands go to the chat view, while the
session list is what enumerates every session with the id that
`claude-vscode.editor.open` accepts.

### Verified selectors (2.1.278)

All `role` / `aria-label`, never the generated CSS module classes beside them
(`messageInput_cKsPxg`, `sessionItem_OOQiHg`), which change on every bump:

| Control | Selector |
| --- | --- |
| Message input | `[role="textbox"][aria-label="Message input"]`, `contenteditable="plaintext-only"` |
| Send | `[aria-label="Send message"]` |
| New session | `[aria-label="New session"]` |
| Session history | `[aria-label="Session history"]` |
| Model picker | `[aria-label="Switch model"]` |
| Session row | `[id^="sessions-list-row-"]` |

The chat header is one row: session title, then `Session history` and
`New session`. The title is read by anchoring on `New session` and taking the
non-chrome control at the same `y` — a y-range alone is not enough, because
transcript buttons scroll through any band of the viewport.

**Tab ids carry an explicit prefix**, `claude:session:<uuid>` or
`claude:panel:<webviewName>`. Both values are UUIDs, so only the prefix can tell
them apart; passing a webview id to `editor.open` would open the wrong session.

Discovery sweeps CDP targets, so while no Claude panel is open it is throttled
to once every 15 s rather than running on each extractor tick.

## 4. Background tasks: the Map, never `/tasks`

Claude Code's only built-in task list is the `/tasks` slash command. It is
`local-jsx` and opens a window in the user's IDE the moment it runs, **so the
relay never sends it** — not as a fallback, not for a one-off refresh.

The intended source was the webview session's `backgroundTasks` field, read
under a fail-closed contract
([claude-background-tasks.ts](../src/server/hosts/claude-background-tasks.ts)):

1. The locator is **named and asserted** — an object owning both a string
   `sessionId` and an own `backgroundTasks` that is a `Map` or plain object. No
   "this fiber node looks like a session" guessing.
2. Entry values are read against an explicit schema; only documented keys are
   read.
3. Property missing, wrong type, entries failing the schema, or an unverified
   Claude Code version → `[]` plus a one-shot log. No silent fallback to
   `/tasks` or to scraping the transcript.
4. Rows get no stop control until a probe confirms a real stop path. A read-only
   list beats a kill button that does nothing.
5. **Every Claude Code version bump requires a fresh probe.** `VERIFIED_VERSIONS`
   is the only gate that opens the reader, and it starts empty.

### Probe result on 2.1.278: the reader is closed

It is not readable. A sweep of 7257 fiber nodes across every Claude webview
target found **no** object owning a `backgroundTasks` property and **no** object
carrying a `sessionId` string at all. The session state lives in the extension
host process (`extension.js`), which is Node rather than a renderer, so CDP
cannot reach it from the relay. The plan assumed otherwise.

So the reader reports no background tasks on 2.1.278, and `VERIFIED_VERSIONS`
stays empty. The code is kept rather than deleted because it encodes the
contract a future build would have to satisfy: if a later version does expose
the session in the webview, a fresh probe plus one `VERIFIED_VERSIONS` entry
opens it. Until then the Running tasks subview simply never appears.

`Running tasks` is a persistent subview on Claude tabs only
([ClaudeRunningTasks.tsx](../src/client/components/shell/ClaudeRunningTasks.tsx)).
It updates through the existing extractor tick → `state:patch`, with no extra
poller, and collapses when empty. Cursor tabs keep their own composer badge and
sheet; the two are not mixed.

## 5. Probing before parsing

`scripts/probe-claude-code.ts` is read-only reconnaissance against a live Cursor
with the Claude panel open. It never types, clicks, sends or runs a slash
command, and it dumps DOM plus screenshots into gitignored `temp/`.

```bash
npm run claude:probe       # what the DOM actually contains
```

Run it whenever the Claude Code extension version changes, then update
`VERIFIED_VERSIONS` if — and only if — the value schema still matches.

### Verifying the host end to end

`scripts/verify-claude-host.ts` drives the real `ClaudeCodeHost` against the
running IDE. It is read-only unless a flag says otherwise, because every action
it can take is irreversible — `--send` posts a real message into a real session.

```bash
npm run claude:verify                          # connection, tabs, controls, background tasks
npm run claude:verify -- --send "ping"         # sends for real
npm run claude:verify -- --new-chat
npm run claude:verify -- --switch 1            # tab index from the listing
npm run claude:verify -- --stop
npm run claude:verify -- --approve             # or --reject, while a prompt is pending
```

Anything routed through the extension command bridge (`--new-chat`, `--switch`,
the diff actions) needs the CursorRemote extension running **this** build, via
F5 "CursorRemote: Extension Dev Host". Without it those calls time out after 8 s
and the script says why.

Useful states to test in, because some controls only exist transiently:

| To exercise | Put the session in this state |
| --- | --- |
| Stop | mid-turn — Stop replaces Send in the prompt box |
| approve / reject | a tool permission prompt pending in the transcript |
| multi-tab switching | open the session list so every session gets a real id |
| both host surfaces | one Cursor chat and one Claude session open at once |

## 6. Out of scope

- **MCP WebSocket** (`x-claude-code-ide-authorization`) — IDE tools for the CLI
  (diagnostics, open file), not chat control.
- **JSONL in `~/.claude/projects/`** — session history, not a live session.
- **Anthropic Remote Control** (`/remote-control` → `claude.ai/code`) —
  Anthropic's own phone UI for Claude Code. It is a finished alternative to this
  feature, but a different product: it routes through Anthropic rather than a
  local relay. Nothing here interacts with it.
- **Telegram** — the Claude host is not wired into the Telegram transport.
