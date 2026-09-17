# CDP restart loops and never relaunches Cursor

- Status: open
- Date: 2026-09-17
- Diagnostic ID: —
- Report: installed extension `qjohn.cursor-remote-0.4.2-universal`
- Area: command-executor

## Symptom

After requesting a Cursor restart with CDP once, the installed extension keeps closing Cursor on subsequent manual launches without a new confirmation. The requested restart also does not bring Cursor back up successfully.

## Repro

1. Run the installed CursorRemote 0.4.2 extension with CDP unavailable.
2. From the web client, request **Restart Cursor with CDP** and accept the confirmation.
3. Cursor exits but is not relaunched.
4. Start Cursor manually.
5. The extension reads the previous persistent request again and quits Cursor again.

## Evidence

- Installed package: `C:\Users\LukasSedlacek\.cursor\extensions\qjohn.cursor-remote-0.4.2-universal` (`package.json` version `0.4.2`). The repository is currently at `0.4.3`, but the affected restart implementation is unchanged.
- Persistent request: `C:\Users\LukasSedlacek\AppData\Roaming\Cursor\User\globalStorage\qjohn.cursor-remote\cursor-restart-request.json` remained present after processing, with request ID `542c13a465c512a2` and timestamp `2026-09-17T20:14:53.038+02:00`.
- Persistent result: `C:\Users\LukasSedlacek\AppData\Roaming\Cursor\User\globalStorage\qjohn.cursor-remote\cursor-restart-result.json` reports `ok: true` for the same request ID and was rewritten at `2026-09-17T20:16:16.217+02:00`, over a minute after the original request. This is consistent with the stale request being handled again after another extension activation.
- Relaunch log: `C:\Users\LukasSedlacek\AppData\Roaming\Cursor\User\globalStorage\qjohn.cursor-remote\cursor-cdp-relaunch.log` contains only `scheduled relaunch` at `2026-09-17T20:16:16.195+02:00`. It never reaches the helper's first expected `launcher start` entry.
- `extension/src/cursor-cdp-restart.ts:176` launches the helper as `spawn(process.execPath, [scriptPath, configPath], ...)`. Under Node/Electron Node mode, `process.argv[1]` is therefore `scriptPath` and the configuration is `process.argv[2]`.
- The generated helper nevertheless parses `process.argv[1]` as JSON at `extension/src/cursor-cdp-restart.ts:22`. It attempts to parse its own JavaScript source, throws before the async body and before logging `launcher start`, while the parent has already accepted the child `spawn` event as success.
- `extension/src/git-state-bridge.ts:48` tracks `lastRestartRequestId` only in memory. `start()` and every health update call `handleCursorRestartRequest()` (`:108`, `:184`), so a fresh extension host starts with an empty ID and reprocesses the request still on disk.
- `extension/src/git-state-bridge.ts:441-450` writes an `ok: true` result and schedules `workbench.action.quit`, but does not remove or otherwise durably consume the request.
- `src/server/extension-file-bridge.ts:85-99` writes the request and waits for a matching result, but likewise never removes the request/result pair.
- The client confirmation guard exists in both UI entry points and the HTTP endpoint also requires `confirm: true`; the observed restarts without a fresh choice happen after the initial accepted request, during later extension activations.
- Existing tests cover argument JSON manipulation and executable/workspace resolution, but there is no smoke test that executes the generated helper and no restart-request idempotency test across extension-host re-instantiation.

## Likely cause

There are two independent defects in the restart handshake:

1. **Wrong helper argument index.** The detached helper reads `process.argv[1]`, which is the helper script path, instead of `process.argv[2]`, which is the relaunch configuration. It exits immediately, so Cursor is quit but never relaunched.
2. **Restart requests are not durably idempotent.** The request file survives successful processing while the only deduplication state is an in-memory field. Every new extension host therefore treats the old request as new, creates another broken helper, reports success, and quits again.

The result file's `ok: true` currently means only that the helper process emitted `spawn`; it does not mean that the helper parsed its configuration or relaunched Cursor.

## Suggested fix (not applied)

- Read the relaunch config from `process.argv[2]`, or pass the config path through an explicit named environment variable/argument whose parsing is unit-tested.
- Make restart request consumption durable. At minimum, ignore a request when the persisted result already has the same `requestId`; preferably atomically claim/remove the request before scheduling quit and retain the matching result as the idempotency record.
- Do not report success solely on the helper process `spawn` event. Have the helper write a small readiness/accepted marker after it has parsed the config, or keep a pipe open until that point, before the extension writes `ok: true` and quits Cursor.
- Add an integration smoke test that runs the generated helper with a temporary config and harmless fake executable, asserting `launcher start` and a single spawn.
- Add a bridge lifecycle test that instantiates the handler twice over the same request/result directory and asserts that the second instance does not process an already completed request.

## Out of scope / follow-ups

- No source fix or commit was made as part of this diagnosis.
- The current stale request file may be removed as a one-time recovery action, but only on explicit user request because it changes the installed extension's persistent state.
