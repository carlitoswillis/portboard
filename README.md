# portboard

A zero-dependency Node dashboard that lists the Mac's listening ports as tappable links. Made for one job on a phone: open it, find the app, tap, you're there.

## Use it

On your phone (same home wifi):

**http://\<your-mac\>.local:7777** — where `<your-mac>` is your Mac's hostname (`hostname -s` prints it; `install.sh` prints the full URL).

On the Mac itself: http://localhost:7777

Away from home, the same dashboard works over Tailscale at the tailnet hostname (e.g. `http://<your-mac>:7777` on your tailnet).

## Install / uninstall

```sh
./install.sh     # writes a LaunchAgent; starts at login, restarts if it crashes
./uninstall.sh   # stops it and removes the LaunchAgent
```

Logs go to `~/Library/Logs/portboard.log`.

## The design

A flat ledger, borrowed from the Working Memory phone app so the two feel like
siblings. One 56px row per port on a hairline, no cards: the app's name first,
the port as a quiet right-aligned figure, and a second line only where it
carries a fact (the framework, the process behind an unknown port, or
`Local only`). Nothing is a colored badge — a port you can't reach from the
phone is simply dimmer. The Nocturne palette, one sans with the serif kept for
the page title alone, tabular figures, sentence case, and safe-area padding;
light mode ("Nocturne Day") follows the device preference with the same tokens.

`APP_NAMES` in `server.js` maps a port to the name you know it by (3000 →
Autojob, 7788 → Assistant, and so on). Edit that map to name your own. A port
that isn't in it falls back to its project folder, then to the process holding
it, so every row still says what it is. A filter field appears only when there
are more than twelve listeners, and typing in it opens the "Everything else"
drawer so a match can't hide.

## Tips

- Dev servers that bind localhost only (e.g. `next dev`) won't be reachable from the phone. Start them with `-H 0.0.0.0` (or the equivalent host flag) and their portboard links will work.
- Set `PORTBOARD_PORT` to run the dashboard on a different port than 7777.
- The "Your apps" section holds listeners named in `APP_NAMES` plus any whose working directory is under `~/workspace`; set `PORTBOARD_WORKSPACE` if your projects live elsewhere.
- Nothing is exposed to the public internet: the dashboard only listens on the Mac's local interfaces, reachable from your home LAN and your Tailscale tailnet.
