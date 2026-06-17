import { useEffect, useState } from "react";
import { MessageSquare, Send, Phone, Video, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface Contact {
  id: string;
  name: string;
  phone: string; // E.164 without +
}

const KEY = "exile_wa_contacts";

const WhatsAppSection = () => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [active, setActive] = useState<Contact | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setContacts(JSON.parse(raw));
    } catch {}
  }, []);

  const persist = (next: Contact[]) => {
    setContacts(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };

  const addContact = () => {
    const clean = phone.replace(/[^\d]/g, "");
    if (!name.trim() || clean.length < 7) {
      toast.error("Enter a name and full phone number with country code.");
      return;
    }
    const c: Contact = { id: crypto.randomUUID(), name: name.trim(), phone: clean };
    persist([c, ...contacts]);
    setName("");
    setPhone("");
    setActive(c);
    toast.success(`Contact ${c.name} added.`);
  };

  const removeContact = (id: string) => {
    persist(contacts.filter((c) => c.id !== id));
    if (active?.id === id) setActive(null);
  };

  const openChat = (target: Contact | null, text: string) => {
    if (!target) {
      toast.error("Select a contact first, Sir.");
      return;
    }
    const url = `https://wa.me/${target.phone}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const callViaWhatsApp = (target: Contact | null, kind: "voice" | "video") => {
    if (!target) {
      toast.error("Select a contact first, Sir.");
      return;
    }
    // wa.me opens the chat — instruct user, since WhatsApp doesn't expose a public call deep link reliably
    window.open(`https://wa.me/${target.phone}`, "_blank", "noopener,noreferrer");
    toast.message(`Opening WhatsApp — tap the ${kind === "video" ? "video" : "phone"} icon to ${kind} call ${target.name}.`);
  };

  return (
    <div className="h-[28rem] flex flex-col bg-slate-950 text-cyan-100">
      <div className="p-4 border-b border-cyan-500/30 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-widest flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-cyan-300" />
          WHATSAPP RELAY
        </h2>
        <span className="text-[10px] tracking-widest text-cyan-400/70">CLICK-TO-CHAT // wa.me</span>
      </div>

      <div className="grid grid-cols-2 flex-1 min-h-0">
        {/* Contacts */}
        <div className="border-r border-cyan-500/20 flex flex-col">
          <div className="p-3 space-y-2 border-b border-cyan-500/20">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="bg-slate-900 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-500/50 h-8 text-sm"
            />
            <div className="flex gap-2">
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
                className="bg-slate-900 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-500/50 h-8 text-sm"
              />
              <Button size="sm" onClick={addContact} className="bg-cyan-500/20 border border-cyan-400/40 hover:bg-cyan-500/30 h-8">
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {contacts.length === 0 && (
              <p className="p-4 text-xs text-cyan-500/60">No contacts yet. Add one above to begin.</p>
            )}
            {contacts.map((c) => (
              <button
                key={c.id}
                onClick={() => setActive(c)}
                className={`w-full text-left px-3 py-2 border-b border-cyan-500/10 flex items-center justify-between group ${
                  active?.id === c.id ? "bg-cyan-500/15" : "hover:bg-cyan-500/5"
                }`}
              >
                <div>
                  <div className="text-sm text-cyan-100">{c.name}</div>
                  <div className="text-[11px] text-cyan-400/60 font-mono">+{c.phone}</div>
                </div>
                <Trash2
                  className="w-3.5 h-3.5 text-cyan-500/40 opacity-0 group-hover:opacity-100 hover:text-red-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeContact(c.id);
                  }}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Compose */}
        <div className="flex flex-col">
          <div className="p-3 border-b border-cyan-500/20 text-xs text-cyan-300/80">
            {active ? (
              <>
                Targeting <span className="text-cyan-100 font-semibold">{active.name}</span>{" "}
                <span className="font-mono text-cyan-500/70">+{active.phone}</span>
              </>
            ) : (
              "Select a contact to compose."
            )}
          </div>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Compose message..."
            className="flex-1 m-3 bg-slate-900 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-500/50 resize-none text-sm"
          />
          <div className="p-3 border-t border-cyan-500/20 grid grid-cols-3 gap-2">
            <Button
              onClick={() => openChat(active, message)}
              className="bg-cyan-500/20 border border-cyan-400/40 hover:bg-cyan-500/30 text-cyan-100"
            >
              <Send className="w-4 h-4 mr-1" /> Send
            </Button>
            <Button
              variant="outline"
              onClick={() => callViaWhatsApp(active, "voice")}
              className="border-cyan-500/30 text-cyan-100 hover:bg-cyan-500/10"
            >
              <Phone className="w-4 h-4 mr-1" /> Voice
            </Button>
            <Button
              variant="outline"
              onClick={() => callViaWhatsApp(active, "video")}
              className="border-cyan-500/30 text-cyan-100 hover:bg-cyan-500/10"
            >
              <Video className="w-4 h-4 mr-1" /> Video
            </Button>
          </div>
          <p className="px-3 pb-3 text-[10px] text-cyan-500/50 tracking-wider">
            UPGRADE: connect Twilio for autonomous send/receive on a verified business number.
          </p>
        </div>
      </div>
    </div>
  );
};

export default WhatsAppSection;
