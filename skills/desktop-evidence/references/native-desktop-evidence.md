# Native desktop evidence

Use this reference when comparing a native desktop backend, reviewing a
port, or deciding what an uncertain action result proves. It supplements
the computer-use tool or skill your agent already uses. That tool's
capability discovery, browser routing,
permissions, foreground grant, stop/resume and user-intervention rules
remain authoritative.

This is a review reference. It adds no driver or runtime capability. Obtain
current capability evidence through the existing workflow before claiming
that a feature is available or absent.

## Compare contracts before combining backends

| Concern | Existing computer-use workflow | Reviewed agent-desktop macOS source | Consequence |
|---|---|---|---|
| Element identity | Computer refs have a session/generation lifetime; browser DOM refs belong to their observation cycle. | Saved AX references use remote tokens, process-instance checks and role/native-ID validation. Token support uses private platform symbols. | Keep each backend's identity and lifetime model. Do not translate an opaque token into another backend's ref or silently rediscover an expired target by label. |
| Coordinates | Pointer inputs use the latest full screenshot's pixels for the same target; AX coordinates remain global. | Native AX hit testing and mouse events use desktop coordinates, while capture paths carry display/window geometry and scale. | Bind target, origin, scale and frame generation together. A zoomed image or a stable display ID alone is insufficient. |
| Background input | A typical computer-use contract protects the user's foreground, focus and cursor, with separate restrictions for multi-window keyboard/menu input. | Some macOS routes post to an application PID; native mouse input is global. | An app-targeted event does not itself establish window-targeted background delivery. Preserve the destination tool's stronger restrictions. |
| Permission and stopping | OS permission, task authorization and a foreground grant are separate; stopping and resuming follow the existing user-controlled contract. | The adapter has permission probes, leases, deadlines and cleanup actions. | These mechanisms must not be treated as equivalent to authorization or a stop latch. Cleanup that moves focus, sends Escape or moves the cursor is still input. |

For web content, retain the existing browser workflow and its session
identity. A native accessibility tree does not establish DOM identity,
browser authentication state or permission to borrow a user tab.

## Carry delivery evidence through failures

Distinguish an action that was not sent from one that was sent but not
verified, one with uncertain delivery, and one with an observed result.
These are conceptual outcomes, not new response fields to assume in a tool.

Preserve the strongest delivery evidence when handling a timeout or error.
A deadline expiring after delivery does not make the action unsent. Do not
try another mutating strategy merely because the first result could not be
observed.

Before another action, obtain a fresh, target-correlated observation and
apply the existing workflow's intervention and permission rules. A denied
permission or user refusal must not be worked around with another backend,
tool, path or host.

## Require complete evidence for absence

A bounded or failed accessibility read can omit a window, menu item,
notification or label. An omitted item is not evidence that it disappeared.
Carry observation completeness separately from the returned entries.

Verify a removal only when the relevant observation is complete enough to
establish absence and is bound to the original target. Do not use a reduced
count after a partial scan as proof of success.

Apply the same rule to inferred labels. A prefix of a child list can provide
partial text, but cannot establish that an unread child has no label.
Report unknown evidence as unknown.

## Preserve target and frame identity

A known contradictory window ID must exclude a candidate even if its title
matches. Title fallback requires genuinely unavailable identity evidence
and a separately established, unambiguous target.

Keep screenshot generation, target identity, display origin, geometry and
scale together. Invalidate an action when the transform changes. Account
for window shadows separately from the window frame, and never assume a
fixed display-scale multiplier.

Preserve input units: the reviewed macOS wheel path uses line units, while
a computer-use tool may document pixel deltas. Do not reuse a delta
without the destination contract's conversion.

## Preserve privacy and resource ownership

Snapshot redaction does not prove that every auxiliary path avoids reading
text. Review selection, caret and geometry helpers at their own read
boundary, including secure-field handling. Do not infer a privacy guarantee
solely from the final screenshot or tree output.

In a backend implementation, adopt owned native results before subsequent
fallible work, including deadline checks. Cancellation must preserve
delivery status and distinguish necessary release of held input from a new
cursor, focus or global-key action.

When a backend can return while a native worker continues, distinguish
caller completion from worker completion and resource release. A timed-out
receive does not prove the clipboard was closed. Preserve any stronger
completion or cleanup guarantee in the destination tool's documented
contract.

## Judge test and probe evidence before trusting it

A green harness, probe or dogfood run is only as strong as what it could
have failed on. Before citing one as evidence:

- Treat a run that measured nothing as a failure, not a pass. A declared
  measurement that wrote a placeholder, a `measurable: false` record, a
  skipped leg or an empty result must not count as observed behaviour.
- Pair every negative with a control that is known to fire. An absence
  reported next to an untrusted or untested control means nothing.
- Verify an effect by an independent re-read of the target, never by the
  tool's own success flag, an input API's return count or a launcher's
  exit code. Read back a planted secret before claiming it did not leak.
- Check that a comparison actually had something to compare. A value read
  twice across a change that never happened, a null compared with a null,
  or a count that is already non-zero at rest proves nothing.
- Discard the warm-up sample by position, not by sorting; dropping the
  smallest value biases the minimum.
- Distinguish a persistent permission failure from a transient race, and a
  constant written into a record from a measured value.

A desktop test that kills processes by image name, clears a shared surface
(clipboard, notification list), types into the first window of an app
name, or posts global input without checking the foreground can damage the
user's own work. Such a test belongs on a disposable host. On a shared
desktop, target only windows the run itself launched, identified by
process and handle.

## Source basis and verification limits

This independently written reference uses the completed `crates/macos`
review at [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)
(Apache-2.0) at `6660fbac768dc7e7332837b90ed465684859afa3`, and the
computer-use and browser contracts it was compared with. Useful source
anchors are:

- `actions/ax_helpers.rs`, `actions/scroll.rs` and `actions/chain/` for
  delivery status and fallback.
- `notifications/scan.rs` and `notifications/dismiss_verify.rs` for
  observation completeness.
- `system/window/window_resolve.rs` and `system/screenshot.rs` for target
  identity and frame geometry.
- `tree/resolve/`, `tree/query/` and `tree/child_labels.rs` for reference
  identity and bounded observations.
- `tree/properties/text_insertion.rs` and `notifications/nc_session.rs` for
  auxiliary reads and active cleanup.

Paths above are relative to `crates/macos/src/`. The review covered all
292 files and 45,682 physical lines of the `crates/macos/` partition. No native execution,
desktop test or private-API compatibility probe was performed. This source
comparison establishes no missing live capability in the current tool and
no whole-product guarantee about other platform layers.

The worker-lifetime guidance additionally draws on the Windows clipboard
subtree at the same revision: all 18 files and 2,606 physical lines under
`crates/windows/src/input/clipboard/` were reviewed. In `mod.rs`, a timed-out
receive leaves its worker running; `clipboard_worker_state.rs` tracks that
worker until its ticket drops.

The test-evidence section draws on the completed review of the whole
repository at the same revision, in particular `probes/windows/common.ps1`
(the mandatory-measurement gate and its self-test), the Windows probe
scripts under `probes/windows/` and the dogfood runners under
`probes/windows/scratch/`. Those observations are static source review.
No probe, harness, test or desktop operation was run, and the Windows
comparison column above stays limited to the cited clipboard subtree.
