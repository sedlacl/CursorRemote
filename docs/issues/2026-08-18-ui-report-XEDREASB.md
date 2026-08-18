# Po načtení historie se subagent notifikace změní v bubliny You

- Status: fixed (0.3.11) — `storedBubbleToChatElement` maps type=1 `<system_notification>` / `kind: subagent` to `thought` with id `transcript:notification:<uuid>` so `load_history` merge no longer creates You XML bubbles.
- Date: 2026-08-18
- Diagnostic ID: JYF35XMB
- Issue ID: XEDREASB
- Captured at: 2026-08-18T11:21:34.450Z
- Client URL: http://localhost:3001/
- User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
- Viewport: 2340×910
- Report: `R:\External\cursor-ide-remote\docs\issues\.artifacts\XEDREASB`
- Area: extractor | relay

## User note

Po nacteni historie se úplně změní vizuál - zřejmě problém se subagenty.

## Symptom

Po `load_history` (scroll nahoru / Loading older messages) se webový přepis přestane podobat živému Cursor chatu. Místo kompaktních řádků **Finished … scenario** se objeví velké bubliny **You** s raw XML (`<system_notification>`, `kind: subagent`, cesty k `subagents/*.jsonl`). Uživatel to správně spojuje se subagenty — jde o completion notifikace multitask workerů, ne o živý subagent tray (`subagents.items` je prázdné).

## Repro

1. Otevřít orchestrátor chat s dokončenými Multitask subagenty (tady composer `968cc181-fe1d-40c3-ab15-7f443515cdc0`, mode `multitask`).
2. Ve web UI scrollovat k vrchu transcriptu, až doběhne `command:load_history` (storage cesta).
3. Porovnat nové „You“ bubliny s tím, co Cursor ukazuje jako `data-react-transcript-row-kind="notification"`.

Observed in session JYF35XMB (issue XEDREASB).

## Evidence

- state (`R:\External\cursor-ide-remote\docs\issues\.artifacts\XEDREASB\state.json`): `connected: true`, `agentStatus: idle`, `messageCount: 93`, `mode: multitask`, `subagents.runningCount: 0`, `items: []`. Live Cursor chat DOM má jen **19** message rows (9 assistant / 7 human / 2 thinking / 1 tool) — rozdíl jsou storage-only bubliny po merge.
- Web DOM (93× `.chat-el`, skoro všechny UUID bubble id): **5** extra `el-human` s labelem You, text začíná `<timestamp>…<system_notification>` a obsahuje `kind: subagent` / `status: success` / `task_id`. Příklad `71b05679-37c9-4f2a-9846-3507c3620a5b`: **3144** znaků raw XML vs. v Cursoru viditelný titulek `Finished Implement deleteSubjects scenario`.
- Cursor chat DOM: stejné bubble id mají `data-find-row-key="notification:<uuid>"` a `data-react-transcript-row-kind="notification"` (někdy `notification:group:id1+id2`). Raw `system_notification` v Cursor HTML **není**. Live extraktor je bere jako `thought` (`roleless:notification`) s id `transcript:notification:…`.
- Web screenshot vypadá jako prázdný střed; v DOM zprávy jsou — po historii přibudou stěny escaped XML a scroll skočí do cizího vizuálu. Cursor screenshot dál ukazuje normální plan/chat.
- Vedlejší šum v tomtéž snapshotu: `chatTabs` má 3× `isActive: true` a spoustu `tab-N` z agent sidebar/history (web: 14 tabů, 2× `.active`). To mění chrome, ale nesedí na user note o subagentech.

## Likely cause

`command:load_history` v `src/server/relay.ts` nejdřív volá `CursorStorageHistory.loadComposerHistory`. `storedBubbleToChatElement` (`src/server/cursor-storage-history.ts`) mapuje **každé** `header.type === 1 || bubble.type === 1` na `type: 'human'` s raw `bubble.text`.

Cursor ale type=1 používá i pro syntetické subagent-completion bubliny. V živém DOM to nejsou human rows — jsou to `notification` rows, které `dom-extractor.ts` (~1171–1201) už umí jako kompaktní `thought`.

Merge v `mergeMessages` je nesloučí: storage id = raw UUID, live id = `transcript:notification:<uuid>`. Po historii proto přibudou duplicitní You bubliny a vizuál se „úplně změní“.

Hypotéza k vyvrácení: pokud by `load_history` šel jen scroll fallbackem (bez storage), You XML by se nemělo objevit — live extraktor notifikace jako human neexportuje.

## Suggested fix (not applied)

V `storedBubbleToChatElement` type=1 s `<system_notification>` / `kind: subagent` nebrat jako `human` — přeskočit, nebo namapovat na `thought` (titulek jako v Cursoru) se stejným id jako live extraktor (`transcript:notification:<bubbleId>`), ať merge nedělá duplicity.

## Out of scope / follow-ups

- Flicker plan chevronu (`2026-08-18-plan-todo-expand-flicker.md`) je jiné, už fixed.
- Extra history taby / víc `isActive` v `chatTabs` — samostatný extractor bug, ne tenhle report.
- Nepojmenované storage tool řádky (`Tool call 41/42/48`) — `formatToolAction` nezná Task tool kódy; neřešit v tomto issue.
- Raw HTML/PNG zůstávají pod `.artifacts/` (gitignored). `temp/ui-reports/` prázdné, nemazat.
