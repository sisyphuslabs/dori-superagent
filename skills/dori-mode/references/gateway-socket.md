# The gateway socket

On a Dori VM the owner talks to the Dori in the dori.bot web chat. The Dori reaches that chat only through a local Unix socket that a gateway on the host hands into its container. The skill's side of it is a thin client, `scripts/src/messenger/gateway.ts`, used by `dori send gateway` and `dori inbound gateway`. This file lists the frames the client sends and receives; the types are a hand-written copy in `scripts/src/messenger/gateway-frames.ts`.

The client holds no token and knows nothing about where the chat lives: it writes to the socket, and the gateway does the rest.

## The socket

- Path: `DORI_GATEWAY_SOCKET`, else `gateway.socket` in `~/.dori/config.json`, else `/run/dori-gateway/dori.sock`.
- One JSON object per line, UTF-8, `\n` after each line, in both directions.
- A send opens a connection, writes one frame, reads the `result` that answers it, and closes. The inbound stream keeps one connection open.
- No socket file means this machine is not a Dori VM: `dori boot` prints `GATEWAY skipped (no gateway socket)` and the rest of the skill runs as usual.

## Frames the client sends

| `op` | Fields | Meaning |
|---|---|---|
| `ping` | | Is the gateway there? Answered with `contract_version`. |
| `send` | `kind: "post"`, `op_id`, `text` | A new message. The message's id is its `op_id`. |
| `send` | `kind: "edit"`, `op_id`, `target_id`, `text` | Replace the text of a message the Dori posted, in place. |
| `send` | `kind: "status"`, `op_id`, `status_id`, `phase`, `text`, `rows` | One status row edited in place. `phase: "start"` creates row `status_id` (the client uses the start's `op_id`), `update` and `stop` change it. `rows` is a list of `{ id, label, state }` with `state` one of `running`, `done`, `failed` (at most 50). |
| `send` | `kind: "question"`, `op_id`, `text`, `options` | A question with options `{ id, label }` (at most 8). The question's id is its `op_id`; the answer comes back inbound. |
| `send` | `kind: "receipt"`, `op_id`, `title`, `lines` | A receipt: a title and `{ label, value }` lines (at most 20). |
| `subscribe` | `session_id`, `session_path` | Opens the inbound stream and announces the lead session it belongs to: its id and the absolute path of its session file. |
| `ack` | `seq` | The Dori has taken inbound `seq`. |

Ids (`op_id`, `target_id`, `status_id`, option and row ids) match `[A-Za-z0-9_-]{1,64}`. A text is 1 to 32,768 characters; a label, title or value 1 to 200.

`op_id` is chosen once per send and reused on every retry of that send, so a send repeated after a dropped connection is stored once.

## Frames the client receives

`result` answers one request:

```json
{"op":"result","re":"send","code":"ok","op_id":"..."}
```

- `re`: the `op` it answers, or `unknown` when the line could not be read.
- `code`: `ok`, `queued` (taken, delivered when the chat is reachable again), `unbound` (no session has subscribed yet), `invalid`, `too_large` or `unavailable`.
- `op_id` on a send's answer, `seq` on an ack's answer, `contract_version` on a ping's answer.

`inbound` carries one user message or answer for the subscribed session:

```json
{"op":"inbound","seq":7,"session_id":"...","id":"...","created_at":1795087785000,"kind":"message","text":"..."}
{"op":"inbound","seq":8,"session_id":"...","id":"...","created_at":1795087790000,"kind":"answer","question_id":"...","option_id":"o1"}
```

An answer names its question and carries `option_id`, `text`, or both.

## What the client does with them

- `ok` and `queued` are success. `unavailable`, a refused connection and a connection that closes before answering are retried with backoff (1, 2, 4, 8 s; five attempts), with the same `op_id`; after the last one the command exits non-zero with `gateway_unavailable`. Any other code is not retried and is reported as `gateway refused the <kind>: <code>`.
- Text that contains `$(` is refused before anything is written, as in the other messengers.
- Inbound: after `subscribe` the client hands each `inbound` frame to the lead session, then writes its `ack`. A dropped stream is reopened with the same backoff and the session announced again. The gateway resends what was not acked; a `seq` already handed over is acked again without a second hand-off.

## The lines the CLI prints

- `dori send gateway --text T` prints `SENT <id>`; `--edit <id>` edits in place and prints nothing.
- `--status start|update|stop --text T [--status-id ID] [--row running:LABEL ...]` prints `STATUS <id>`; rows are numbered `r1`, `r2`, ... by position.
- `--question --text T --option LABEL --option LABEL ...` prints `QUESTION <id>`; options are numbered `o1`, `o2`, ...
- `--receipt TITLE --line LABEL=VALUE ...` prints `SENT <id>`.
- `dori inbound gateway [--session ID] [--session-file PATH]` subscribes as the lead session (default `PI_SESSION_ID` and `PI_SESSION_FILE`), prints `INBOUND_READY gateway`, then one line per message, in the other messengers' field order:

```
INBOUND gateway <session> - <id> - <json text>
INBOUND gateway:answer <session> <question id> <id> - <json text> option=<option id>
```

Run it as a persistent monitor of the lead session, as with `dori inbound slack`: each line wakes the lead. The rules for this surface are in `rules/dori-bot.md`.
