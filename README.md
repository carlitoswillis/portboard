# portboard

A zero-dependency Node dashboard that lists the Mac's listening ports as tappable links. Made for checking dev servers from a phone.

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

A patch panel. One jack per app: the port silkscreened large in a monospace,
its lamp lit when the port is reachable from the phone and unlit when it only
answers on the Mac, an engraved hairline, and the app's name on the strip below
it. Two jacks per row on a phone, so a dozen apps clear the fold without a
scroll; the grid widens on a laptop. Below it, "Everything else" opens a dense
patch list of the ports you didn't put there — same lamps, same fixed-width port
column. Graphite and warm concrete, no gradients, no shadows, no glow on the
lamps; light and dark follow the device.

## Tips

- Dev servers that bind localhost only (e.g. `next dev`) won't be reachable from the phone. Start them with `-H 0.0.0.0` (or the equivalent host flag) and their portboard links will work.
- Set `PORTBOARD_PORT` to run the dashboard on a different port than 7777.
- The top grid holds the ports named in `APP_NAMES` in `server.js` plus any listener whose working directory is under `~/workspace`; edit that map to name your own, and set `PORTBOARD_WORKSPACE` if your projects live elsewhere. Everything else goes in the drawer, named after the process holding the port.
- Nothing is exposed to the public internet: the dashboard only listens on the Mac's local interfaces, reachable from your home LAN and your Tailscale tailnet.
