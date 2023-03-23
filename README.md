# James' xterm.js

Original readme [here](README.md).

This fork contains my personal modifications to xterm.js that are not approved by upstream maintainers.

## Changes Made

- **Added an option to disable mouse reporting.**
  If this option is enabled, this will allow scrollback and selection on terminal apps, even those that requires mouse reporting (e.g. `tmux` and `vim`).
- **Fixed link activation behaviour.**
  Link is no longer opened when selecting the a text within a link.
