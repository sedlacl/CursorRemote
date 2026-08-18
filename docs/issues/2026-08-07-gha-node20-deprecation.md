# GitHub Actions Node 20 deprecation on release workflow

- Status: fixed
- Date: 2026-08-07
- Diagnostic ID: —
- Report: —
- Area: other

## Symptom

Successful Release CI for `v0.3.10` (run `31199503293`) printed a GitHub annotation:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: `actions/checkout@v4`, `actions/setup-node@v4`.

The job still completed green (install, tests, VSIX, GitHub Release, Open VSX). This is a forward-looking breakage risk, not a current failure.

## Repro

1. Push a `v*` tag that triggers `.github/workflows/release.yml`.
2. Open the Actions run summary → Annotations on **Build and release VSIX**.

Observed on release of **v0.3.10** (2026-08-07).

## Evidence

- Release workflow now pins:
  - `actions/checkout@v7` (`.github/workflows/release.yml` ~L27)
  - `actions/setup-node@v7` with `node-version: 22` (~L30–33)
- GitHub changelog: [Deprecation of Node 20 on GitHub Actions runners](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)
- Annotation path reported as `.github#2` on the failed-to-upgrade actions (warning only).

## Fixed

Upgraded `actions/checkout` and `actions/setup-node` from `@v4` to their current stable
major `@v7`. Both actions use the Node 24 action runtime, removing the Node 20 deprecation
warning; the project runtime remains Node 22.

## Verification

1. Confirmed `.github/workflows/release.yml` is the only workflow.
2. Confirmed no used workflow action retains a Node 16 or Node 20 runtime reference.
3. A future `workflow_dispatch` or release tag should confirm that GitHub no longer emits the annotation.

## Out of scope / follow-ups

- Not related to the Nexus / `html-to-image` lockfile E401 fix (that was resolved in 0.3.9 / 0.3.10 `.npmrc`).
- No change to app runtime Node version required solely for this warning.
