# ChatScreen

A modular chat experience for EXILE AI's conversation page. It is an enhancement of the existing
Home feed and composer; the sidebars, background, header, reactor, tiles, AI engine, ARC, memory,
voice, approvals and security code are untouched.

## Where it connects

`src/pages/Index.tsx` is the only existing component that was changed.

| Existing place | What it renders now |
| --- | --- |
| `<main>` – conversation feed (was a hand-rolled `turns.map`) | `<ChatMessages turns busy emptyLabel statusLabel onReply onEditSave onResend onRegenerate onDelete />` |
| `<footer>` – attachment chips, error line and input form | `<ChatComposer value onChange onSend busy attachments … />` (the Home tiles and tagline stay) |
| `ask()` | Renamed `runAsk`, with options `{ reuse, replyTo }`; a thin `ask()` wrapper allows one reply at a time |
| Golden Canvas panel | Shows progress and errors only; finished images appear in the chat bubble |

Both components are exported from `@/components/chat/ChatScreen`, along with a small `ChatScreen`
composite for use on a page that has no pre-existing layout.

## Data

- `TranscriptTurn` gained three optional fields (`replyTo`, `edited`, `fallback`). Old saved
  conversations load unchanged. `src/lib/conversation.ts` gained `patchTurn`, `truncateAfter`,
  `restoreTurn`; existing functions are unchanged.
- Attachments and generated images live in `src/lib/chat/mediaStore.ts` (in memory, keyed by message id).

## Files

New: `src/components/chat/{ChatScreen,ChatMessages,MessageBubble,ChatComposer,CodeBlock,FileCard,ImageCard}.tsx`,
`chat.css`, `src/lib/chat/{parse,languages,highlight,files,ops,dom,mediaStore}.ts`, `test/chat-lib.test.mjs`.
Modified: `src/pages/Index.tsx`, `src/lib/conversation.ts`.

## Behaviour notes and limits

- Edit, Resend and Regenerate replace every message after the one being re-run. Regenerate is offered on the latest answer only.
- Delete removes one message and offers Undo for a few seconds.
- Attachment and image previews are not kept after a page reload (too large for localStorage). Message text is.
- Highlighting covers JS/TS/JSX/TSX, Python, HTML/XML, CSS, JSON, SQL, Java, C/C++, Go, Rust, YAML and Markdown; other languages are shown unhighlighted with their name.
- PDF preview uses the browser's own PDF viewer; the extracted text is available as a fallback.
- Copy image needs a browser that supports the async clipboard for images and permission to use it.
- There is no Stop-generation button; the existing engine has no cancel path wired to the UI.
