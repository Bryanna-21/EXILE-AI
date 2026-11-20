import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsRetry from "./fs-retry.cjs";
const { renameSyncRetry } = fsRetry;

const STORE = path.join(os.homedir(), ".exile-ai", "whatsapp-conversations.json");
const MAX_HISTORY = 40;
const MAX_PROCESSED_IDS = 1200;
const MAX_CONTACTS = 500;

let state = { enabled: false, contacts: {} };
let generationEpoch = 0;
let generateReply = null;
let sendMessage = null;
let sendMedia = null;
const queues = new Map();
const inFlightMessages = new Set();

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (saved && typeof saved === "object") {
      state = {
        enabled: saved.enabled === true,
        contacts: saved.contacts && typeof saved.contacts === "object"
          ? saved.contacts
          : {},
      };
    }
  } catch {
    // First run: the feature is deliberately disabled.
  }
}
loadState();

function persist() {
  const directory = path.dirname(STORE);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${STORE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    renameSyncRetry(fs, temporary, STORE);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function validJid(value) {
  const jid = String(value || "");
  return /^\d+(?:-\d+)?@(s\.whatsapp\.net|g\.us|lid)$/.test(jid);
}

function contactFor(jid) {
  let contact = state.contacts[jid];
  if (!contact || typeof contact !== "object") {
    const entries = Object.entries(state.contacts);
    if (entries.length >= MAX_CONTACTS) {
      entries.sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0));
      for (const [oldJid] of entries.slice(0, entries.length - MAX_CONTACTS + 1)) {
        delete state.contacts[oldJid];
      }
    }
    contact = { history: [], processedIds: [], updatedAt: Date.now() };
    state.contacts[jid] = contact;
  }
  if (!Array.isArray(contact.history)) contact.history = [];
  if (!Array.isArray(contact.processedIds)) contact.processedIds = [];
  return contact;
}

function isQuestionForGroup(text) {
  return /\b(exile(?:\s+ai)?|what|why|how|when|where|who|which|explain|define|solve|calculate|summari[sz]e|compare|differentiate|discuss|help|answer|derive|prove|list|state|describe)\b/i.test(text)
    || text.includes("?");
}

export function configureWhatsAppConversationAI({ generate, send, sendMedia: sendAttachment }) {
  generateReply = typeof generate === "function" ? generate : null;
  sendMessage = typeof send === "function" ? send : null;
  sendMedia = typeof sendAttachment === "function" ? sendAttachment : null;
}

export function getWhatsAppConversationAIConfig() {
  return { enabled: state.enabled };
}

export function updateWhatsAppConversationAIConfig(input) {
  if (!input || typeof input.enabled !== "boolean") {
    throw new Error("The enabled field must be a boolean.");
  }
  if (state.enabled !== input.enabled) generationEpoch++;
  state.enabled = input.enabled;
  persist();
  return getWhatsAppConversationAIConfig();
}

