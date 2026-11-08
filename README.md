# grokbot

Private, unofficial terminal tool for the bots on the captain's Grok Bot app account. It lists bots, reads a thread, sends one message, and can create or update a bot. It is not a vendor product, and nothing here says the vendor approves it.

Send uses an undocumented backend call (`SendGrokBotUserMessage`). The vendor can change or block that call at any time. When send stops working, open the bot on the grok.com page in a browser and send from there.

## Credentials

The only credential source is the macOS keychain item `Grok Bot Safe Storage`, read at run time. The account file under Application Support supplies the encrypted blob; the tool decrypts it in memory. Tokens are not written to files, logs, or command output. There is no token flag, no token environment variable, and no prompt. Other operating systems are refused.

Requests go only to HTTPS hosts on `cursor.sh` or `cursor.com`, and to the gateway URL that the account's own backend returns when that URL is also an HTTPS host on those domains. Authenticated requests do not follow redirects.

## Identity

The tool does not claim to be the desktop app. The send body leaves the source field unset, and it does not send a desktop-client or privacy-mode header.

## Commands

```text
grokbot bots [--json]
grokbot thread <bot id|name> [--limit N] [--json]
grokbot send <bot id|name> <text|-> [--wait S] [--dry-run]
grokbot bot create --name <name> --instructions-file <file> --yes
grokbot bot update <bot id|name> --instructions-file <file> [--name <name>] --yes
grokbot doctor
```

`send` refuses a target that is not one of the account's bots. The message is one argument, or `-` to read stdin, and must be at most 16 KiB. There is no bulk send and no retry after a send that may have been accepted. `--dry-run` prints the target and the text and does not call the send endpoint. `--wait` is at most 120 seconds and checks for a new bot reply every 3 seconds.

`bot create` and `bot update` are experimental, untested against the live service. Both require `--yes`. They print the target and the instruction character count first. Instructions are sent as the agent description through the same `createAgent` / `updateAgent` calls the gateway already uses. Try them only when you mean to change a bot.

`doctor` reports pass or fail for the account file, the keychain item, decryption, and the sandbox route. It does not print secrets.

## Tests

Runtime dependencies: none. Node.js 22 and the built-in `fetch` are enough. Tests use a local fake server and run in GitHub Actions (`node --test`). Do not point this tool at a live account from a test.
