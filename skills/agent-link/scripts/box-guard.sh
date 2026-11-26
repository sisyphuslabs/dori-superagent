#!/usr/bin/env bash
# box-guard.sh send BOX TEXT
#
# Stands between the reference gateway and its terminal host: set the gateway's MBX_HC to this
# file. It types TEXT into BOX only while a mailbox program (box.sh BOX) is running, and exits 0
# only once the line is in BOX's log. Anything else exits non-zero, so the gateway answers
# "mailbox write failed" instead of typing into a shell left in the box's place.
#
#   BOX_GUARD_HC     the real terminal host (default ~/.local/bin/herdr-core)
#   MAILBOX_DIR      where box.sh keeps BOX.log (default ~/mailbox, as box.sh)
#   BOX_GUARD_TRIES  tenths of a second to wait for the line in the log (default 50)
set -u
[ "${1:-}" = send ] && [ $# -eq 3 ] || { echo "usage: box-guard.sh send BOX TEXT" >&2; exit 2; }
box=$2 text=$3
hc=${BOX_GUARD_HC:-$HOME/.local/bin/herdr-core}
log=${MAILBOX_DIR:-$HOME/mailbox}/$box.log

# A box is a process whose whole command line is "[interpreter] .../box.sh BOX". The name goes in
# through the environment so that awk's own command line cannot match it.
if ! ps -A -o args= | GUARD_BOX=$box awk '{ n = split($0, w, " ") }
  (n == 2 || n == 3) && w[n] == ENVIRON["GUARD_BOX"] && w[n - 1] ~ /(^|\/)box\.sh$/ { f = 1 }
  END { exit f ? 0 : 1 }'; then
  echo "box-guard: $box is not running the mailbox program; refusing to deliver" >&2
  exit 3
fi

before=$( [ -f "$log" ] && wc -l < "$log" || echo 0 )
"$hc" send "$box" "$text" || exit 4

for _ in $(seq "${BOX_GUARD_TRIES:-50}"); do
  if [ -f "$log" ] && tail -n +"$((before + 1))" "$log" | cut -d' ' -f2- | grep -Fxq -- "$text"; then
    exit 0
  fi
  sleep 0.1
done
echo "box-guard: $box accepted the text but did not record it" >&2
exit 5
