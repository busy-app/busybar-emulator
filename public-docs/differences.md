# How the emulator differs from a BUSY Bar

A BUSY Bar sits on your network; the emulator runs on the computer where you work, next to your own services. Where
that matters for safety, the emulator is stricter than a BUSY Bar. This page lists those differences, then the others we
know of. The list is not complete: a BUSY Bar has the final word, so run your app on one before you rely on a detail.

## Who may call the emulator

| | A BUSY Bar | The emulator |
|---|---|---|
| Web pages of other sites | Any page may call the BUSY Bar's API and read the answers: every answer carries `Access-Control-Allow-Origin: *`. | Refused with `403`. Only the emulator's own pages (its local web, its window) may call it. |
| A page of your own, of an origin you trust | — | The desktop app has no setting that lets a page in. Let a program on your computer make the request for the page (your dev server, a script): a request without an `Origin` header is answered. The server started from the emulator's source (`node packages/server/index.mjs`) takes `--allow-origin <origin>` (for example `--allow-origin http://localhost:3000`), once for each origin; that page then gets the same CORS headers a BUSY Bar gives. |
| A page with `Origin: null` (a sandboxed frame, a file opened from disk) | Answered. | Refused with `403`. Let a program on your computer make the request, or serve the page from a web address and name its origin with `--allow-origin` to the server started from its source. |
| A request under another name than `127.0.0.1` or `localhost` | Answered: a BUSY Bar does not look at `Host`. | Refused with `403`. This stops a site from reaching the emulator through a name of its own made to point at your computer (DNS rebinding). |
| `localhost` and `127.0.0.1` | The same BUSY Bar. | The same emulator, but a page loaded from one is another origin for the other, as in any browser. Call the address the page came from. |
| Programs without `Origin`: `busy-cli`, `curl`, scripts, agents | Answered. | Answered. They get no CORS headers, which they do not need. |

The same rules apply to the state stream, `ws://…/api/status/ws`.

No page of another origin may embed what the emulated BUSY Bar's address gives, either: every answer carries
`Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `frame-ancestors 'self'`. So
another page cannot show the local web in a frame, or load a file of the BUSY Bar's storage as a script, a picture or a
style. A BUSY Bar allows all of these. This also holds for a page named with `--allow-origin`: it reads the API with
`fetch`, but cannot put `<img src="http://127.0.0.1:8640/api/screen">` on itself; draw what `fetch` brings instead.

## What an app on the BUSY Bar may reach

On a BUSY Bar, `localhost` is the BUSY Bar itself: an app reaches its BUSY Bar's API as `http://localhost/api/...`, and any other port
of `localhost` has nothing behind it. In the emulator the same address would be the computer you work on, with your
databases, dev servers and the emulator's own management address. So the emulator keeps an app away from your
computer: from its loopback and from its other network addresses.

| | A BUSY Bar | The emulator |
|---|---|---|
| `http://localhost/api/...`, `http://127.0.0.1/api/...` | The BUSY Bar's API. | The emulated BUSY Bar's API. |
| Another port of `localhost`, `127.0.0.1`, the rest of `127.0.0.0/8`, `0.0.0.0` or `[::1]` | The BUSY Bar itself, where nothing listens: the request fails with `socket error`. | Fails the same way, with `socket error`, and nothing reaches your computer. The app's console says why and how to allow the port. |
| `*.localhost`, `localhost.`, numeric spellings such as `2130706433` or `127.1`, a name that resolves to the loopback | By the firmware's code, the BUSY Bar sends such a name to DNS (it knows only `localhost` and dotted addresses itself); what then happens depends on the network. | Refused at once with `socket error`, as above. |
| Your computer's own network addresses: its address on your home network, its IPv6 addresses, a VPN's (such as Tailscale), the BUSY Bar's USB network, its name on your router's DNS | A BUSY Bar on the same network may reach a service that listens on all of your computer's interfaces (`app.listen(3000)` without a host, a port Docker publishes), if your computer's firewall lets it in. | Refused with `socket error` unless the port is allowed. From inside your computer no firewall stands between the emulator and your services, so to let these addresses through would open to every app what a BUSY Bar could reach only through the firewall. The addresses are read again at every request. |
| A port you allowed | — | Reached, on the loopback and on your computer's own addresses. Run `busy-emulator allow-local <port>` while the emulator runs (below), or start the server from the emulator's source with `--allow-local <port>` (once for each port). A web page cannot allow a port, not even the emulator's own window. |
| The emulated BUSY Bar's address (8640 by default) and its management address | — | Refused always, allowed or not. |
| Any other address: the internet, other computers on your network | Reached. | Reached. |

To allow a port while the emulator runs, as with the desktop app, which starts the emulator itself, use the
emulator's command line. The app's console names the command when the emulator refuses a request:

```sh
busy-emulator allow-local 3000            # apps may reach port 3000 of this computer until the emulator quits
busy-emulator allow-local --remove 3000   # not any more
busy-emulator allow-local                 # the ports allowed now
```

