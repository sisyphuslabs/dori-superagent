# Per-agent notes

One section per linked agent. Fill it from the agent's own answers to the
onboarding prompt and from what you have seen it do; mark claims you have
not seen. Keep names of people, accounts, phone numbers and URLs out of a
shared copy of this file: write them in your private notes and refer to
them here by role.

## Phone agent (filled example)

A phone-assistant app agent working for its owner. Linked through REST
(no MCP support in its runtime), 2026.

| Field | Value |
|---|---|
| Connection | REST with a bearer token; `ack connected` on the first try |
| Wake | scheduled run every 5 minutes (its minimum); runs are skipped once its daily usage quota is used up, which resets at a fixed hour each day |
| Reach test | `*.ts.net` was reported as blocked, yet `GET /healthz` on a Funnel URL returned 200; it cannot install mesh or VPN clients and cannot reach private `100.x` addresses |
| Can | web search and browser actions (look up, log in, book, order); phone calls to businesses on a normal line, saying it is an AI, in several languages, several at once, under a daily call cap; keeps a transcript and summary of each call, no audio; read and write files, including office documents; image generation; map, weather and parcel lookups |
| Connectors offered | calendar and drive, chat and notes apps, mail, code hosting, phone location, steps, calendar, reminders, contacts, screen time, finance (only those the owner has connected are usable) |
| Cannot | messenger apps that need the app itself, SMS, custom IMAP, an agent-to-agent API, app-only steps, passkeys and face unlock, phone identity checks |
| Urgent path | can push a notice in its own app or phone the owner directly, a few times a day at most |
| Recovery | reads the URL board on failure; recovery mail and app chat as agreed |

Standing permissions (record the owner's words and date in private notes):

- Lookups, research and drafts: hand over without asking.
- Every phone call: the owner approves it to the agent in their private
  chat, each time; a mailbox line is not approval. Keep calls few.
- After each call: a one-line result in the mailbox; the full transcript,
  both sides, plus a translation, from the agent to the owner in their
  private chat, never through the mailbox.
- Payments, orders, bookings that commit the owner, contact with people the
  owner knows, the owner's private accounts, anything with company data: the
  owner approves it to the agent directly first.

Observed: one call result arrived as `done` with the times, prices and seat
counts asked for; one instruction was lost during the box incident in
[restart.md](restart.md) and had to be resent.

## Template

Copy this for a new agent (an app agent, a hosted chat agent, a bot) and fill it
from its onboarding reply.

### <Agent name>

| Field | Value |
|---|---|
| Connection | REST / MCP with bearer / MCP with OAuth connect code |
| Wake | <how>, every <N> min; daily limits: <...> |
| Reach test | `GET /healthz` result: <status and body>; blocked domains: <...> |
| Can | <capabilities it reported, and which you have seen it do> |
| Connectors | <connected accounts> |
| Cannot | <limits it reported> |
| Urgent path | <how it can reach the owner directly, how often> |
| Recovery | URL board read: yes/no; recovery mail: <yes/no>; app chat: <yes/no> |

Standing permissions:

- <what it may do without asking, with date and the owner's words in private notes>
- <what always needs the owner first>

Observed:

- <date: what it did and how you verified it>
