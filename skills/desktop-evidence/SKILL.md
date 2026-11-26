---
name: desktop-evidence
description: "Judge what a desktop-automation result, test, probe or dogfood run actually proves before reporting it done: delivery versus verification, complete evidence for absence, target and frame identity, and vacuous or destructive test runs. Use when reviewing or reporting computer-use, agent-desktop, UI Automation or accessibility results and harness output."
version: "0.1.0"
---

# Desktop evidence

This skill should be used when reviewing or reporting the result of a
desktop action, a desktop test suite, a probe or a dogfood run, or when
comparing a native desktop backend with the computer-use tool your agent
already uses.

It is a review checklist. It adds no driver and changes no tool contract.
The permission, foreground, stop/resume and user-intervention rules of that
computer-use tool or skill stay authoritative.

## Before you call it done

1. Name what was sent and what was observed. "Sent", "sent but unverified",
   "uncertain" and "observed" are different results. A success flag, an input
   API's return count or a launcher exit code is not an observed effect.
2. Re-read the target independently: the element's own state, the window's
   own text, a pixel, a token. Prefer a reader that does not share the code
   path that acted.
3. For "it is gone", require a complete, target-bound observation. A partial
   scan, a recycled handle or a lower count after a bounded read is not
   removal.
4. For a test or probe run, check that it could have failed. A skipped leg,
   a `measurable: false` record, a placeholder, an empty result, a constant
   written into a record, or a comparison across a change that never
   happened is not evidence.
5. Every negative needs a control that is known to fire on the same host.
6. A denial is a stop. Do not route it through another backend, path or
   fallback.

## Before you run a desktop test on a shared machine

Refuse or move to a disposable host any run that kills processes by image
name, clears the clipboard or notification list, types into the first
window of an app name, or posts global input without checking the
foreground. Target only windows the run launched, by process and handle.

## Detail

Read [native desktop evidence](references/native-desktop-evidence.md) for
the full contract comparison, failure-delivery rules, identity and frame
rules, privacy and resource-ownership rules, and the test-evidence section.

## Source

Independently written from the static review of
[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)
(Apache-2.0) at `6660fbac768dc7e7332837b90ed465684859afa3` (macOS and
Windows adapters, the Windows probes, their ledger and the dogfood runners).
No upstream code is included. Nothing was executed. Thanks to the
agent-desktop authors: their probes and adapters are where these rules came
from.
