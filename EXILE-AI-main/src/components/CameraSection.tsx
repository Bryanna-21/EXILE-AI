import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Video, RotateCcw, Flashlight, Square, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBanner } from "@/components/mission/ui";

type Shot = { id: string; url: string; kind: "photo" | "video"; name: string };

const CameraSection = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [state, setState] = useState<"idle" | "starting" | "on" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [recording, setRecording] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);

  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
    setRecording(false);
    setTorch(false);
    setTorchOk(false);
  }, []);

  const start = useCallback(async (mode: "user" | "environment") => {
    if (!supported) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setState("starting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      const caps = (stream.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTorchOk(!!caps.torch);
      setFacing(mode);
      setState("on");
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name;
      setState("error");
      setError(
        name === "NotAllowedError" ? "Camera permission was denied. Allow it in your browser or system settings, then try again."
        : name === "NotFoundError" ? "No camera was found on this device."
        : name === "NotReadableError" ? "The camera is in use by another program."
        : "The camera could not be started.",
      );
    }
  }, [supported]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addShot = (blob: Blob, kind: Shot["kind"]) => {
    const ext = kind === "photo" ? "png" : (blob.type.includes("mp4") ? "mp4" : "webm");
    const id = crypto.randomUUID();
    setShots((s) => [{ id, url: URL.createObjectURL(blob), kind, name: `exile-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}` }, ...s].slice(0, 12));
  };

  const photo = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => b && addShot(b, "photo"), "image/png");
  };

  const toggleRecord = () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!streamRef.current || typeof MediaRecorder === "undefined") return;
    chunksRef.current = [];
    const rec = new MediaRecorder(streamRef.current);
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.onstop = () => {
      if (chunksRef.current.length) addShot(new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" }), "video");
      setRecording(false);
    };
    rec.start();
    recorderRef.current = rec;
    setRecording(true);
  };

  const flip = () => void start(facing === "user" ? "environment" : "user");

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorchOk(false);
    }
  };

  const on = state === "on";
  const ctl = "border border-cyan-500/40 bg-transparent text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-40";

  return (
    <div className="p-4 space-y-3 bg-slate-950 text-cyan-100 min-h-[28rem]">
      <div className="flex items-center gap-2">
        <Camera className="w-4 h-4 text-cyan-300" />
        <h2 className="text-sm tracking-widest">OPTICS</h2>
      </div>
      <p className="text-[11px] text-cyan-400/70">Uses this device's camera in the browser. Photos and clips stay on this computer until you download them.</p>
      {!supported && <StateBanner tone="warn" title="Camera not available">This browser cannot access a camera here.</StateBanner>}
      {error && <StateBanner tone="bad" title="Camera problem">{error}</StateBanner>}

      <div className="relative aspect-video max-h-72 w-full overflow-hidden rounded border border-cyan-500/30 bg-slate-900 flex items-center justify-center">
        <video ref={videoRef} muted playsInline className={`w-full h-full object-cover ${on ? "" : "hidden"}`} aria-label="Camera preview" />
        {!on && <p className="text-xs text-cyan-500/60">{state === "starting" ? "Starting camera…" : "Camera is off"}</p>}
        {recording && <span className="absolute top-2 left-2 rounded bg-red-600/80 px-1.5 py-0.5 text-[10px] tracking-widest">REC</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        {!on ? (
          <Button size="sm" disabled={!supported || state === "starting"} onClick={() => void start(facing)} className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100">
            <Camera className="w-3.5 h-3.5 mr-1.5" /> Start camera
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" className={ctl} onClick={photo} disabled={recording}><Camera className="w-3.5 h-3.5 mr-1.5" /> Take photo</Button>
            <Button size="sm" variant="ghost" className={ctl} onClick={toggleRecord} disabled={typeof MediaRecorder === "undefined"}>
              {recording ? <><Square className="w-3.5 h-3.5 mr-1.5" /> Stop recording</> : <><Video className="w-3.5 h-3.5 mr-1.5" /> Record video</>}
            </Button>
            <Button size="sm" variant="ghost" className={ctl} onClick={flip} disabled={recording} aria-label="Switch camera"><RotateCcw className="w-3.5 h-3.5" /></Button>
            <Button size="sm" variant="ghost" className={ctl} onClick={() => void toggleTorch()} disabled={!torchOk} aria-label="Toggle torch" title={torchOk ? "Torch" : "This camera has no torch"}><Flashlight className="w-3.5 h-3.5" /></Button>
            <Button size="sm" variant="ghost" className={ctl} onClick={stop}>Stop camera</Button>
          </>
        )}
      </div>

      {shots.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Captured items">
          {shots.map((s) => (
            <li key={s.id} className="relative aspect-video overflow-hidden rounded border border-cyan-500/30">
              {s.kind === "photo" ? <img src={s.url} alt="Captured photo" className="w-full h-full object-cover" /> : <video src={s.url} className="w-full h-full object-cover" controls />}
              <a href={s.url} download={s.name} aria-label={`Download ${s.name}`} className="absolute bottom-1 right-1 rounded border border-cyan-400/40 bg-slate-950/70 p-1"><Download className="w-3 h-3" /></a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default CameraSection;
