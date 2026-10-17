# AirChat

One chat window that reaches your friends wherever they actually are.

You type in AirChat. Your friend gets the message **on their phone** — in their
Messages app as an iMessage or a text, or in Telegram — *and* in AirChat if they
open your link. One thread, several networks, no app store involved.

It runs on **your own computer**. There is no account, no server bill, and your
messages live in one JSON file you own.

```
                        ┌───────────────────────────┐
                        │        AirChat            │
   you (this PC) ──────▶│  thread = one             │
                        │  conversation             │
                        └────────────┬──────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        AirChat link           iMessage bridge           SMS / Telegram
     (friend's browser)     (BlueBubbles, needs a Mac)   (Twilio / Telegram)
              │                      │                      │
              └──────────────────────┴──────────────────────┘
                                     ▼
                       your friend's phone, in whatever
                        app they already use
```

---

## The app is the way in now

AirChat is a desktop app. You install it, it opens a window, and it does the
things the browser version could only pretend to do.

- **It opens its own public link.** Every launch starts a free Cloudflare tunnel,
  so invites work from anywhere with no terminal and no second launcher. A link
  from a previous run is forgotten on startup, because a quick tunnel address
  dies with the process that owned it.
- **Encryption is the same code, now in a secure context.** WebCrypto is
  available to the window itself, so locking a message before it leaves the page
  works exactly as it did at `https://` and no redirect is needed.
- **Notifications actually arrive.** The app grants its own window permission and
  shows a real OS notification, with the unread count in the title.
- **Your files live outside the install folder.** `%APPDATA%\AirChat\home` on
  Windows, `~/Library/Application Support/AirChat/home` on a Mac — so updating or
  reinstalling the app cannot take your chats with it. An existing
  `config.json` and `data/airchat.json` next to the code are copied across once.
- **No service worker.** The app never caches its own interface underneath
  itself, so a new version is what you see the next time you open it.

Your **friend** still opens a link in their browser. That is what a link is, and
it stays the free way to reach a phone with no app store involved. What changed
is the host: the app is the thing you run.

```bat
AirChat-Setup-0.1.0-electron.exe
```

From a checkout instead: `npm install` once, then `npm run app`. To have the
machine prove the app really works — encryption round-trip, the lock on disk,
notifications, and the public link answering from the internet — run
`npm run check:app` with AirChat closed.

---

## The free plan: no money, no accounts

Everything in this section needs nothing from anyone — no card, no signup, no
third party.

**1. Start AirChat.**

Double-click **`Start AirChat.bat`**, or the installed AirChat icon. Every
launcher in this folder is now the same door.

Opening it always does the same three things, in this order: a window appears
straight away, the chat server starts inside it, and a free Cloudflare Quick
Tunnel opens by itself (Cloudflare's own docs: *no Cloudflare account or domain
required*). The public address is saved into `config.json`, and the Invite window
builds each friend's code on it.

There is nothing to install first. If `cloudflared` is missing, AirChat downloads
the official build once and keeps it. If the link cannot be opened just then —
no internet, Cloudflare busy — the app says so in the Invite window, keeps
trying by itself, and everything else works over your Wi-Fi meanwhile.

**2. Have your friend install it.**

They open your link, then:

- **iPhone or iPad, Safari:** Share → **Add to Home Screen**
- **Mac, Safari:** File → **Add to Dock** (a normal browser tab works too)
- **Android, Chrome:** ⋮ → **Add to Home screen**

AirChat now opens full-screen from an icon like any other app, and it remembers
the invite — your friend never needs the long URL again.

An Apple Watch cannot open the link itself, because there is no browser on it,
so it cannot be a client. It can still show the notifications the paired iPhone
mirrors, the same as it does for any other app.

**3. Turn on notifications — both of you.**

**Settings → Alerts → Turn on notifications.** On iPhone and iPad this has to be
done from the installed icon, not a Safari tab: iOS only allows web notifications
for apps on the home screen (iOS 16.4 and later). On a Mac it also works from an
ordinary Safari tab (Safari 16 and later).