async function processIncoming(item, jid, text, eventEpoch, media) {
  if (!state.enabled || eventEpoch !== generationEpoch) {
    return { skipped: true, reason: "disabled-or-cancelled" };
  }

  const group = jid.endsWith("@g.us");
  if (group && !media && !isQuestionForGroup(text)) {
    return { skipped: true, reason: "not-a-group-question" };
  }

  const contact = contactFor(jid);
  const id = String(item.id);
  if (contact.processedIds.includes(id)) {
    return { skipped: true, duplicate: true };
  }

  contact.processedIds.push(id);
  contact.processedIds = contact.processedIds.slice(-MAX_PROCESSED_IDS);
  contact.history.push({
    role: "user",
    content: text.slice(0, 4000),
    at: Date.now(),
  });
  contact.history = contact.history.slice(-MAX_HISTORY);
  contact.updatedAt = Date.now();
  persist();

  if (!generateReply || !sendMessage) {
    console.warn("[WhatsApp conversation AI] Generator or sender is unavailable.");
    return { skipped: true, reason: "service-unavailable" };
  }

  const name = String(item.name || "WhatsApp contact").slice(0, 100);
  let reply;

  try {
    reply = await generateReply({
      jid,
      name,
      incomingText: text.slice(0, 4000),
      history: contact.history.map(({ role, content }) => ({ role, content })),
      isGroup: group,
      media,
    });
  } catch (error) {
    console.error("[WhatsApp conversation AI] Generation failed:", error.message);

    // Do not send a fallback if the feature was disabled during generation.
    if (eventEpoch !== generationEpoch || !state.enabled) {
      return { skipped: true, reason: "disabled-before-fallback" };
    }

    const fallbackText = typeof error?.userMessage === "string" && error.userMessage.trim()
      ? error.userMessage.trim().slice(0, 600)
      : media
        ? `I received your ${media.type}, but I cannot analyze it right now. Please try again shortly.`
        : "I received your message, but my AI service is temporarily unavailable. Please try again shortly.";

    try {
      await sendMessage(jid, fallbackText);
      contact.history.push({
        role: "assistant",
        content: fallbackText,
        at: Date.now(),
      });
      contact.history = contact.history.slice(-MAX_HISTORY);
      contact.updatedAt = Date.now();
      persist();
      console.info("[WhatsApp conversation AI] Availability fallback sent.");
      return { sent: true, fallback: true };
    } catch (sendError) {
      console.error("[WhatsApp conversation AI] Fallback send failed:", sendError.message);
      return { sent: false, reason: "generation-failed" };
    }
  }

  const attachmentReply =
    reply && typeof reply === "object" && reply.attachment &&
    typeof reply.attachment.dataUrl === "string" &&
    typeof reply.attachment.filename === "string";

  const replyText = typeof reply === "string"
    ? reply.trim().slice(0, 4000)
    : typeof reply?.text === "string"
      ? reply.text.trim().slice(0, 1000)
      : "";

  if (
    eventEpoch !== generationEpoch ||
    !state.enabled ||
    !replyText ||
    (attachmentReply && typeof sendMedia !== "function") ||
    (!attachmentReply && typeof reply !== "string")
  ) {
    return { skipped: true, reason: "disabled-before-send" };
  }

  if (attachmentReply) {
    const filename = reply.attachment.filename;
    const caption = String(reply.attachment.caption || replyText).slice(0, 4000);

    // Do not send an attachment unless its queued state was recorded.
    try {
      if (typeof reply.attachment.onQueued === "function") {
        await reply.attachment.onQueued();
      }
    } catch (error) {
      console.error(
        "[WhatsApp conversation AI] Could not record queued artifact delivery; attachment not sent:",
        error.message,
      );

      const notice =
        `I created "${filename}" but couldn't safely prepare delivery tracking, so I did not send it. It remains in EXILE's Artifacts.`;

      try {
        await sendMessage(jid, notice);
      } catch (noticeError) {
        console.error(
          "[WhatsApp conversation AI] Could not send delivery-preparation notice:",
          noticeError.message,
        );
      }

      return { sent: false, reason: "delivery-record-failed", artifactRetained: true };
    }

    // Treat only the media sender's explicit confirmation as successful delivery.
    try {
      const outcome = await sendMedia(
        jid,
        reply.attachment.dataUrl,
        filename,
        caption,
      );

      if (outcome?.sent !== true) {
        throw new Error("WhatsApp did not confirm the attachment was sent.");
      }
    } catch (error) {
      console.error("[WhatsApp conversation AI] Attachment send failed:", error.message);

      // A failed status update must not prevent an honest notice to the contact.
      try {
        if (typeof reply.attachment.onFailed === "function") {
          await reply.attachment.onFailed(error.message);
        }
      } catch (hookError) {
        console.error(
          "[WhatsApp conversation AI] Could not record failed artifact delivery:",
          hookError.message,
        );
      }

      const notice =
        `I created "${filename}" but couldn't deliver it as an attachment. It is saved in EXILE's Artifacts.`;

      try {
        await sendMessage(jid, notice);
        contact.history.push({ role: "assistant", content: notice, at: Date.now() });
        contact.history = contact.history.slice(-MAX_HISTORY);
        contact.updatedAt = Date.now();

        try {
          persist();
        } catch (historyError) {
          console.error(
            "[WhatsApp conversation AI] Could not persist attachment-failure notice history:",
            historyError.message,
          );
        }
      } catch (noticeError) {
        console.error(
          "[WhatsApp conversation AI] Could not send attachment-failure notice:",
          noticeError.message,
        );
      }

      return { sent: false, reason: "send-failed", artifactRetained: true };
    }

    // WhatsApp has confirmed the send. Finalization is bookkeeping only:
    // it must never turn a confirmed send into a reported transport failure.
    try {
      if (typeof reply.attachment.onSent === "function") {
        await reply.attachment.onSent();
      }
    } catch (error) {
      console.error(
        "[WhatsApp conversation AI] Attachment was sent, but delivery status finalization failed; reconciliation is required:",
        error.message,
      );
    }

    contact.history.push({
      role: "assistant",
      content: `${replyText}\n[File sent: ${filename}]`,
      at: Date.now(),
    });
    contact.history = contact.history.slice(-MAX_HISTORY);
    contact.updatedAt = Date.now();

    try {
      persist();
    } catch (error) {
      console.error(
        "[WhatsApp conversation AI] Attachment was sent, but conversation history could not be persisted:",
        error.message,
      );
    }

    console.info("[WhatsApp conversation AI] File sent.");
    return { sent: true, attachment: filename };
  }

  try {
    await sendMessage(jid, replyText);

    contact.history.push({
      role: "assistant",
      content: replyText,
      at: Date.now(),
    });
    contact.history = contact.history.slice(-MAX_HISTORY);
    contact.updatedAt = Date.now();
    persist();

    console.info("[WhatsApp conversation AI] Reply sent.");
    return { sent: true };
  } catch (error) {
    console.error("[WhatsApp conversation AI] WhatsApp reply send failed:", error.message);
    return { sent: false, reason: "send-failed" };
  }
}


export async function handleWhatsAppConversationIncoming(item) {
  const jid = String(item?.jid || "");
  const id = String(item?.id || "");
  const media = item?.media &&
    ["image", "video"].includes(item.media.type) ? item.media : null;
  let text = String(item?.text || "").trim();

  if (media && /^\[(image|video)\]$/i.test(text)) {
    text = media.type === "image"
      ? "Please analyze this image."
      : "Please analyze this video.";
  }

  if (
    !state.enabled ||
    !id ||
    !validJid(jid) ||
    (!text && !media) ||
    (!media && /^\[[^\]]+\]$/.test(text))
  ) {
    return { skipped: true };
  }

  const eventKey = `${jid}:${id}`;
  if (inFlightMessages.has(eventKey)) {
    return { skipped: true, duplicate: true };
  }

  inFlightMessages.add(eventKey);
  const eventEpoch = generationEpoch;
  const previous = queues.get(jid) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => processIncoming(item, jid, text, eventEpoch, media));

  queues.set(jid, task);
  try {
    return await task;
  } finally {
    inFlightMessages.delete(eventKey);
    if (queues.get(jid) === task) queues.delete(jid);
  }
}
