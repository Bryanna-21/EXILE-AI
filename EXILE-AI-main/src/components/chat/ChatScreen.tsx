import type { ComponentProps } from "react";
import ChatMessages from "./ChatMessages";
import ChatComposer from "./ChatComposer";

export { ChatMessages, ChatComposer };
export type { ChatMessagesProps } from "./ChatMessages";
export type { ChatComposerProps, ComposerAttachment } from "./ChatComposer";

/**
 * Standalone chat screen: message list above a composer. EXILE's home page renders the two parts
 * separately (inside its own <main> and <footer>) so its existing layout is untouched.
 */
const ChatScreen = ({ messages, composer }: { messages: ComponentProps<typeof ChatMessages>; composer: ComponentProps<typeof ChatComposer> }) => (
  <div className="flex h-full min-h-0 w-full flex-col items-center gap-2">
    <ChatMessages {...messages} />
    <div className="w-full shrink-0"><ChatComposer {...composer} /></div>
  </div>
);

export default ChatScreen;