That is a complete, free, account-free messenger: messages arrive with a
notification and a quiet tone, the tab shows an unread count, and the app opens
instantly from cache.

### What the free plan cannot do

It cannot put a message into your friend's **Messages app**. Sending an SMS
requires a SIM card and a carrier, and there is no software route around that at
any price. If you want that, the only free option is the Android phone you
already own — see **Android phone as a gateway** below.

---

## Encryption: who can read your messages

A chat that stays inside AirChat is **end-to-end encrypted**. "End to end" means
the two ends are the two browsers — yours and your friend's — and everything in
the middle is left holding something it cannot read.

| | Sees your messages? |
| --- | --- |
| Your friend | Yes, obviously. They are the other end |
| Your browser | Yes. This is where a message is locked and unlocked |
| The AirChat server on your PC | **No** — it stores and forwards cipher text |
| `data/airchat.json` on your disk | **No** — open the file and look |
| Cloudflare (your public link) | **No** — it passes on encrypted bytes |
| Anyone on the network in between | **No** |

How it works, without the jargon:

- Each chat gets its own random key, made in your browser.
- Every message is locked with that key (AES-GCM, a fresh nonce per message)
  *before* it is sent.
- The key travels inside the invite link, in the part after the `#`. A browser
  never sends that part of a URL to a server, so the server never learns it.
- Your browser forgets the `#` part of the address as soon as it has saved the
  key, so it does not sit in the address bar in screenshots or history.

**A chat with no key yet is not encrypted, and AirChat says so.** A chat that was
made before this existed, or one you have not invited anyone to since, has no key,
so its header reads "Not encrypted yet" and offers to lock it. That one tap makes
the key and the invite link that carries it. Until you send that new link, the
other person cannot read what you write there — so nothing here is a padlock you
have not earned.

**Locking a chat does not reach backwards.** Whatever was said before the key
existed is still ordinary text in `data/airchat.json` — open the file and you will
see it. Only what is sent after the link is opened is unreadable. If a particular
conversation should never have been plain, delete it (the chat's **⋯** menu →
*Delete this chat*, which removes its messages and its invite from the file) and
start a fresh locked one.

**The link is the key.** Whoever has the invite link can read that chat, so send
it the way you would send a password — to that person, privately. If a link ever
leaks, the chat is only as private as the link was. You can take it back: **Invite
→ Stop sharing this chat** cancels the link immediately. The phone that already
opened it keeps what it has seen; it stops receiving anything new, and a new
Invite is the only way back in.

**The safety code.** Every encrypted chat shows a six-character code in its
header, on both sides. If your friend's code matches yours, nobody swapped keys
in the middle. That is worth doing once, out loud, the first time.

**Check it for yourself, three ways:**

1. **Settings → Privacy & encryption → Run a security check.** It locks a test
   message, unlocks it, and then proves that a message which was altered on the
   way, or opened with the wrong key, is refused.
2. **`Check AirChat.bat`** (or `npm run doctor`). The encryption section runs the
   same test on the real `ui/crypto.js`, and prints each step.
3. **Open `data/airchat.json`** in Notepad and search for `airchat-enc-v1:`. That
   is your message, and it is unreadable there. Nothing but your browser and your
   friend's can turn it back into text.

### What is *not* encrypted

Being straight about this matters more than a warm feeling:

- **iMessage, SMS and Telegram chats.** A phone network has to be able to read
  what it carries, so those messages travel as plain text to that network. AirChat
  will not let you point an encrypted chat at a phone, and each chat is labelled
  so you always know which kind you are looking at.
- **Who, when and how much.** The server still sees the metadata: which chats
  exist, who wrote when, and how long each locked message is. It cannot read them,
  but it can count them. Hiding that as well is real work and is not done.
- **The key.** It lives in the browsers that share the chat. If every device with
  the key is lost, the messages are gone — encrypted text with no key is just
  noise, even for you.
- **A compromised device.** If someone else is in your browser, or on your
  friend's phone, they see what you see. Encryption protects the trip, not the
  endpoints.
- **The key does not rotate.** One key per chat, for the life of the chat. If a
  device is later compromised, messages that device already received can be read.
  Signal-style key ratcheting is not implemented (see *What is not built yet*).

