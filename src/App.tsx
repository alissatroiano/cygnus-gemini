import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { 
  Plane, 
  ShieldAlert, 
  Globe, 
  Mic, 
  MicOff, 
  Monitor, 
  Activity,
  ExternalLink,
  ChevronRight,
  Info,
  MousePointer2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';

// --- Types ---
interface UIAction {
  type: string;
  detail: string;
  timestamp: string;
}

// --- Constants ---
const CYGNUS_SYSTEM_INSTRUCTION = `
You are Cygnus, a real-time UI Navigator. 

1. MONITOR: Watch screen for international flight bookings.
2. VERIFY: Before alerting, double-check the destination. If you see multiple locations, focus on the one being actively selected or the most prominent "Select" button.
3. ALERT: Call 'trigger_flight_alert' IMMEDIATELY when destination is confirmed. 
4. TALK: Say "I noticed you're looking at international flights to [Destination]. Did you know 40% of travel cancellations are caused by passport validity issues?"
5. RESEARCH: Use 'googleSearch' to find the specific passport validity rules for that country (e.g., "passport validity for Greece").
6. GUIDE: 
   - STEP 1: Use 'navigate_to_url' to show them the State Dept site.
   - STEP 2: Use 'type_text' to point to the search box on THEIR screen.
   - STEP 3: Use 'click_element' to point to the "Go" button.
   - STEP 4: Once the page loads, use 'scroll_to_section' and 'highlight_text'.

CLARIFICATION: You are a companion. You cannot control their browser. You move a VIRTUAL CURSOR on their screen share to GUIDE them. Tell them: "I'll show you where to look on your screen."
`;

// --- Components ---

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState<'idle' | 'monitoring' | 'alerting' | 'assisting'>('idle');
  const [cursorPos, setCursorPos] = useState({ x: 50, y: 50 });
  const [showCursor, setShowCursor] = useState(false);
  const [userIntent, setUserIntent] = useState("");
  const [actionHistory, setActionHistory] = useState<{type: string, detail: string, timestamp: string}[]>([]);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [flightAlert, setFlightAlert] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [researchSummary, setResearchSummary] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'vision' | 'research'>('vision');
  const [error, setError] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const addDebugLog = (msg: string) => {
    console.log(`[DEBUG] ${msg}`);
    setDebugLogs(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev].slice(0, 5));
  };
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isRecordingRef = useRef(false);

  const addAction = (type: string, detail: string) => {
    setActionHistory(prev => [{
      type,
      detail,
      timestamp: new Date().toLocaleTimeString()
    }, ...prev].slice(0, 10));
  };

  const moveCursor = async (x: number, y: number) => {
    setShowCursor(true);
    setCursorPos({ x, y });
    await new Promise(resolve => setTimeout(resolve, 800));
    // Brief "click" effect
    setCursorPos(prev => ({ ...prev })); 
    await new Promise(resolve => setTimeout(resolve, 200));
  };

  // Initialize Audio Context on first user interaction
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
  };

  const startMonitoring = async () => {
    initAudio();
    setError(null);
    nextStartTimeRef.current = 0;
    addDebugLog("Starting monitoring...");
    try {
      // 1. Capture Screen
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 10 },
        audio: false
      }).catch(err => {
        addDebugLog(`Screen capture failed: ${err.name}`);
        if (err.name === 'NotAllowedError') {
          throw new Error("Screen sharing permission was denied. Please allow screen access to use Cygnus.");
        }
        throw err;
      });
      
      // 2. Capture Mic
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(err => {
        addDebugLog(`Mic capture failed: ${err.name}`);
        if (err.name === 'NotAllowedError') {
          throw new Error("Microphone permission was denied. Please allow microphone access to use Cygnus.");
        }
        throw err;
      });
      
      streamRef.current = screenStream;
      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
      }

      setIsActive(true);
      setIsRecording(true);
      isRecordingRef.current = true;
      setStatus('monitoring');

      // 3. Connect to Gemini Live
      addDebugLog("Connecting to Gemini Live...");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: CYGNUS_SYSTEM_INSTRUCTION,
          tools: [
            { googleSearch: {} },
            {
              functionDeclarations: [
                {
                  name: "navigate_to_url",
                  description: "Navigates to a specific URL.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ["url"] }
                },
                {
                  name: "click_element",
                  description: "Simulates a click on a UI element.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      description: { type: Type.STRING },
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER }
                    },
                    required: ["description"]
                  }
                },
                {
                  name: "type_text",
                  description: "Simulates typing into a text field.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      text: { type: Type.STRING },
                      element_description: { type: Type.STRING }
                    },
                    required: ["text", "element_description"]
                  }
                },
                {
                  name: "trigger_flight_alert",
                  description: "IMMEDIATELY call this when an international flight destination is detected on screen. This shows a critical popover to the user.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      destination: { type: Type.STRING, description: "The detected destination country or city." }
                    },
                    required: ["destination"]
                  }
                },
                {
                  name: "select_country_requirements",
                  description: "Finds and selects the specific country requirements on the travel.state.gov website.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      country: { type: Type.STRING, description: "The destination country to look up." }
                    },
                    required: ["country"]
                  }
                },
                {
                  name: "scroll_to_section",
                  description: "Scrolls the page to a specific section or heading.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      section_name: { type: Type.STRING }
                    },
                    required: ["section_name"]
                  }
                },
                {
                  name: "highlight_text",
                  description: "Highlights or selects specific text on the screen for emphasis.",
                  parameters: { 
                    type: Type.OBJECT, 
                    properties: { 
                      text_description: { type: Type.STRING }
                    },
                    required: ["text_description"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onopen: () => {
            addDebugLog("Gemini Live connected!");
            sessionPromise.then(session => {
              sessionRef.current = session;
              startStreaming(session, micStream);
            });
          },
          onerror: (err) => {
            addDebugLog(`Gemini Live error: ${err}`);
            setError("Connection to AI service failed. Please try again.");
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            if (message.serverContent?.modelTurn?.parts[0]?.inlineData?.data) {
              playAudio(message.serverContent.modelTurn.parts[0].inlineData.data);
            }

            // Handle Transcriptions
            if (message.serverContent?.modelTurn?.parts[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              setTranscript(prev => [...prev, `Navigator: ${text}`].slice(-5));
              if (status === 'assisting' || viewMode === 'research') {
                setResearchSummary(prev => (prev ? prev + "\n" + text : text));
              }
            }
            
            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              addDebugLog("AI Interrupted");
              // Stop all current audio playback
              sourcesRef.current.forEach(source => {
                try { source.stop(); } catch(e) {}
              });
              sourcesRef.current = [];
              nextStartTimeRef.current = 0;
            }

            // Handle Tool Calls
            const toolCall = message.toolCall;
            if (toolCall) {
              const responses: any[] = [];
              
              for (const call of toolCall.functionCalls) {
                addDebugLog(`Executing Tool: ${call.name} with args: ${JSON.stringify(call.args)}`);
                let result = "Action executed successfully.";

                if (call.name === 'navigate_to_url') {
                  const url = call.args.url as string;
                  setCurrentUrl(url);
                  setViewMode('research');
                  addAction("Navigation", `Navigating to ${url}`);
                  result = `Navigated to ${url}. I've opened a research panel for you in this window.`;
                } else if (call.name === 'click_element') {
                  const desc = call.args.description as string;
                  const x = (call.args.x as number) || 50;
                  const y = (call.args.y as number) || 50;
                  moveCursor(x, y).then(() => {
                    setTimeout(() => setShowCursor(false), 1000);
                  });
                  addAction("Click", `Clicking on "${desc}"`);
                  result = `Simulated click on ${desc} at (${x}, ${y}).`;
                } else if (call.name === 'type_text') {
                  const text = call.args.text as string;
                  const desc = call.args.element_description as string;
                  moveCursor(40, 40).then(() => {
                    setTimeout(() => setShowCursor(false), 1000);
                  });
                  addAction("Type", `Typing "${text}" into ${desc}`);
                  result = `Typed text into ${desc}.`;
                } else if (call.name === 'trigger_flight_alert') {
                  const destination = call.args.destination as string;
                  setFlightAlert(destination);
                  setResearchSummary(null); // Clear old research
                  setCurrentUrl(null);
                  setStatus('alerting');
                  addAction("Alert", `Detected international flight to ${destination}`);
                  result = `Alert triggered for ${destination}.`;
                } else if (call.name === 'select_country_requirements') {
                  const country = call.args.country as string;
                  moveCursor(70, 30).then(() => {
                    setTimeout(() => setShowCursor(false), 1000);
                  });
                  addAction("Action", `Selecting requirements for ${country}`);
                  result = `Searching for ${country} requirements on travel.state.gov.`;
                } else if (call.name === 'scroll_to_section') {
                  const section = call.args.section_name as string;
                  addAction("Scroll", `Scrolling to ${section}`);
                  result = `Scrolled to ${section}.`;
                } else if (call.name === 'highlight_text') {
                  const text = call.args.text_description as string;
                  await moveCursor(50, 60); // Simulate highlighting area
                  addAction("Highlight", `Highlighting: ${text}`);
                  result = `Highlighted ${text}.`;
                  setTimeout(() => setShowCursor(false), 1000);
                }

                responses.push({
                  name: call.name,
                  id: call.id,
                  response: { result }
                });
              }

              if (responses.length > 0) {
                const session = sessionRef.current;
                if (session) {
                  session.sendToolResponse({ functionResponses: responses });
                } else {
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
                }
              }
            }
          },
          onclose: () => {
            addDebugLog("Gemini Live closed");
            stopMonitoring();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      addDebugLog(`Start monitoring failed: ${err.message}`);
      setError(err.message || "An unexpected error occurred while starting Cygnus.");
      stopMonitoring();
    }
  };

  const stopMonitoring = () => {
    setIsActive(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    setStatus('idle');
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (sessionRef.current) {
      sessionRef.current.close();
    }
  };

  const startStreaming = (session: any, micStream: MediaStream) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !audioContextRef.current) return;

    const ctx = canvas.getContext('2d');
    
    // Video Streaming
    const sendFrame = () => {
      if (!isRecordingRef.current) return;
      if (ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        // Use a smaller internal canvas for streaming to reduce data size
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64Data = canvas.toDataURL('image/jpeg', 0.2).split(',')[1];
        session.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } });
      }
      setTimeout(sendFrame, 1000); // 1fps is enough for UI navigation
    };
    sendFrame();

    // Audio Streaming (Mic)
    const audioContext = audioContextRef.current;
    const source = audioContext.createMediaStreamSource(micStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (!isRecordingRef.current) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert to 16-bit PCM
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
      }
      
      // Convert to Base64 efficiently
      const bytes = new Uint8Array(pcmData.buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);
      session.sendRealtimeInput({ media: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' } });
    };
  };

  const playAudio = (base64Data: string) => {
    if (!audioContextRef.current) return;
    const audioContext = audioContextRef.current;
    
    const binaryString = window.atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcmData = new Int16Array(bytes.buffer);
    
    const sampleRate = 24000; // Gemini Live output is 24kHz
    const audioBuffer = audioContext.createBuffer(1, pcmData.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) {
      channelData[i] = pcmData[i] / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    
    // Schedule the chunk
    const currentTime = audioContext.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime + 0.05; // Small buffer
    }
    
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
    
    // Track source to allow stopping on interruption
    sourcesRef.current.push(source);
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter(s => s !== source);
    };
  };

  return (
    <div className="min-h-screen bg-[#E6E6E6] text-[#151619] font-sans selection:bg-[#151619] selection:text-white">
      {/* Header */}
      <header className="border-b border-black/10 bg-white/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#151619] rounded-xl flex items-center justify-center text-white shadow-lg">
              <Monitor className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight uppercase">Cygnus</h1>
              <p className="text-[10px] font-mono uppercase tracking-widest opacity-50">Visual UI Understanding & Interaction</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-black/5 rounded-full border border-black/5">
              <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-[10px] font-mono uppercase font-bold">
                {isActive ? 'System Active' : 'System Standby'}
              </span>
            </div>
            {!isActive ? (
              <button 
                onClick={startMonitoring}
                className="px-6 py-2 bg-[#151619] text-white rounded-xl font-medium hover:bg-black transition-all shadow-lg flex items-center gap-2"
              >
                <Monitor className="w-4 h-4" />
                Start Monitoring
              </button>
            ) : (
              <button 
                onClick={stopMonitoring}
                className="px-6 py-2 bg-red-500 text-white rounded-xl font-medium hover:bg-red-600 transition-all shadow-lg flex items-center gap-2"
              >
                <MicOff className="w-4 h-4" />
                Stop Session
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {error && (
          <div className="lg:col-span-12 bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center gap-3 text-red-700 shadow-sm animate-in fade-in slide-in-from-top-2">
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
            <div className="flex-1 flex items-center justify-between">
              <p className="text-sm font-medium">{error}</p>
              <button 
                onClick={() => setError(null)}
                className="text-xs font-bold uppercase tracking-widest hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        
        {/* Left Column: Visual Monitoring */}
        <div className="lg:col-span-8 space-y-6 relative">
          <AnimatePresence>
            {flightAlert && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="absolute inset-x-0 top-0 z-50 p-6"
              >
                <div className="bg-white rounded-3xl shadow-2xl border-2 border-red-500 p-8 flex flex-col md:flex-row items-center gap-6">
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <ShieldAlert className="w-8 h-8 text-red-600" />
                  </div>
                  <div className="flex-1 space-y-2 text-center md:text-left">
                    <h3 className="text-xl font-bold text-[#151619]">International Flight Detected!</h3>
                    <p className="text-sm text-black/70 leading-relaxed">
                      I noticed you're looking at flights to <span className="font-bold text-red-600">{flightAlert}</span>. 
                      Did you know 40% of travel cancellations are caused by passport validity issues?
                    </p>
                    <p className="text-sm font-medium">Would you like me to check the specific entry requirements for you?</p>
                  </div>
                  <div className="flex gap-3 w-full md:w-auto">
                    <button 
                      onClick={() => {
                        if (sessionRef.current) {
                          sessionRef.current.sendRealtimeInput({ text: `User confirmed: Check passport validity for ${flightAlert}` });
                        }
                        setFlightAlert(null);
                        setStatus('assisting');
                      }}
                      className="flex-1 md:flex-none px-6 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg"
                    >
                      Yes, Check Now
                    </button>
                    <button 
                      onClick={() => {
                        setFlightAlert(null);
                        setStatus('monitoring');
                      }}
                      className="flex-1 md:flex-none px-6 py-3 bg-black/5 text-[#151619] rounded-xl font-medium hover:bg-black/10 transition-all"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <section className="bg-[#151619] rounded-3xl overflow-hidden shadow-2xl aspect-video relative group">
            <div className="absolute top-4 right-4 z-50 flex gap-2">
              <button 
                onClick={() => setViewMode('vision')}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-all ${viewMode === 'vision' ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/50 hover:bg-white/20'}`}
              >
                Vision
              </button>
              <button 
                onClick={() => setViewMode('research')}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-all ${viewMode === 'research' ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/50 hover:bg-white/20'}`}
              >
                Research
              </button>
            </div>

            <div className={`${viewMode === 'vision' ? 'block' : 'hidden'} w-full h-full relative`}>
              <video 
                ref={videoRef} 
                autoPlay 
                muted 
                className="w-full h-full object-cover opacity-80"
              />
              <canvas ref={canvasRef} width={480} height={270} className="hidden" />
              
              {/* Virtual Cursor */}
              <AnimatePresence>
                {showCursor && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ 
                      opacity: 1, 
                      scale: 1,
                      left: `${cursorPos.x}%`,
                      top: `${cursorPos.y}%`
                    }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ type: "spring", damping: 20, stiffness: 100 }}
                    className="absolute z-50 pointer-events-none"
                    style={{ transform: 'translate(-50%, -50%)' }}
                  >
                    <div className="relative">
                      <MousePointer2 className="w-8 h-8 text-white fill-[#151619] drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" />
                      <motion.div 
                        animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                        transition={{ repeat: Infinity, duration: 1 }}
                        className="absolute inset-0 bg-white/30 rounded-full -z-10"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className={`${viewMode === 'research' ? 'block' : 'hidden'} w-full h-full bg-white flex flex-col`}>
              <div className="p-4 bg-gray-50 border-b flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs font-bold text-gray-700 uppercase tracking-tight">Research Assistant</span>
                </div>
                {currentUrl && (
                  <a 
                    href={currentUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 text-white text-[10px] font-bold rounded-lg hover:bg-emerald-700 transition-all"
                  >
                    Open Official Site <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {currentUrl ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                      <div className="flex items-center gap-2 mb-2">
                        <Info className="w-4 h-4 text-emerald-600" />
                        <h5 className="text-sm font-bold text-emerald-900">Cygnus Live Guidance</h5>
                      </div>
                      <p className="text-xs text-emerald-800 leading-relaxed">
                        I've opened the State Department requirements for you. Since some government sites restrict viewing inside other apps, 
                        I recommend clicking the button above to view the full details in a new tab. 
                        <strong> I will continue to guide you through the requirements here.</strong>
                      </p>
                    </div>

                    <div className="prose prose-sm max-w-none">
                      <h4 className="text-gray-900 font-bold">Quick Summary</h4>
                      <div className="text-sm text-gray-600 leading-relaxed">
                        {researchSummary || "Cygnus is fetching the latest passport validity rules for your destination..."}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                    <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
                      <Globe className="w-8 h-8 text-gray-300" />
                    </div>
                    <div>
                      <h4 className="text-lg font-bold text-gray-800">No Research Active</h4>
                      <p className="text-sm text-gray-500">Cygnus will open travel requirements here when detected.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {/* Overlay UI */}
            <div className="absolute inset-0 p-6 flex flex-col justify-between pointer-events-none">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="text-[10px] font-mono text-white uppercase tracking-wider">Live Vision Stream</span>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-mono text-white/50 uppercase">Session Time</p>
                  <p className="text-sm font-mono text-white">00:00:00</p>
                </div>
              </div>

              {!isActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
                  <div className="text-center space-y-4">
                    <div className="w-20 h-20 bg-white/10 rounded-full flex items-center justify-center mx-auto border border-white/20">
                      <Monitor className="w-10 h-10 text-white" />
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-white font-medium">Ready to Monitor</h3>
                      <p className="text-white/50 text-xs">Share your browser tab to begin flight detection</p>
                    </div>
                  </div>
                </div>
              )}

              {isActive && (
                <div className="flex items-end justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[10px] font-mono text-white uppercase">Analyzing Patterns...</span>
                    </div>
                    <div className="h-1 w-48 bg-white/10 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-emerald-500"
                        animate={{ width: ['0%', '100%'] }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Transcript / Status */}
          <section className="bg-white rounded-3xl p-6 shadow-sm border border-black/5 min-h-[160px] flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <Mic className="w-4 h-4 text-[#151619]" />
              <h2 className="text-xs font-bold uppercase tracking-widest opacity-50">Agent Thought Stream</h2>
            </div>
            <div className="flex-1 space-y-3">
              {transcript.length === 0 ? (
                <p className="text-sm text-black/30 italic">Navigator is observing your screen and waiting for your intent...</p>
              ) : (
                transcript.map((line, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-sm leading-relaxed"
                  >
                    <span className="font-bold text-[#151619] mr-2">NAVIGATOR:</span>
                    <span className="text-black/70">{line.replace('Navigator: ', '')}</span>
                  </motion.div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Navigator Controls */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-white rounded-3xl p-8 shadow-xl border border-black/5 space-y-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[#151619]">
                <Monitor className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-widest">Manual Intent (Optional)</span>
              </div>
              <p className="text-[10px] text-black/40 leading-tight mb-2">
                Cygnus monitors automatically, but you can also type specific requests here.
              </p>
              <textarea 
                value={userIntent}
                onChange={(e) => setUserIntent(e.target.value)}
                placeholder="What should I do for you? (e.g., 'Find the login button')"
                className="w-full p-4 bg-black/5 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-black/10 min-h-[100px] resize-none"
              />
              <button 
                onClick={() => {
                  if (sessionRef.current && userIntent) {
                    sessionRef.current.sendRealtimeInput({ text: `User Intent: ${userIntent}` });
                    setUserIntent("");
                  }
                }}
                disabled={!isActive || !userIntent}
                className="w-full py-3 bg-[#151619] text-white rounded-xl font-medium disabled:opacity-50 transition-all"
              >
                Send Intent
              </button>
            </div>
          </section>

          <section className="bg-white rounded-3xl p-8 shadow-xl border border-black/5 space-y-6">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#151619]" />
              <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-50">Action History</h3>
            </div>
            <div className="space-y-4">
              {actionHistory.length === 0 ? (
                <p className="text-xs text-black/30 italic">No actions performed yet.</p>
              ) : (
                actionHistory.map((action, i) => (
                  <div key={i} className="flex gap-3 items-start border-b border-black/5 pb-3 last:border-0">
                    <div className="w-8 h-8 bg-black/5 rounded-lg flex items-center justify-center flex-shrink-0">
                      {action.type === 'Navigation' && <Globe className="w-4 h-4" />}
                      {action.type === 'Click' && <Activity className="w-4 h-4" />}
                      {action.type === 'Type' && <Mic className="w-4 h-4" />}
                      {action.type === 'Alert' && <ShieldAlert className="w-4 h-4 text-red-500" />}
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[10px] font-mono uppercase opacity-50">{action.timestamp}</p>
                      <p className="text-xs font-medium">{action.detail}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="bg-white rounded-3xl p-8 shadow-xl border border-black/5 space-y-4">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-[#151619]" />
              <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-50">System Logs</h3>
            </div>
            <div className="space-y-2">
              {debugLogs.length === 0 ? (
                <p className="text-[10px] text-black/30 italic">System ready...</p>
              ) : (
                debugLogs.map((log, i) => (
                  <p key={i} className="text-[10px] font-mono text-black/60 border-l-2 border-black/10 pl-2 py-0.5">
                    {log}
                  </p>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-8 border-t border-black/5">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-[10px] font-mono uppercase opacity-40">© 2026 UI Navigator Systems • Powered by Gemini Live</p>
          <div className="flex gap-6">
            <a href="#" className="text-[10px] font-mono uppercase opacity-40 hover:opacity-100 transition-opacity">Privacy Policy</a>
            <a href="#" className="text-[10px] font-mono uppercase opacity-40 hover:opacity-100 transition-opacity">Terms of Service</a>
            <a href="#" className="text-[10px] font-mono uppercase opacity-40 hover:opacity-100 transition-opacity">Contact Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
