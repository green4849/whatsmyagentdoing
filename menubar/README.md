# Menu bar item (macOS)

A small native menu bar app for the dashboard. It shows one icon in the menu
bar, and clicking it opens the same session list as the side panel, without
opening a window.

## What it shows

- **Icon**: a dot only when something is going on, in the dashboard's colours:
  red when a turn failed, orange when a session needs you, blue when a turn
  finished and you haven't checked it yet, green while sessions work. No dot
  when it's quiet; greyed out when the dashboard isn't running.
  "Show numbers in the menu bar" swaps the dot for a count per colour.
- **Menu**: needs you, newly finished (blue), working. Finished turns you
  already checked are left out. Each row has
  the session's number (①②③), its name and folder, then its status, the
  failure reason or the current step, a time, and how much of its context
  window is left (amber under 40%, red under 15%). Hover for the full title,
  folder, agent and account. Subagents and idle sessions are left out, as in
  the side panel.
- **Blue (newly finished)**: the menu bar can't tell whether you read a reply
  in the agent's own app, so a finished turn counts as checked once you click
  its row or choose "Mark all as checked". A new turn that finishes turns blue
  again. On first run, whatever is already finished counts as checked.
- Open the dashboard (your Safari "Add to Dock" app for it if there is one),
  and start or stop the dashboard server.

It reads `/events` on `127.0.0.1` only and sends nothing anywhere else. With
`--private` the server already leaves out titles and failure reasons, so rows
fall back to the folder name.

Names you gave sessions on the page live in that browser, so the menu uses the
session's own title. Numbers follow the same rule as the page (start order,
kept while active) but are counted separately, so they can occasionally differ.

## Build and run

Needs only the Command Line Tools' `swiftc` (no Xcode).

```sh
sh menubar/build.sh            # builds ~/Applications/WMADMenuBar.app
open ~/Applications/WMADMenuBar.app
sh menubar/login.sh on         # start at login (off to undo)
```

"Start server" runs `bin/cli.js --no-open` from `~/Documents/whatsmyagentdoing`
with `WMAD_ACCOUNT_LABELS=~/.whatsmyagentdoing/accounts.json`. Set `WMAD_REPO`
or `WMAD_PORT` in the environment to change the folder or port.

Without clicking: `~/Applications/WMADMenuBar.app/Contents/MacOS/WMADMenuBar --dump`
prints what the menu would show; `WMAD_DEBUG=1` logs each update.