What all of this is *not* is a claim that AirChat is unhackable. It is a claim you
can check: the messages on that disk are unreadable, and the box above says
honestly where the limit is.

---

## The honest bit about iMessage

Apple has **no public iMessage API**. Nothing can send a real blue bubble
without Apple hardware in the loop. That is a hard limit, not a limitation of
this project.

So you have five genuinely different options, and AirChat speaks four of them:

| Route | Blue bubbles? | What it costs | What you need |
| --- | --- | --- | --- |
| **AirChat link** | — | **Free** | Nothing. Works today |
| **Your own Android phone** | No — **green** | **Free, unlimited** | An Android phone + the SMSGate app. **No account** |
| **Telegram** | — | Free, unlimited | A free Telegram account, for both of you |
| **SMS (Twilio)** | No — green | ~1¢ per text + ~$5–7/month, plus one-off US A2P 10DLC registration | A Twilio account |
| **iMessage (BlueBubbles)** | **Yes** | Free, but power | A Mac awake and signed into your Apple ID |

**Important:** SMS still lands in your iPhone friend's **Messages app**. It shows
up right next to their iMessages — it is just green instead of blue. If "it
arrives on his phone like a normal text" is enough for you, SMS is far cheaper
and simpler than chasing blue bubbles.

Paid relays (Sendblue, LoopMessage and friends) do exist and start around
$39/month, which is aimed at businesses rather than two friends.

---

## Quick start (Windows)

1. **Install Node.js** from <https://nodejs.org> if you have not already. AirChat
   needs version 18 or newer. Nothing else is required — AirChat has **zero npm
   dependencies**.

2. **Start the app.** Double-click **`AirChat-Setup-0.1.0-electron.exe`**, or from
   a checkout:

   ```bat
   cd AirChat
   npm install
   npm run app
   ```

   A real window opens with two demo chats in it, and the public link is already
   running — see **The free plan** above.

3. **Check it is healthy** if anything looks off:

   ```bat
   npm run doctor
   npm run check:app
   ```

   `doctor` parses every file, loads every server module, checks that the
   interface and the code agree on element names, and confirms the port is free.
   `check:app` drives the real Electron window and proves what only an app can do:
   a secure context with WebCrypto, a message locked before it is sent and locked
   on disk, keys surviving a reload, notifications, the public link answering from
   the internet, and a second launch opening a window instead of closing. Close
   AirChat first — it refuses to test a copy that is already running.

   The server on its own still works, for a machine with no Electron:
   `npm start` opens the same interface at <http://localhost:4000>, and
   `node tools/tunnel.js` adds the public link by hand for that headless case.

### Keep it out of the way

**`Start AirChat in Tray.bat`** starts the same app with no window of its own and
puts an icon next to the clock: same server, same public link, same chats. The
icon is just the way back to a window. Double-click it to open AirChat;
right-click it to open the log or stop AirChat. If you cannot see it, click the
small `^` next to the clock.

**`Start AirChat.bat`** is the ordinary one: a window you can watch.

Both doors lead to one AirChat. Opening either while AirChat is already running
puts a window in front of you — it never starts a second copy, a second server or
a second link. Nothing has to be closed and nothing has to be stopped first.

### On a Mac

The `.command` files do the same thing with the same app:

- **`Start AirChat (Mac).command`** — opens AirChat.
- **`Start AirChat + Public Link (Mac).command`** — the same door; the public link
  is automatic now.

The first time, macOS may refuse to open a `.command` file that is not marked
executable. Open Terminal in this folder and run this once:

```sh
chmod +x "Start AirChat (Mac).command" "Start AirChat + Public Link (Mac).command"
```

Then double-click it like any other app. `npm run doctor` works on macOS too.

### Want it as a real app window?

The Electron app *is* AirChat now: `AirChat-Setup-0.1.0-electron.exe`, or
`npm install && npm run app` in a checkout. It opens its own public link, asks
for notifications once, and keeps its files in its own folder.

---

## Talking to your friend

### A code, not a link

