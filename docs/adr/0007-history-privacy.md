# ADR 0007 — History privacy policy

## Status

Accepted.

## Context

The repository preserves the real commit history of the original private
projects. That is valuable for a portfolio — reviewers can see how the work
evolved — but it also means a secret or a personal path in any old blob is just
as reachable as one in the current tree. An earlier import scrubbed most
credentials and media but missed the owner's Windows profile prefix, and the
final gate caught it.

## Decision

Privacy is enforced over **every reachable commit**, not only `HEAD`:

- Replace personal Windows profile path prefixes with `<WORKSPACE>` and the
  personal domain / preview hosts with `example.local`, in file contents and in
  commit messages, across all branches and preserved history refs.
- Keep original author names and dates; map owner emails to the public GitHub
  noreply address so contributions still count. Never rewrite unrelated
  authorship.
- Remove secrets, credential exports, cookies, `.env` files, production audit
  logs, owner brand media, ripped overlays and blobs over 5 MB from the whole
  history.
- Gate publication on `gitleaks` over all refs, the largest-blob check, an
  identity check, a content deny-list test and a path/domain scan. Re-run the
  gate from a fresh clone before pushing.
- Back up the pre-scrub repository before any authorized rewrite and never
  modify the backup.
- Keep screenshots and video free of personal data: capture only the app
  viewport from a scratch `HOME`, never a desktop or terminal prompt.

## Consequences

- History rewrites are exceptional, authorized operations, not routine fixes.
  A missed pattern requires a new authorization, a new backup and a new gate
  run.
- Commit hashes change during a rewrite; the task log records the mapping of
  old to new hashes for any references.
- The public history remains useful as a portfolio artifact without leaking the
  private deployment, its accounts or its owner's machine layout.
- The policy is repeatable: the same scanners run in the final gate and can be
  re-run by anyone who clones the repository.
