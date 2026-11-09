import { Home, Car, MessageSquare, Phone, Camera, Mic, Files, Search, Image as ImageIcon, Share2, Activity, ShieldCheck, MessageCircle, Film, FileText, BookOpen, Cog, AppWindow, type LucideIcon } from 'lucide-react';
import type { Tone } from '@/lib/missionControl';

/**
 * Honest capability registry (result of the capability audit).
 *
 *  live         works with nothing but this app
 *  needs-setup  real implementation, but needs a key, token, server or permission first
 *  partial      works, with a material limitation described in `note`
 *  placeholder  UI only: it does not perform the advertised function
 *  native-only  works only in the desktop (Electron) build
 *  locked       unavailable until something is granted
 *
 * Do not mark an entry `live` unless the feature was verified to work.
 */
export type CapabilityStatus = 'live' | 'needs-setup' | 'partial' | 'placeholder' | 'locked' | 'native-only';

export interface Capability {
  id: string;
  name: string;
  icon: LucideIcon;
  status: CapabilityStatus;
  note: string;
  section?: string; // matches menu section id
}

export const STATUS_LABEL: Record<CapabilityStatus, string> = {
  live: 'working',
  'needs-setup': 'needs setup',
  partial: 'partial',
  placeholder: 'placeholder',
  locked: 'locked',
  'native-only': 'desktop only',
};

export const STATUS_TONE: Record<CapabilityStatus, Tone> = {
  live: 'ok',
  'needs-setup': 'warn',
  partial: 'info',
  placeholder: 'bad',
  locked: 'idle',
  'native-only': 'info',
};

export const CAPABILITIES: Capability[] = [
  { id: 'tasks', name: 'Task engine', icon: Cog, status: 'needs-setup', note: 'Plans with a model, runs registered tools with approvals; needs a planning provider key', section: 'mission' },
  { id: 'native-apps', name: 'Native applications', icon: AppWindow, status: 'native-only', note: 'Import and launch local programs (Windows supported; they open in their own windows, not inside EXILE)', section: 'apps' },
  { id: 'chat', name: 'Console', icon: MessageCircle, status: 'needs-setup', note: 'Needs a model provider; falls back to simple offline rules without one', section: 'chat' },
  { id: 'research', name: 'Research Briefing', icon: BookOpen, status: 'needs-setup', note: 'Model-written briefing; no live web search, so sources are not verified', section: 'research' },
  { id: 'cinema', name: 'Cinema Storyboard', icon: Film, status: 'partial', note: '4 still keyframes only; no video is produced', section: 'cinema' },
  { id: 'docs', name: 'Document Intelligence', icon: FileText, status: 'needs-setup', note: 'Images, text and text-based PDFs (no OCR for scans); needs a model provider', section: 'docs' },
  { id: 'analyze', name: 'Vision', icon: Search, status: 'needs-setup', note: 'Sends your image to the AI model; needs a provider that can read images', section: 'analysis' },
  { id: 'voice', name: 'Voice', icon: Mic, status: 'live', note: 'Dictation (Chromium-class browsers), audio recording and read-aloud', section: 'voice' },
  { id: 'house', name: 'Home Assistant', icon: Home, status: 'needs-setup', note: 'Needs the hosted home proxy plus your Home Assistant URL and token', section: 'house' },
  { id: 'car', name: 'Vehicle Fleet', icon: Car, status: 'needs-setup', note: 'Manual token paste through the hosted proxy; no OAuth sign-in', section: 'car' },
  { id: 'whatsapp', name: 'WhatsApp Relay', icon: MessageSquare, status: 'needs-setup', note: 'Real relay (QR pairing); needs the relay service running', section: 'whatsapp' },
  { id: 'calls', name: 'Video / Voice Calls', icon: Phone, status: 'placeholder', note: 'Only previews your own mic and camera; no remote calling exists', section: 'calls' },
  { id: 'camera', name: 'Optics', icon: Camera, status: 'live', note: 'Browser camera: photo, video clip, switch camera, download', section: 'camera' },
  { id: 'files', name: 'File Vault', icon: Files, status: 'live', note: 'Browse files or a folder you choose; nothing is uploaded or stored', section: 'files' },
  { id: 'share', name: 'Share Hub', icon: Share2, status: 'live', note: 'System share sheet, copy, email and WhatsApp compose links', section: 'share' },
  { id: 'systems', name: 'Systems Monitor', icon: Activity, status: 'live', note: 'Real checks of network, local API, AI providers, task engine and desktop bridge', section: 'dashboard' },
  { id: 'access', name: 'System Access', icon: ShieldCheck, status: 'needs-setup', note: 'Browser permissions must be granted', section: 'system' },
];