Click **Invite** in a chat and you get six characters, like `E2LEXR`. Send them
those six characters however you like — they are short enough to read out over
the phone. Your friend opens

<https://site-7f015d99cb0e43f98814f3a7512c55bb.freebuff.page>

and types the code. They land in that one conversation, on their phone, with
nothing to install and no account.

A code cannot carry an address, so a small directory does that one job: your app
registers `code → where it is right now`, and the page asks the directory and
forwards them. The directory holds nothing but the code, the address, an expiry,
and a secret that proves the code is yours — no names, no messages, and it will
only ever forward someone to a `trycloudflare.com` address.

The interesting part is what a code *does* keep: the chat key. The six characters
resolve to your invite **including** the part after `#`, which the browser never
sends to any server. So the key reaches your friend and never reaches the
directory.

**A code works while AirChat is open.** Close it and the directory has nothing to
forward to; the page says the code is not active rather than showing a browser
error. The next time AirChat starts it takes a new address, and the codes you
already handed out are moved to it — the same six characters keep working, for up
to twelve hours.

Run it yourself instead of using the hosted directory:

```bat
directory\       a small Cloudflare Worker + D1 table (npm run check:codes-service)
npm run check:codes   proves the app hands out a code that resolves back to its own invite
```

Point the app at your own copy with `AIRCHAT_CODES_URL`, or set
`friendCodes.directory` in `config.json`.

### The same Wi-Fi

Codes need the public link (below). With no internet, Invite still offers the
Wi-Fi address — `http://192.168.1.20:4000/?guest=…` — which works on your own
network only.

Browsers only allow encryption on a secure address: `https://`, or `localhost`.
A plain `http://192.168.x.x` page therefore cannot lock a single message, so a
Wi-Fi visitor is quietly forwarded to the public address when there is one, and
AirChat says so plainly when there is not.

### From anywhere (free, still your laptop)

Your laptop is not reachable from the internet by default. The app opens the
tunnel itself on every launch; if you are running the server by hand instead:

Nothing, usually. Open AirChat and it opens the tunnel itself, fetching
`cloudflared` the first time if it is missing. If you would rather install it by
hand, **`Install Cloudflared (one time).bat`** still does exactly that.

Either way a free Cloudflare Quick Tunnel is what makes a code reachable, and
that address lives exactly as long as the process behind it. AirChat knows this:
it forgets the previous run's address at startup, refreshes a "still alive" stamp
every 20 seconds, withdraws an address whose stamp has gone quiet, and never
hands one out that cannot open.

---

## Switching on the real networks

Everything is configured in **`config.json`** (created on first run, next to
`package.json`). Restart AirChat after editing it. Each channel is independent.

### Telegram — free, unlimited, works today

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   copy the token.
2. In `config.json`:

   ```json
   "telegram": { "botToken": "123456:ABC-DEF…" },
   "channels": { "telegram": { "adapter": "telegram" } }
   ```

3. Restart, have your friend message your bot once, then set the chat's mirror to
   Telegram. AirChat polls for updates, so it needs no public URL for this.

### SMS — reaches any phone

1. Make a Twilio account and buy a number.
2. In `config.json`:

   ```json
   "twilio": {
     "accountSid": "AC…",
     "authToken": "…",
     "fromNumber": "+1…"
   },
   "channels": { "sms": { "adapter": "twilio" } },
   "publicUrl": "https://your-tunnel-url"
   ```

   `publicUrl` is needed for incoming texts and delivery receipts, since Twilio
   has to be able to reach you. Point Twilio's number's messaging webhook at
   `https://your-tunnel-url/api/webhooks/twilio`.

3. In the US you will also need **A2P 10DLC registration** for the number before
   carriers will deliver to real phones.

### Android phone as a gateway — free, no account

This is the only free way to reach a friend's actual **Messages app**, and it
uses the phone in your pocket rather than a service.

