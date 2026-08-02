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

## Tips

- Dev servers that bind localhost only (e.g. `next dev`) won't be reachable from the phone. Start them with `-H 0.0.0.0` (or the equivalent host flag) and their portboard links will work.
- Set `PORTBOARD_PORT` to run the dashboard on a different port than 7777.
- The "Your projects" section groups listeners whose working directory is under `~/workspace`; set `PORTBOARD_WORKSPACE` if your projects live elsewhere.
- Nothing is exposed to the public internet: the dashboard only listens on the Mac's local interfaces, reachable from your home LAN and your Tailscale tailnet.
