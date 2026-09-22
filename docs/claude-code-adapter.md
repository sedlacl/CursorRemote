# Claude Code adapter

CursorRemote drives two IDE agents through one socket contract and one phone UI:
the Cursor composer and the `anthropic.claude-code` webview panel. Claude
sessions appear as extra chips in the existing tab bar — there is no
"Cursor / Claude" switcher.

## 1. The adapter seam

Everything chat-shaped goes through `ChatHost` ([src/server/hosts/chat-host.ts](../src/server/hosts/chat-host.ts)):

```
                 ┌────────────────────┐
  relay ────────→│ ChatHostRegistry   │  routes by tab.host
                 └─────────┬──────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
      ┌───────────────┐        ┌──────────────────┐
      │  CursorHost   │        │ ClaudeCodeHost   │
      │ CDP workbench │        │ CDP webview +    │
      │ DOM extractor │        │ VS Code commands │
      └───────────────┘        └──────────────────┘
```

- `CursorHost` is pure delegation to today's `CommandExecutor` and DOM
  extractor — behaviour is unchanged.
- `ClaudeCodeHost` holds a **second** `CdpClient` on the Claude webview target
  and calls whitelisted `claude-vscode.*` commands through the extension.
- The relay never branches on a host id. It asks the registry for the host that
  owns the target tab (`switch_tab`, `send_message`) or the active tab
  (`new_chat`, `stop`), and `BaseChatHost` turns anything a host cannot do into
  an ordinary command error instead of an exception.

`ChatTab.host` is optional and absent means `cursor`, so tabs extracted before
this feature existed keep routing exactly as before.

### Routing table

| Command | Cursor | Claude Code |
| --- | --- | --- |
| `send_message` | composer CDP (unchanged) | `Input.insertText` + Enter into the webview contenteditable |
| `new_chat` | composer CDP new chat | `claude-vscode.newConversation` |
| `switch_tab` | `switchTab` (unchanged) | `claude-vscode.editor.open(sessionId)` |
| `approve` / `reject` | selector path from the approval registry | click the live permission control in the webview DOM |
| `stop` | stop selector from extracted state | visible Stop in the prompt box |
| accept / reject diff | in-transcript (unchanged) | `claude-vscode.acceptProposedDiff` / `rejectProposedDiff` |

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
npx tsx scripts/probe-claude-code.ts            # probe the Claude webview
npx tsx scripts/probe-claude-code.ts --all-webviews   # dump every webview
```

Run it whenever the Claude Code extension version changes, then update
`VERIFIED_VERSIONS` if — and only if — the value schema still matches.

## 6. Out of scope

- **MCP WebSocket** (`x-claude-code-ide-authorization`) — IDE tools for the CLI
  (diagnostics, open file), not chat control.
- **JSONL in `~/.claude/projects/`** — session history, not a live session.
- **Anthropic Remote Control** (`/remote-control` → `claude.ai/code`) —
  Anthropic's own phone UI for Claude Code. It is a finished alternative to this
  feature, but a different product: it routes through Anthropic rather than a
  local relay. Nothing here interacts with it.
- **Telegram** — the Claude host is not wired into the Telegram transport.
