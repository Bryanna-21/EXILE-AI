interface ArcReactorProps {
  size?: number;
  state?: "idle" | "listening" | "thinking" | "speaking";
  className?: string;
}

/**
 * EXILE core — HUD arc reactor: rotating arcs, dashed orbit, hex core, corner brackets.
 */
const ArcReactor = ({ size = 320, state = "idle", className = "" }: ArcReactorProps) => {
  const spin = state === "thinking" ? 4 : state === "listening" ? 8 : 16;
  const pulse = state === "speaking" ? "1.2s" : "3s";

  return (
    <div
      className={`relative select-none ${className}`}
      style={{ width: size, height: size }}
      aria-label="EXILE core"
    >
      <div
        className="absolute inset-[18%] rounded-full blur-2xl"
        style={{
          background: "radial-gradient(circle, rgba(56,189,248,0.55), transparent 70%)",
          animation: `exile-breathe ${pulse} ease-in-out infinite`,
        }}
      />
      <svg viewBox="0 0 200 200" width={size} height={size} className="relative">
        <defs>
          <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#bae6fd" stopOpacity="0.95" />
            <stop offset="45%" stopColor="#38bdf8" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.15" />
          </radialGradient>
        </defs>

        {/* corner brackets */}
        <g stroke="#7dd3fc" strokeWidth="1.2" fill="none" opacity="0.55">
          <path d="M14 34 V14 H34" />
          <path d="M166 14 H186 V34" />
          <path d="M186 166 V186 H166" />
          <path d="M34 186 H14 V166" />
        </g>

        {/* outer rotating arcs */}
        <g style={{ transformOrigin: "100px 100px", animation: `spin ${spin}s linear infinite` }}>
          <circle
            cx="100"
            cy="100"
            r="78"
            fill="none"
            stroke="url(#arcGrad)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="120 70"
          />
          <circle cx="100" cy="22" r="3" fill="#67e8f9" />
          <circle cx="178" cy="100" r="2.5" fill="#67e8f9" />
        </g>

        {/* counter-rotating dashed orbit */}
        <g
          style={{
            transformOrigin: "100px 100px",
            animation: `spin ${spin * 2}s linear infinite reverse`,
          }}
        >
          <circle
            cx="100"
            cy="100"
            r="62"
            fill="none"
            stroke="#38bdf8"
            strokeWidth="1"
            strokeDasharray="2 6"
            opacity="0.7"
          />
          <circle cx="100" cy="38" r="2" fill="#7dd3fc" />
          <circle cx="62" cy="145" r="2" fill="#7dd3fc" />
          <circle cx="145" cy="145" r="2" fill="#7dd3fc" />
        </g>

        {/* inner ring */}
        <circle cx="100" cy="100" r="48" fill="none" stroke="#0ea5e9" strokeWidth="0.8" opacity="0.45" />

        {/* hex core */}
        <polygon
          points="100,60 135,80 135,120 100,140 65,120 65,80"
          fill="url(#coreGrad)"
          stroke="#38bdf8"
          strokeWidth="1.6"
          style={{ animation: `exile-breathe ${pulse} ease-in-out infinite` }}
        />
        <polygon
          points="100,72 124,86 124,114 100,128 76,114 76,86"
          fill="none"
          stroke="#7dd3fc"
          strokeWidth="0.8"
          opacity="0.6"
        />
        <circle cx="100" cy="100" r="6" fill="#e0f2fe" opacity="0.9" />
      </svg>
    </div>
  );
};

export default ArcReactor;
