import { useEffect } from "react";
import { ExternalLink, Minus, X, ShieldCheck } from "lucide-react";
import ArcReactor from "./ArcReactor";
import "./CompanionWindow.css";

declare global {
interface Window {
exileDesktop?: {
openDashboard: () => void;
minimizeCompanion: () => void;
closeCompanion: () => void;
};
}
}

const CompanionWindow = () => {
useEffect(() => {
const previousBackground = document.body.style.background;
document.body.style.background = "transparent";

return () => {
  document.body.style.background = previousBackground;
};

}, []);

return ( <main className="exile-companion"> <header className="companion-titlebar"> <div className="companion-brand"> <span className="companion-status-dot" /> <span>EXILE</span> <span className="companion-version">AI COMPANION</span> </div>

    <div className="companion-window-controls">
      <button
        type="button"
        aria-label="Minimize companion"
        title="Minimize"
        onClick={() => window.exileDesktop?.minimizeCompanion()}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        aria-label="Close companion"
        title="Close companion"
        onClick={() => window.exileDesktop?.closeCompanion()}
      >
        <X size={15} />
      </button>
    </div>
  </header>

  <section className="companion-core">
    <div className="companion-eyes" aria-hidden="true">
      <span />
      <span />
    </div>

    <ArcReactor size={210} state="idle" />

    <div className="companion-identity">
      <h1>EXILE</h1>
      <p>YOUR PERSONAL AI</p>
    </div>
  </section>

  <footer className="companion-footer">
    <div className="companion-presence">
      <ShieldCheck size={15} />
      <span>READY WHEN YOU ARE</span>
    </div>

    <button
      className="companion-dashboard-button"
      type="button"
      onClick={() => window.exileDesktop?.openDashboard()}
    >
      OPEN EXILE
      <ExternalLink size={15} />
    </button>
  </footer>
</main>

);
};

export default CompanionWindow;
