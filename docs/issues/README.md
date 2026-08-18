# CursorRemote issues

Zachycené bugy z diagnostiky (Diagnostic ID / Capture UI report & issue).

Agent je sem zapisuje přes skill `remote-cursor`, nebo je vytvoří přímo web UI tlačítkem
**Capture UI report & issue**. Z těchto souborů se později dělá plán opravy — samotný zápis
issue **není** commit ani implementace.

Standardní postup oprav (triage → fix → changelog → smazat vyřešené): `.cursor/rules/issue-workflow.mdc`.

## Formát souboru

- Manuální / agent issue: `YYYY-MM-DD-<slug>.md`
- Automatický UI report: `YYYY-MM-DD-ui-report-<issueId>.md`

## Artefakty

Raw citlivé soubory (web/Cursor DOM, PNG, state) patří do:

```
docs/issues/.artifacts/<issueId>/
```

Tato složka je **gitignored**. Markdown issue zůstává tracked a odkazuje absolutními cestami
na artefakty — neinlineuje raw HTML/PNG.

## Stav (2026-08-18)

Hotové issues se **mažou** po shipped fixu (viz `.cursor/rules/issue-workflow.mdc`). Fix zůstává v kódu a changelogu.

Otevřené: žádné.

Smazáno 2026-08-18 (opraveno v 0.3.11): `2026-08-18-ui-report-XEDREASB.md` (+ `.artifacts/XEDREASB/`) — storage type=1 subagent notifikace → thought (`transcript:notification:<id>`).
Smazáno 2026-08-18 (CI-only): `2026-08-07-gha-node20-deprecation.md` — `actions/checkout@v7`, `actions/setup-node@v7`.
Smazáno 2026-08-18 (opraveno v 0.3.11): `2026-08-18-plan-todo-expand-flicker.md` (+ dump `temp/diag-usy-aflex-initdatag01/`).

Smazáno 2026-08-06 (opraveno v 0.3.7): `2026-08-06-approval-card-shows-allow-as-command`,
`2026-08-06-model-sheet-shows-effort-settings`. Smazáno jako non-actionable (prázdný New Agent,
stav odpovídal realitě): `2026-08-06-ui-report-A1F9WNN6`, `2026-08-06-ui-report-MXC31Z53`.

Smazáno dříve: `2026-08-02-background-jobs-sheet-summary-only`, `2026-08-01-git-review-branch-and-file-content`,
`2026-08-01-subagent-list-open-stop`, `2026-07-31-human-message-image-indicator`,
`2026-08-01-skill-selection-own-ui`.
