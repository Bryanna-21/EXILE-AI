import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(os.homedir(), ".exile-ai", "whatsapp-conversations.json");
const MAX_HISTORY = 40;
const MAX_PROCESSED_IDS = 1200;
const MAX_CONTACTS = 500;

let state = { enabled: false, contacts: {} };
let generationEpoch = 0;
let generateReply = null;
let sendMessage = null;
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
    fs.renameSync(temporary, STORE);
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

export function configureWhatsAppConversationAI({ generate, send }) {
  generateReply = typeof generate === "function" ? generate : null;
  sendMessage = typeof send === "function" ? send : null;
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

async function processIncoming(item, jid, text, eventEpoch) {
  if (!state.enabled || eventEpoch !== generationEpoch) {
    return { skipped: true, reason: "disabled-or-cancelled" };
  }

  const group = jid.endsWith("@g.us");
  if (group && !isQuestionForGroup(text)) {
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
    });
  } catch (error) {
    console.error("[WhatsApp conversation AI] Generation failed:", error.message);
    return { sent: false, reason: "generation-failed" };
  }

  if (
    eventEpoch !== generationEpoch ||
    !state.enabled ||
    typeof reply !== "string" ||
    !reply.trim()
  ) {
    return { skipped: true, reason: "disabled-before-send" };
  }

  try {
    await sendMessage(jid, reply.trim().slice(0, 4000));
    contact.history.push({
      role: "assistant",
      content: reply.trim().slice(0, 4000),
      at: Date.now(),
    });
    contact.history = contact.history.slice(-MAX_HISTORY);
    contact.updatedAt = Date.now();
    persist();
    console.info("[WhatsApp conversation AI] Reply sent.");
    return { sent: true };
  } catch (error) {
    console.error("[WhatsApp conversation AI] WhatsApp send failed:", error.message);
    return { sent: false, reason: "send-failed" };
  }
}

export async function handleWhatsAppConversationIncoming(item) {
  const jid = String(item?.jid || "");
  const id = String(item?.id || "");
  const text = String(item?.text || "").trim();

  if (!state.enabled || !id || !validJid(jid) || !text || /^\[[^\]]+\]$/.test(text)) {
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
    .then(() => processIncoming(item, jid, text, eventEpoch));

  queues.set(jid, task);
  try {
    return await task;
  } finally {
    inFlightMessages.delete(eventKey);
    if (queues.get(jid) === task) queues.delete(jid);
  }
}