[SMSGate](https://sms-gate.app/) is an open-source Android app that turns your
phone into an SMS API. Its own wording: *"No registration, email, or phone number
required — just install and use."* Run it in **Local Mode** and everything stays
on your device, on your own Wi-Fi, sending through your existing carrier plan.
Your friend gets a normal text on their iPhone. Unlimited, and free.

What it needs from you:

1. An **Android** phone (iPhone cannot do this — iOS does not allow an app to
   send SMS in the background, so there is no iOS equivalent).
2. The phone on the same Wi-Fi as this laptop, and kept charged.

The AirChat adapter for it is not written yet — it is a single file in
`server/adapters/`, roughly the size of the existing Twilio one. Say the word and
it is a short job.

### iMessage — real blue bubbles, needs a Mac

1. On a Mac that can stay awake, install
   [BlueBubbles server](https://bluebubbles.app), sign it into your Apple ID, and
   set an API password.
2. In `config.json`:

   ```json
   "bluebubbles": {
     "serverUrl": "http://192.168.1.50:1234",
     "password": "your-api-password"
   },
   "channels": { "imessage": { "adapter": "bluebubbles" } },
   "publicUrl": "https://your-tunnel-url"
   ```

3. Point BlueBubbles' webhook at
   `https://your-tunnel-url/api/webhooks/bluebubbles`.

If you have no Mac, leave `imessage` on `mock`. AirChat will happily simulate it
so you can still see exactly how the flow works.

---

## Using it

- **`+`** — add a friend by name and phone number or email.
- **Send via** (top of every chat) — choose where messages for that thread go:
  AirChat only, iMessage, SMS or Telegram. Change it whenever you like.
- **A phone number only does something if that channel is really set up.** Out of
  the box every channel is in demo mode, so entering a phone number still keeps
  the message inside AirChat. With no money and no accounts to spend, choose
  **AirChat only** and send your friend the link instead.
- **Every bubble says where it went.** A blue `iMessage` chip, a green `SMS` chip,
  or `AirChat`. That chip is the point of the whole app.
- **Every encrypted bubble says so too.** A green `Encrypted` chip, a padlock
  next to the chat title, and a safety code both sides can compare. Chats that
  are not encrypted say that plainly instead — no false comfort.
- **Demo mode** marks simulated deliveries with an amber `Demo` chip, so a fake
  delivery can never be mistaken for a real one.
- **Notifications** (Settings → Alerts) pop up when a message arrives while you
  are looking elsewhere, with a short tone and an unread count in the tab title.
- **Invite** — a per-chat link for one friend, scoped to that conversation only.
- **Settings** (bottom left) — your name, channel status, and your full-access
  link.

Your friend's side of an invite link shows the same thread from their
perspective, so they can reply in AirChat and it lands next to everything else.

---

## Downloads and packaging

Everything in `artifacts/` is built from this source tree by the scripts in
`packaging/`, on a normal Windows PC with nothing installed but Node. No CI, no
Docker, no build server.

| Artifact | What it is | Built by |
| --- | --- | --- |
| `AirChat-Setup-0.1.0-electron.exe` | **The app.** 106 MB Electron build: a real window, its own icon, its own public link, notifications, and its data kept in `%APPDATA%\AirChat\home`. Attached to the GitHub release rather than committed, because it is over GitHub's 100 MB file limit. | `npm run build:win` |
| `AirChat-Setup-0.1.0.exe` | 324 KB self-extracting installer for a PC without Electron. Unpacks to `%LOCALAPPDATA%\AirChat`, checks for Node, adds a Desktop shortcut, starts it. No admin rights. | `npm run build:sfx` |
| `AirChat-0.1.0-mac.zip` | `AirChat.app`, zipped with its executable bit intact. Data lives in `~/Library/Application Support/AirChat`, never inside the bundle. | `npm run build:mac` |
| `AirChat-0.1.0-unsigned.ipa` | An **unsigned, uncompiled** iOS payload: real `Info.plist`, real icons, the real interface, and a placeholder where the binary belongs. It will not install until it is compiled and signed on a Mac. | `npm run build:ipa` |

Three things are worth being straight about, because they are limits of the
platforms rather than of this project:

- **There is no `.dmg` in the repository.** A DMG is Apple's disk-image format
  and only Apple's `hdiutil` writes one, which means only a Mac can produce it.
  What ships instead is the working `.app` plus `packaging/mac/make-dmg.command`,
  which builds the real disk image in one step on any Mac.
- **The `.ipa` cannot be made installable here.** iOS runs nothing unsigned, and
  nothing at all without a Mach-O binary from Apple's compiler. The file in
  `artifacts/` is the packaging shape, so the signing step has everything except
  the two things only macOS can give it; `START-HERE.md` inside it has the
  commands.
- **None of the installers are code-signed.** Windows SmartScreen and macOS
  Gatekeeper will both want a right-click → Open the first time. Signing needs a
  paid certificate from each vendor.

The landing page is plain HTML and CSS in `site/`. `node
packaging/site/build-site.js` stages it (and checks that every link in it
resolves to a file that exists), and the staged folder is what gets uploaded.

To build every artifact at once:

```bat
npm install
npm run build:all
```

`npm install` pulls Electron once, for the app. AirChat itself still has **zero
runtime dependencies** — nothing in `server/` or `ui/` imports anything.

---

## How it works

```
server/
  index.js      HTTP API, WebSocket hub, webhooks, invite links
  ws.js         a small dependency-free WebSocket server (RFC 6455)
  store.js      all data, in data/airchat.json, written atomically
  router.js     one send -> AirChat + the thread's mirror channel
  config.js     defaults <- config.json <- environment variables
  link-status.js whether a friend can reach this copy, as one shared fact
  icons.js      draws the app icons as real PNGs, using only zlib
  adapters/
    mock.js         pretends to deliver, so you can test for free
    bluebubbles.js  real iMessage, through your Mac
    twilio.js       real SMS
    telegram.js     real Telegram, via long polling
ui/
  index.html, styles.css, app.js   the whole interface, no build step
  crypto.js                        end-to-end encryption, in the browser
  manifest.webmanifest             makes AirChat installable to a phone
  sw.js                            offline shell + notification handling
tools/
  start-app.cmd the one door every launcher uses: open the app, whatever it is
  tray.ps1      the icon by the clock when the app runs with no window
  tunnel.js     the public link on its own, for a server with no Electron
  zip.js        a zip writer, so the macOS and iOS artifacts keep their modes
  make-icon.js  turns the drawn icon into the .ico and .png the installers read
desktop/
  main.js       the app: the window, the server inside it, and its public link
  starting.html the screen shown for the second before the interface can be
  preload.js    the little the interface is told about the app it runs in
packaging/
  mac/          builds AirChat.app, and builds a real .dmg on a Mac
  ios/          builds the unsigned iOS payload to sign
  windows/      builds the .exe installer with IExpress, which Windows has
  site/         stages the landing page for upload
site/
  index.html, styles.css, icon.png  the landing page, no build step
artifacts/
  the built downloads, straight from the scripts above
```

The app icons are worth a note: a phone home screen needs a PNG, but instead of
committing binaries the server *renders* them at `/icon-512.png` with Node's
`zlib`. The icon is source code, so it can never drift from the brand colours.
`npm run doctor` decodes one and checks its CRCs to prove the encoder works.

**Adding a network** means writing one file in `server/adapters/`. It needs a
`send()`, a `configured()` and a `describe()`, then one line in
`server/adapters/index.js`. Nothing else in the app changes.

Encryption lives entirely in `ui/crypto.js`, which the browser loads alongside
`app.js`. It is deliberately not a server feature: the server could not decrypt a
message even if it wanted to, because it never has the key. `router.js` treats an
encrypted body as opaque — it will not hand cipher text to a phone network, and it
refuses to shorten one.

### A note on security

You are running a web server on your own PC, so:

- A direct request from **this computer** is always trusted.
- Requests from **anywhere else** need either your full-access token, or a
  per-chat guest invite. That includes anything arriving through a tunnel:
  cloudflared connects to AirChat from this same machine, so AirChat looks for
  the forwarding headers a tunnel adds rather than trusting the address it sees.
- Opening an invite link also sets a cookie, because an installed app reopens
  from a Dock icon or home screen with no link in the URL (Safari keeps cookies
  in such an app but does not share localStorage). Clearing the site's data
  forgets it, and a revoked invite stops working even if the cookie remains.
- Webhook routes deliberately skip that check, because Twilio and BlueBubbles
  cannot present your token. Keep your tunnel URL private.
- `config.json`, `data/` and `node_modules/` are gitignored. `config.json`
  holds your Twilio and BlueBubbles secrets — do not commit or share it.
- Message **text** is protected end to end in AirChat-only chats (see
  **Encryption** above). Everything else — invites, the owner's full-access link,
  and the traffic itself — is protected by the invite check plus the tunnel's
  https. Treat the full-access link like your password.

---

## Troubleshooting

**`npm run doctor` did not seem to do anything**
Double-click **`Check AirChat.bat`** instead. It runs the same health check and
keeps the window open so you can read the result.

**Blank page / "You need an invite link"**
You opened the port without the token. Use the address printed in the terminal
window, which includes `?token=…`.

**It seemed to open and then close straight away**
It cannot any more: opening AirChat always leaves a window on screen. A second
copy adds a window onto the one that is running instead of quitting, and a start
that fails shows a screen with a **Try again** button rather than disappearing. If
you still see it, send `%APPDATA%\AirChat\airchat-app.log`
(`~/Library/Application Support/AirChat/airchat-app.log` on a Mac) — it records
every start, close and crash with the code that asked for it.

**Something else is using AirChat's port**
Nothing to do: AirChat uses its own port when it can have it, and moves to a free
one when it cannot. The window, its invite links and the tray icon all follow it
there, and no screen in the app mentions a port number.

**Messages show a red "Failed" note**
Hover the chat header — it tells you which channel is not set up. Or run
`npm run doctor` and read the channel lines.

**My friend's link does not open**
Without `publicUrl` set, links only work on the same Wi-Fi. See "From anywhere"
above.

**My friend's home-screen icon says "you need an invite link"**
The invite is remembered per device. If they cleared site data or use a private
tab, send them the link again — it is the same link as before.

**Notifications never appear on an iPhone**
They must turn them on from the **installed** icon, not from Safari. iOS only
permits web notifications for home-screen apps. Check **Settings → Alerts** shows
"On".

**The link stopped working / `ERR_NAME_NOT_RESOLVED`**
Quick tunnel addresses are random and change every run, and stop existing when
the process that opened them closes — that is the price of needing no account.
The app opens a fresh one at every launch and forgets the old one, so restart it
and send the new link. Running the server by hand instead? Restart
`node tools/tunnel.js`. A permanent address needs one free Cloudflare account
(see above).

**I want to start over**
Close AirChat and delete `%APPDATA%\AirChat\home\data\airchat.json`
(`~/Library/Application Support/AirChat/home/data/airchat.json` on a Mac). You
will get the demo chats back. Running the server from a folder instead? It is
`data/airchat.json` next to the code.

---

## What is not built yet

Being straight about the edges:

- **Group chat mirroring.** Groups work inside AirChat, but mirroring a group to
  iMessage/SMS/Telegram is not supported yet — those are per-person networks and
  a real group thread needs more work (BlueBubbles group chat creation).
- **Real accounts.** Anyone you invite shares your one server. Fine for a few
  friends, not a multi-tenant product.
- **Read receipts from SMS.** Twilio reports delivery, but not reading. iMessage
  via BlueBubbles does give you read receipts.
- **The Android SMS gateway adapter.** The only free route to a friend's real
  Messages app, and a short job — see **Android phone as a gateway** above.
- **Background push when the app is closed.** Notifications work while AirChat is
  running (installed or in a tab). True push while it is fully closed needs one
  small dependency (`web-push`) and a service-worker subscription.
- **Attachments.** Text only so far. Images and files are the obvious next thing.
- **Key ratcheting (forward secrecy).** An encrypted chat uses one key for its
  whole life instead of replacing it as you go, so a device compromised later can
  still read what it already received. Doing this properly is a Signal-sized job,
  and pretending otherwise would be the wrong kind of quiet.
- **Hiding the metadata.** The server still cannot avoid knowing which chats
  exist and when they were active, even though it cannot read a word of them.