The command line is at `~/.busy-emulator/bin/busy-emulator` on macOS and
`%LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe` on Windows. It sends the server's key to the emulator's
[management address](#the-management-address). A program of your own can do the same with `POST`, `DELETE` or
`GET /_emu/local-ports?port=<port>` and the header `Authorization: Bearer <key>`.

A name is resolved once, and the request goes to exactly the address that was checked, so a name that answers with
another address the second time (DNS rebinding) does not get through. The BUSY Bar's error text for these requests is
taken from its firmware's code (lwIP answers a closed port of the BUSY Bar with a reset, mongoose reports `socket error`).
It has not been checked on a BUSY Bar.

## The management address

Besides the BUSY Bar's address, the emulator listens on a second port of `127.0.0.1`, the management address, for things a
BUSY Bar does not have. It answers only programs that send the server's key, `Authorization: Bearer <key>`. The emulator
makes a new key every time it starts and writes it to the file `key` in its data folder, readable by your user
only; it is never printed. `run/server.lock` in the data folder names the address, and a server started from the
source prints it in its second line.

## What the log says of an app's mistakes

The emulator notes some mistakes of an app in its log (`busy-emulator logs`) that a BUSY Bar keeps to itself. The lines begin with `emulator:`; the app sees nothing of them and runs on as it would on a BUSY Bar.

- The emulator shows unhandled promise rejections in the log, with the reason and where it came from; the BUSY Bar does not.
- The emulator shows refused API calls of the app in the log, with the BUSY Bar's error text; the BUSY Bar does not. busy-lib turns such an answer into `TypeError: Expected a function`, because the BUSY Bar's runtime has no `Response.clone()`.
- The emulator notes the app's requests to the network that the BUSY Bar handles in a way the app may not expect, with the address and what to change: a redirect, which the BUSY Bar does not follow; a request that failed, with what its error means (`"Inactivity timeout"`, `"Failed to establish TLS connection"`); a response that stopped in its middle, where a reader gets `{ done: true, value: <the error> }` and not an error; a crash from running out of memory soon after a large response, with the response's size; and `TextDecoder` or `TextEncoder`, which the BUSY Bar's JavaScript does not have. The BUSY Bar says none of this.
- `busy-emulator press` on the emulated BUSY Bar while it is powered off answers `bar_off`; `--power-on` turns it on, as a button does on a BUSY Bar.

## Other differences we know of

- **The BUSY Bar's speed is a model.** Your app's JavaScript takes the time it would take on a BUSY Bar, counted from the work
  it does (the instructions it runs, the memory it takes) at the rates measured on a BUSY Bar with firmware 1.3.1, not
  from your computer's speed.
- **When the computer is very busy.** The emulated BUSY Bar keeps time with your computer's clock. When something holds
  up the emulator (a computer under heavy load, a laptop waking from sleep, a debugger), the BUSY Bar catches up on at
  most half a second at once. After a longer hold-up its clock jumps with the computer's: the firmware's ticks and
  animation frames of that time are skipped, and a periodic timer, the firmware's or your app's, fires once for all
  the periods it missed and goes on from then. A BUSY Bar is never held up like that. Record clips when the computer is
  not busy.
- **A loop that never returns.** On a BUSY Bar an app's JavaScript has a thread of its own: a loop such as
  `for (;;) {}` or `while (!ready) {}` holds the app, the screen stays as it was, and a long Back stops it. In the
  emulator the app's JavaScript shares a thread with the emulator itself, so after 2 s of your computer's time
  without returning the app is stopped, as a long Back stops it, and the log says why; buttons pressed meanwhile are
  dropped. 2 s here is minutes on a BUSY Bar, so no app that works on a BUSY Bar is stopped. The same goes for a chain of
  promises that never ends, such as a `.then()` that starts the next one at once: it holds the app's JavaScript on a
  BUSY Bar too. Wait with `setTimeout` instead.
- **A BUSY Bar fresh out of the box at every start.** The apps you installed, their settings and their data stay from one
  start of the emulator to the next. The BUSY Bar's own settings (volume, name, time zone) do not.
- **HTTPS.** The emulator checks a server's certificate against the BUSY Bar's own list of certificate authorities, the
  one in its firmware (Mozilla's, October 2026), not your computer's or Node's. Its TLS library is not the BUSY Bar's
  (OpenSSL, not mbedTLS), so a server that offers only what mbedTLS lacks could work here and fail on a BUSY Bar; we know
  of none. An https answer comes no sooner than the BUSY Bar's 1.4 s handshake allows, but the body then arrives at your
  computer's speed: a large body takes longer to download on a BUSY Bar, and that time is not modelled.
- **Requests with the BUSY Bar's own key.** A BUSY Bar signs some requests to BUSY's apps API with a key of its own; the
  emulator has none. It answers the weather forecast itself, from a saved answer, and sends any other such request
  without the key: [what goes out](network-and-disk.md#what-goes-out).
- **The status lights.** The two LEDs beside Start / Pause light when the firmware lights them: the BUSY timer, the
  brightness settings, pairing, and your app's `POST /api/display/draw` with `led_notification_color` (three blinks
  at full brightness, then dark). Their brightness follows the BUSY Bar's brightness setting; at automatic, which follows
  a light sensor on a BUSY Bar, the emulator takes half.
- **No `10.0.4.20`.** A BUSY Bar on USB answers at `http://10.0.4.20`; the emulated BUSY Bar answers at the address
  `busy-emulator status` prints, `http://127.0.0.1:8640` unless the port is taken. Use that address where the guides
  say `10.0.4.20` (`busy-cli ... --addr 127.0.0.1:8640`); the APPS screen with no apps shows it too. The HTTP API
  documentation is at `/docs/` of it, as on a real BUSY Bar: `http://127.0.0.1:8640/docs/`, with Try it out against
  the emulated BUSY Bar.
- **Only in the emulator.** `busy-emulator time advance` lets time pass at once, `record` makes clips, and the log
  says more of an app's mistakes (above). A BUSY Bar has none of these.
