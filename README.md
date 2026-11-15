# UO · Chat Reactions

**English** · [Русский](README.ru.md)

Emoji reactions under any chat message in Foundry VTT: a line, a roll, an item
or spell card. The number next to an emoji is how many people gave it; hover
to see who. A star saves the message to your own favourites journal.

![Reactions under chat messages, with the names on hover](docs/chat.png)

## Installation

In Foundry's **Install Module** dialog, paste the manifest URL:

```
https://github.com/Nikifour/uo-chat-reactions/releases/latest/download/module.json
```

- Foundry VTT **v13–v14**, **any game system**, no other modules required.
- The interface is in **English and Russian** and follows Foundry's language.
- A guide ships with the module as a compendium: *Chat Reactions · How to use*.

## How to react

- Hover over a message: a smiley appears in its header, next to the time.
  Click it and choose an emoji.
- Click an emoji under a message to add the same one or take yours back.
  Your own reactions are highlighted in gold.
- One message can have several emoji.

![The emoji picker](docs/picker.png)

## Favourites

The star next to the smiley saves the message to your journal
**"Favourites: your name"** in the "Favourites" folder: when it was said and
what; for a roll, the formula and the total. The journal is yours — you and
the GM can see it, everyone else cannot.

How entries are arranged into pages is everyone's own choice:

- **a page for each speaker** (the default) — everything one character said
  on one page. A hero is recognised by their sheet, so a renamed token does
  not split the page in two;
- **a page for each participant** — everything from one player or GM, with
  all of their characters, on one page; every entry says who was speaking;
- **a page for each message**.

![A favourites journal, one page for each speaker](docs/favourites.png)

On a shared page entries run in the order the messages were sent. An entry
is a copy, not a link: if the message is deleted or the chat is cleared, it
stays. Click the star again to remove the message — only its entry leaves
the page. The same is in the message's right-click menu.

A whisper can be saved only by those it was addressed to, a blind roll only
by the GM.

## How it works

Reactions are stored as a flag on the message itself, one entry per
participant, so two reactions at the same moment never overwrite each other,
and everything is still there after a reload.

Foundry does not let players change other people's messages, so such a
reaction is recorded by the active GM: the request goes to the GM's client
over the module's socket. The sender is identified by the Foundry server,
so nobody can react in someone else's name. With no GM in the game you can
react only to your own messages.

Players cannot create journals either, so the first favourite is written by
the GM's client, which creates the journal and gives it to the player. After
that the player writes to their journal directly.

## Settings

*Game Settings → Configure Settings → UO · Chat Reactions*:

| Setting | Default | What it does |
|---|---|---|
| Reaction set | 👍 👎 😂 😮 😢 😡 ❤️ 🔥 🎲 💀 | the emoji in the picker, separated by spaces |
| Favourites: pages (per user) | a page for each speaker | how favourites are arranged in your journal |

Emoji removed from the set stay under the messages where they were already
given, and you can always take yours back.

## License

Free to use in your games; redistribution and resale are not allowed.
See [LICENSE](LICENSE).
