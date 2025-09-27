# pr-size-guard

A GitHub Action that guards pull request size and nudges teams to include tests.

## What it does

1. Reads changed files in the pull request using the GitHub REST API.
2. Calculates total changed lines and file count, with pagination for large PRs.
3. Checks whether any test folders are touched.
4. Posts a comment on the PR. Warns or fails based on `mode`.
5. Optional repo config via `.pr_guard.yml`.

## Inputs

- `max_lines` default `400`
- `max_files` default `25`
- `test_paths` default `test,tests,__tests__`
- `exclude` default empty. Comma separated globs, for example `**/package-lock.json,**/*.min.js`
- `mode` `warn` or `fail`, default `warn`
- `retries` default `2` (retries on HTTP 429 and 5xx)

## Optional repo config

Create a `.pr_guard.yml` in the repository root to override defaults.

```yaml
max_lines: 400
max_files: 25
test_paths:
  - tests
  - __tests__
exclude:
  - "**/package-lock.json"
  - "**/*.min.js"
mode: warn
retries: 2
```
