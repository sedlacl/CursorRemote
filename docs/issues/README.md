# CursorRemote issues

Zachycené bugy z diagnostiky (Diagnostic ID / Capture UI report & issue).

Agent je sem zapisuje přes skill `remote-cursor`, nebo je vytvoří přímo web UI tlačítkem
**Capture UI report & issue**. Z těchto souborů se později dělá plán opravy — samotný zápis
issue **není** commit ani implementace.

Standardní postup oprav (triage → fix → changelog → smazat vyřešené): `.cursor/rules/issue-workflow.mdc`.

## Formát souboru

- Manuální / agent issue: `YYYY-MM-DD-<slug>.md`
- Automatický UI report: `YYYY-MM-DD-ui-report-<issueId>.md`

## Kde reporty hledat (dvě místa!)

`Capture UI report & issue` zapisuje relativně k **`packageRoot` běžícího relay**
(`resolvePackageRoot()` v `src/server/relay.ts`), ne do tohoto repa. Podle toho, odkud relay běží:

| Relay běží z | Kam se report zapíše |
| --- | --- |
| `npm run dev` v repu | `R:\External\cursor-ide-remote\docs\issues\` (tato složka) |
| **instalované extension (VSIX)** | `%USERPROFILE%\.cursor\extensions\qjohn.cursor-remote-<verze>-universal\docs\issues\` |

Uživatel běžně používá instalovanou extension, takže **většina reportů je mimo repo** a
`git status` je nikdy neukáže. Při triage projdi **obě** cesty:

```powershell
Get-ChildItem "R:\External\cursor-ide-remote\docs\issues" -Force -Recurse
Get-ChildItem "$env:USERPROFILE\.cursor\extensions\qjohn.cursor-remote-*\docs\issues" -Force -Recurse
```

Port relay z logu (`port: 3000` u extension, `3001`/`4174` u dev) pomůže poznat, která
instance report psala. Extension složka se **přepíše při update VSIX** — reporty, které chceš
podržet, přenes do repa (markdown do `docs/issues/`, artefakty do `.artifacts/<issueId>/`).

## Artefakty

Raw citlivé soubory (web/Cursor DOM, PNG, state) patří do:

```
docs/issues/.artifacts/<issueId>/
```

Tato složka je **gitignored**. Markdown issue zůstává tracked a odkazuje absolutními cestami
na artefakty — neinlineuje raw HTML/PNG.

## Stav (2026-09-09)

Hotové issues se **mažou** po shipped fixu (viz `.cursor/rules/issue-workflow.mdc`). Fix zůstává v kódu a changelogu.

Otevřené (všechny v extension složce `qjohn.cursor-remote-0.3.11-universal\docs\issues\`, Diagnostic ID `SVVAAMW1`):

| Issue | Datum | User note | Stav triage |
| --- | --- | --- | --- |
| `1KFD3BNZ` | 2026-08-19 | „Porad je to prazdne" (`messageCount: 0` při `agentStatus: generating`) | nezanalyzováno — možná regrese po 0.3.11 |
| `GFQ2EFYD` | 2026-08-25 | „Nejde prepnout na subagenta" (multitask, 1 běžící subagent) | nezanalyzováno |
| `CZY6CSAJ` | 2026-09-08 | „Aproval v headingu nenachazi tab" | nezanalyzováno |
| `2T968PXZ` | 2026-09-09 | „Asi bych schoval ten panel review" (git review bar zabírá místo) | feature request, duplicita s `4J3JAR1R` |
| `4J3JAR1R` | 2026-09-09 | „Schovej review panel" | duplicita s `2T968PXZ` |

Smazáno 2026-08-18 (opraveno v 0.3.11): `2026-08-18-ui-report-P25A5TE8.md` (+ `.artifacts/P25A5TE8/`; stejný bug `43ARKA9X`, `3CGQJ73B`) — prázdný chat než Cursor hydratuje transcript.
Smazáno 2026-08-18 (opraveno v 0.3.11): `2026-08-18-ui-report-XEDREASB.md` (+ `.artifacts/XEDREASB/`) — storage type=1 subagent notifikace → thought (`transcript:notification:<id>`).
Smazáno 2026-08-18 (CI-only): `2026-08-07-gha-node20-deprecation.md` — `actions/checkout@v7`, `actions/setup-node@v7`.
Smazáno 2026-08-18 (opraveno v 0.3.11): `2026-08-18-plan-todo-expand-flicker.md` (+ dump `temp/diag-usy-aflex-initdatag01/`).

Smazáno 2026-08-06 (opraveno v 0.3.7): `2026-08-06-approval-card-shows-allow-as-command`,
`2026-08-06-model-sheet-shows-effort-settings`. Smazáno jako non-actionable (prázdný New Agent,
stav odpovídal realitě): `2026-08-06-ui-report-A1F9WNN6`, `2026-08-06-ui-report-MXC31Z53`.

Smazáno dříve: `2026-08-02-background-jobs-sheet-summary-only`, `2026-08-01-git-review-branch-and-file-content`,
`2026-08-01-subagent-list-open-stop`, `2026-07-31-human-message-image-indicator`,
`2026-08-01-skill-selection-own-ui`.
