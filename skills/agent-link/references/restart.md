# Restarts, outages and the silent-loss incident

## What went wrong once

The gateway host was a WSL instance. It was restarted to raise its memory
limit. Afterwards the gateway answered, the tunnel answered with a new URL,
`/healthz` was 200 and every send returned `{"sent": ...}`. For about 45
minutes nothing reached the other side.

The cause: the two mailbox terminals had been started with the terminal
host's "keep" option, so they survived the restart, but as plain shells, not
as the mailbox program. The gateway writes a message by typing it into the
terminal. Each line was typed into bash, failed with a syntax error and was
gone. The logs had no new lines; `/api/messages` returned nothing new. Six
lines were lost in both directions, among them a call result and a change
of instructions. They were later recovered from the terminal screens and
resent.

Lessons:

- A terminal that is kept across restarts comes back as a shell. Anything
  that "sends text" to it then runs as shell commands. Never use the keep
  option for a text-sink program.
- "Sent" from the gateway means typed, not recorded. Only a line in the log
  file proves delivery.
- A link must fail loudly. The restart-safe setup below re-creates the boxes
  on every start, and the checklist proves one round trip before anyone
  trusts the link again.
- Re-creating and testing afterwards does not cover the window during a
  failure or a startup. The gateway itself has to refuse to type into
  anything that is not the mailbox program: run it with `MBX_HC` set to
  [`scripts/box-guard.sh`](../scripts/box-guard.sh). The guard delivers only
  while `box.sh BOX` is running and succeeds only once the line is in the box
  log; otherwise the gateway answers `mailbox write failed` and `link.mjs
  send` prints `MBX_UNCONFIRMED`.

## Restart-safe box terminals

Run the boxes from their own user unit, started after the terminal host and
restarted with it, instead of relying on terminals that survive:

```ini
# ~/.config/systemd/user/agent-mailbox-boxes.service
[Unit]
Description=Re-create the mailbox box terminals after the terminal host starts
After=herdr-core.service
PartOf=herdr-core.service

[Service]
Type=oneshot
ExecStart=%h/agent-mailbox-boxes.sh

[Install]
WantedBy=herdr-core.service
```

`agent-mailbox-boxes.sh` does, for each external agent:

1. close any existing terminal named `inbox-AGENT` and `outbox-AGENT`
   (whatever it is running now);
2. start `mailbox/box.sh inbox-AGENT` and `mailbox/box.sh outbox-AGENT` as
   named background terminals that outlive their parent, **without** the
   keep option;
3. skip mirror names: the lead's mirror has no boxes of its own.

Enable it with `systemctl --user enable agent-mailbox-boxes`. Prove it once
by restarting the terminal host and running the round trip. Keep the guard
in front of the terminal host whatever starts the boxes.

## After any restart (full checklist)

Applies to the gateway host, its WSL, the terminal host, the gateway service
and the tunnel.

1. Units: the terminal host, the gateway, the boxes unit and the tunnel (if
   any) are active.
2. `curl -s 127.0.0.1:8787/healthz` is `{"ok":true}`, and the same on the
   public URL from outside.
3. Each box terminal runs `box.sh` (its screen shows `[inbox-AGENT] ready`,
   not a shell prompt). If not, run the boxes script by hand.
4. Round trip: `link.mjs send "ping <n>"`; on the host `tail -1
   ~/mailbox/inbox-AGENT.log` shows it; at the agent's next wake `done pong
   <n>` reaches the lead's watcher.
5. URL changed (quick tunnels change on every restart):
   1. update the lead's `MBX_URL_FILE`;
   2. update the gateway's public-origin setting (`MBX_BASE` in the
      reference) and restart the gateway;
   3. rewrite the URL board, then fetch the raw URL and compare;
   4. add the new origin to the lead's `MBX_APPROVED_ORIGINS`;
   5. have the owner confirm the new URL to the agent in their private chat.
      The agent finds it on the board, but sends its token there only after
      that confirmation.
6. Unconfirmed lines: for every `MBX_UNCONFIRMED` id, check the inbox log
   or ask the agent whether it arrived, then resend the rest with
   `link.mjs send --id <id>`, so the agent cannot act twice on one id.

Never restart a shared host just to test this. Restart only the units.

## Outage, seen from the lead

| Watcher prints | Likely cause | Do |
|---|---|---|
| `MBX_ERR ... network error` or `timeout` | host, WSL or tunnel down; URL changed | checklist above |
| `MBX_ERR ... not an approved origin` | the URL changed and the new origin is not approved | confirm the URL, add it to `MBX_APPROVED_ORIGINS` |
| `MBX_ERR ... HTTP 401` | token revoked or wrong token in the store | re-issue (below) |
| `MBX_UNCONFIRMED ... HTTP 400` | the guard refused: a box is not running the mailbox program, or the line was not logged | run the boxes script; confirm the id with the agent before resending with `--id` |
| `MBX_GAP` | more than 200 lines since the last read | read the missing range from `outbox-AGENT.log` on the host |
| nothing for longer than two wake intervals after an instruction | the agent's schedule stopped, its quota ran out, or the box is a shell | check the inbox log for your line, then ask the owner to poke the agent |

## Re-issue or revoke a token

On the host, as the gateway user: `node server/server.mjs revoke AGENT`,
then `issue-token AGENT`, and store the new token straight into the secret
store (macOS: `security add-generic-password ... -w` read from a prompt, not
from the command line). Hand it to the agent privately, as at setup.
