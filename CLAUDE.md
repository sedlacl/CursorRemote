# CursorRemote — instrukce pro Claude Code

Pravidla projektu jsou kanonicky v `.cursor/rules/*.mdc` (čte je Cursor). Tento soubor je
jen importuje nebo odkazuje, jejich obsah sem neduplikuj.

## Vždy platná pravidla

@.cursor/rules/changelog.mdc
@.cursor/rules/dev-workflow.mdc
@.cursor/rules/testing.mdc

## Podmíněná pravidla (načti soubor, až když nastane situace)

- Cursor DOM: chat záložky, sidebar agenti, stav práce, přepínání/zavírání
  (`src/server/dom-extractor.ts`, `src/server/command-executor.ts`, `src/server/types.ts`,
  `src/client/app.js`, `selectors.json`) → `.cursor/rules/cursor-chat-tabs.mdc`
- Práce v `docs/issues/**`: triage, fix, changelog, mazání hotových → `.cursor/rules/issue-workflow.mdc`
- Parsování Cursor DOM: nejdřív probe živého stavu přes CDP
  (`src/server/dom-extractor.ts`, `src/server/command-executor.ts`, `selectors.json`,
  `scripts/probe*.ts`) → `.cursor/rules/probe-before-parsing.mdc`
- Web klient `src/client/**`: formátování, styly, minimální diff → `.cursor/rules/web-client.mdc`
