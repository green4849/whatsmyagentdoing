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

## Character on screen

If `~/.whatsmyagentdoing/pet/usagi-sheet.png` and `usagi-sheet.json` exist, a
small character walks along the bottom of the main screen (above the Dock):
it runs to the right corner for 15 seconds when a session needs you (each
new wait shows again; the menu bar dot keeps it after that), sits down crying for ten
minutes after a failed request, hurries about while sessions work, dances
while sound is playing, and dozes after five minutes without input. Click it
to open the dashboard; drag it to move it. "화면에 캐릭터 띄우기" in the menu
turns it off. It isn't shown over full-screen apps.

When a Chrome window is open it lives on the frontmost one: once that window
has been in front for a second, the character hops onto its top edge (or, on
another monitor, drops in there) and walks only along the part no other window
covers. It follows the window when it moves or changes size, and falls to the
bottom of the screen when the window closes or reaches the top of the screen
(no room to stand). If the front Chrome window fills its screen, the character
waits at the bottom of that screen. Dragged off a window by hand, it stays
where you put it until another Chrome window comes to the front. Only window
positions and app names are read, not titles.

It has a voice if you put short clips in `~/.whatsmyagentdoing/pet/sounds/<name>/`
(outside the repo; `<name>` as in `<name>-sheet.png`, so `sounds/usagi/`, and
clips directly in `sounds/` are used when that folder has none): `ask` (reached the corner for a session that needs you),
`fail`, `done` (a turn finished), `welcome` (back after being away), `poke`
(clicked), `drop` (let go after a drag; said every time, not held back by
the spacing rules; picking it up is silent), `dance` (music started). `ask.m4a`, or variants `ask-1.m4a`, `ask-2.m4a` … picked at random;
m4a, wav, mp3, aiff or caf. Missing clips are skipped. It stays rare: 8 seconds
between any two sounds, two minutes between the same one, each turn called out
once, nothing while you're away or a full-screen app is in front, only `ask`
and `fail` while music plays, and its own clip doesn't count as music. It
follows the Mac's volume; "캐릭터 소리" in the menu turns it off.

The art stays outside the repo. `WMAD_PET=<name>` picks `<name>-sheet.*`.
No permission prompts: sound means "the default output device is in use",
away means "seconds since the last keyboard or mouse event".

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
