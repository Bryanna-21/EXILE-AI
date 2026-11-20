import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { installLocalApiAuth } from './lib/localApi'
import { chatMedia } from './lib/chat/mediaStore'
import { openBestBackend } from './lib/chat/mediaDb'

installLocalApiAuth();

// Persist chat media in IndexedDB when available (falls back to memory; chatMedia.durable reports which).
void openBestBackend(window.indexedDB).then((backend) => chatMedia.useBackend(backend));

createRoot(document.getElementById("root")!).render(<App />);
