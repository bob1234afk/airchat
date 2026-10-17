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

## The free plan: no money, no accounts

Everything in this section needs nothing from anyone — no card, no signup, no
third party.

**1. Start it with a public link.**

```bat
Start AirChat + Public Link.bat
```

That opens a free Cloudflare Quick Tunnel (Cloudflare's own docs: *no Cloudflare
account or domain required*), saves the public address into `config.json`, starts
AirChat, and prints the exact link to send each friend. No tunnel installed? It
tells you the one `winget` line, then carries on over your Wi-Fi only.

No cloudflared at all yet? Double-click **`Install Cloudflared (one time).bat`**
once. Or download `cloudflared-windows-amd64.exe` from the
[releases page](https://github.com/cloudflare/cloudflared/releases/latest), rename
it to `cloudflared.exe`, and drop it in this folder — AirChat will use it.

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

2. **Start it.** Double-click **`Start AirChat.bat`**, or in a terminal:

   ```bat
   cd AirChat
   npm start
   ```

   Your browser opens at <http://localhost:4000> and already has two demo chats
   in it so you can see how it works.

   To let a friend reach it from outside your house, use
   **`Start AirChat + Public Link.bat`** instead — see **The free plan** above.

3. **Check it is healthy** if anything looks off:

   ```bat
   npm run doctor
   ```

   This parses every file, loads every server module, checks that the interface
   and the code agree on element names, and confirms the port is free.

### Keep it out of the way

Double-click **`Start AirChat in Tray.bat`**. It starts the server *and* the
public link, hands them to Windows, and closes itself: AirChat then has no window
at all — just an icon next to the clock. Closing that launcher window, or any
window, stops nothing. Double-clicking it again replaces the running copy
instead of fighting it for the port.

It deliberately does **not** open a browser tab: the tray icon is the way in.
Double-click the icon to open AirChat; right-click it to copy the friend links,
open the log, or stop AirChat. With no console to read, everything AirChat has to
report — starting, running, stopped, a link that would not open — arrives as a
tray balloon or a small dialog, and the full output is in `airchat-tray.log`.

If you would rather watch it happen, `Start AirChat + Public Link.bat` still runs
in a normal window you can sit in front of.

### On a Mac

AirChat runs on a Mac as well, with the same two launchers:

- **`Start AirChat (Mac).command`** — starts AirChat at <http://localhost:4000>.
- **`Start AirChat + Public Link (Mac).command`** — also opens the free public link.

The first time, macOS may refuse to open a `.command` file that is not marked
executable. Open Terminal in this folder and run this once:

```sh
chmod +x "Start AirChat (Mac).command" "Start AirChat + Public Link (Mac).command"
```

Then double-click it like any other app. `npm run doctor` works on macOS too.

### Want it as a real app window?

```bat
npm install
Start AirChat Window.bat
```

That installs Electron (~100 MB, one time) and gives you a proper desktop window
with no browser chrome. AirChat works perfectly in a browser without it.

---

## Talking to your friend

### The same Wi-Fi (30 seconds, free)

Click **Invite** in a chat. It gives you a link like
`http://192.168.1.20:4000/?guest=…`. Text that link to your friend. They open it
on their phone and they are in that one conversation — nothing to install.

Browsers only allow encryption on a secure address: `https://`, or `localhost`.
A plain `http://192.168.x.x` page therefore cannot lock a single message. When
the public link is running, AirChat quietly forwards a Wi-Fi visitor to it —
the invite and the `#k=…` key travel with them — so the Wi-Fi link still ends up
in the encrypted chat. With no public link there is nowhere safe to go, and
AirChat says so instead of appearing to work: read that chat over `https://`.

### From anywhere (free, still your laptop)

Your laptop is not reachable from the internet by default. A tunnel fixes that
for free and with no account:

1. Once only: **`Install Cloudflared (one time).bat`**
2. Every time: **`Start AirChat + Public Link.bat`** (or the tray launcher)

The launcher opens a Cloudflare Quick Tunnel, saves the `https://something.trycloudflare.com`
address as `publicUrl`, and prints the link to send each friend. Invite links will
then work from anywhere. Your laptop still does all the work.

**That address lives exactly as long as that window does.** Close the window,
stop it from the tray, or restart the PC, and the tunnel is gone — a friend who
taps the old link sees `ERR_NAME_NOT_RESOLVED` / "server IP address could not be
found". Nothing is broken and nothing was hacked; the address simply stopped
existing. Start the launcher again and send the new link.

AirChat knows this, so it will not pretend otherwise: while the tunnel runs it
refreshes a "this link is still alive" stamp every 20 seconds, clears the link
when it stops, and refuses to hand out one whose stamp has gone quiet. The Invite
window says the public link expired instead of offering one that cannot open.
The same stamp lets a running AirChat pick up an address that appears after it
started, so starting the tunnel second no longer leaves Invite handing out a
Wi-Fi-only link for the rest of the session.

The launcher also looks after the two things that used to send friends to a dead
link. If an older AirChat still holds the port, it stops that copy *before*
opening a tunnel, so no address is ever saved without a server behind it. Then,
after AirChat is up, it asks the internet whether the new address answers and
says so in the window — `the link answers` means that is the address to send.

**Copy the link from Invite, not from the terminal window.** The launcher can
print the address, but the key that unlocks an encrypted chat only exists in your
browser, so a link printed by the terminal opens the chat with nothing to unlock
it. The Invite window is the copy that carries the key.

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

## How it works

```
server/
  index.js      HTTP API, WebSocket hub, webhooks, invite links
  ws.js         a small dependency-free WebSocket server (RFC 6455)
  store.js      all data, in data/airchat.json, written atomically
  router.js     one send -> AirChat + the thread's mirror channel
  config.js     defaults <- config.json <- environment variables
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
  tunnel.js     free public link, then starts the server
desktop/
  main.js       optional Electron window
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

**"Port 4000 is already in use"**
AirChat is probably already running. Close the other window, or change `port` in
`config.json`.

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
the window that opened them closes — that is the price of needing no account.
Re-run `Start AirChat + Public Link.bat` and send the new link. A permanent
address needs one free Cloudflare account (see above).

If the launcher reports **"Port 4000 is already in use"**, AirChat is already
running somewhere else — probably a window you forgot about. That second copy
briefly got its own public address and then died, so use the copy that is still
running (or close it and start one fresh). Two copies cannot share a link.

**I want to start over**
Close AirChat and delete `data/airchat.json`. You will get the demo chats back.

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
