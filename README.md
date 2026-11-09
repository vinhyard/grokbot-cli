# grokbot

Unofficial command-line tool for the bots in the Grok Bot desktop app.
It lists the bots on your account, reads a thread, sends one message, and can create or update a bot.
It is not a vendor product, and nothing here says the vendor approves it.
It is not affiliated with or endorsed by the vendor.

## Requirements

- macOS.
- Node.js 22 or later.
- The Grok Bot desktop app, installed and signed in to your account.

Other operating systems are refused.

## Install

Clone the repository and link the command:

```sh
git clone https://github.com/vinhyard/grokbot-cli.git
cd grokbot-cli
npm link
```

`npm link` puts `grokbot` on your PATH.
You can also run `node bin/grokbot.mjs` from the clone.
Runtime dependencies: none.
Node.js 22 and the built-in `fetch` are enough.

## Quick start

Sign in with the Grok Bot desktop app, then check the setup and list your bots:

```sh
grokbot doctor
grokbot bots
grokbot thread alpha
grokbot send alpha "hello"
```

## Commands

```text
grokbot bots [--json]
grokbot thread <bot id|name> [--limit N] [--json]
grokbot send <bot id|name> <text|-> [--wait S] [--dry-run]
grokbot bot create --name <name> --instructions-file <file> --yes
grokbot bot update <bot id|name> --instructions-file <file> [--name <name>] --yes
grokbot doctor
```

Run `grokbot --help` for the same summary.

### bots

List the bots on your account.

```sh
grokbot bots
grokbot bots --json
```

### thread

Read one bot's thread.

```sh
grokbot thread alpha
grokbot thread alpha --limit 20 --json
```

### send

Send one message to one of your bots.

```sh
grokbot send alpha "hello"
grokbot send alpha - --wait 30
grokbot send alpha "hello" --dry-run
```

`send` refuses a target that is not one of your account's bots.
The message is one argument, or `-` to read stdin, and must be at most 16 KiB.
One trailing newline is removed from stdin.
There is no bulk send and no retry after a send that may have been accepted.
`--dry-run` prints the target and the text and does not call the send endpoint.
`--wait` is at most 120 seconds and checks for a new bot reply every 3 seconds.
Each of those checks stops when the remaining wait runs out.

### doctor

Report whether your account can be used.

```sh
grokbot doctor
```

`doctor` reports pass or fail for the account file, the keychain item, decryption, and the sandbox route.
It does not print secrets.

### bot create

Create a bot.
This command is experimental.
It requires `--yes`.

```sh
grokbot bot create --name alpha --instructions-file instructions.txt --yes
```

### bot update

Replace a bot's instructions, and optionally its name.
This command is experimental.
It requires `--yes`.

```sh
grokbot bot update alpha --instructions-file instructions.txt --yes
grokbot bot update alpha --name beta --instructions-file instructions.txt --yes
```

`bot create` and `bot update` are experimental.
Both require `--yes`.
They print the target and the instruction byte count first.
The instructions file must be at most 64 KiB.
Instructions are sent as the agent description through the same `createAgent` / `updateAgent` calls the gateway already uses.
Try them only when you mean to change a bot.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ok. The command succeeded. |
| 1 | Not sent. The send request was never issued. |
| 3 | Sent, but the wait failed. The service accepted the message. A wait timeout, a poll error, or the read budget uses 3. Do not resend. |
| 4 | Delivery unknown. The request was issued, but the outcome was a timeout, a reset, an unreadable or oversized body, an HTTP error, or an unknown delivery code. Do not resend. |

Exit codes are 0 when the command succeeds, and 1 only when the send request was never issued.
Code 3 means the service accepted the message and it must not be resent; a wait timeout, a poll error, or the read budget uses 3.
Code 4 means delivery is unknown and the message must not be resent: the request was issued, but the outcome was a timeout, a reset, an unreadable or oversized body, an HTTP error, or an unknown delivery code.

## Credentials

The only credential source is the macOS keychain item `Grok Bot Safe Storage`, read at run time.
The account file under Application Support supplies the encrypted blob; the tool decrypts it in memory.
Tokens are kept in memory only.
Tokens are not written to files, logs, or command output, and they are redacted from output.
There is no token flag, no token environment variable, and no prompt.
Other operating systems are refused.

Backend requests go only to HTTPS hosts on `cursor.sh` or `cursor.com`.
The gateway URL the backend returns may also be an HTTPS host on `cursorvm.com`.
Authenticated requests do not follow redirects.

## Limitations and risks

Send uses an undocumented backend call (`SendGrokBotUserMessage`).
The vendor can change or block that call at any time.
The call can break or be refused.

The tool sends the app's client-type header and the installed Grok Bot version because the backend rejects unknown versions.
The version comes from `GROKBOT_CLIENT_VERSION` when that is a valid version, otherwise from the installed app (`desktop-status.json`, then the app bundle), and otherwise falls back to 0.20.0.
It sends no source field and no ghost-mode or client-source header.

When the tool breaks, run `grokbot doctor`, check the installed app version, and report the failure or use the app.
When send stops working, open the bot on the grok.com page in a browser and send from there.

## Development

Tests use a local fake server and run in GitHub Actions (`node --test`).
Do not point this tool at a live account from a test.
Do not paste or commit credentials.

## License

Released under the MIT License.
See [LICENSE](LICENSE).
Copyright (c) 2026 vinhyard.
