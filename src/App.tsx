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

1. MONITOR: Watch screen for international flight searches, research, or bookings. Look for airport codes, airline logos, or "Select Flights" screens.
2. ALERT: Call 'trigger_flight_alert' IMMEDIATELY when an international destination is detected (even if they are just searching). DO NOT wait for a booking confirmation.
3. TALK: Say "I noticed you're looking at international flights to [Destination]. Did you know 40% of travel cancellations are caused by passport validity issues, like the 3-6 month rule or lack of empty stamp pages?"
4. OFFER HELP: Ask: "Would you like to check the specific entry requirements for your destination?"
5. ACTION: If they agree, tell them to click the "Yes, Check Now" button on your alert popover. 
6. TUTORIAL: If the user seems confused or asks how to check requirements, call 'show_tutorial_video' to show them a screen recording of how to use the State Department site.

CLARIFICATION: You are a companion. You guide the user. You cannot open tabs for them directly, so you must trigger the alert popover which has the button they need.
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
  const [showTutorial, setShowTutorial] = useState(false);
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

  const triggerTutorial = () => {
    setShowTutorial(true);
    addAction("Tutorial", "Displaying requirement lookup tutorial video");
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
                  name: "show_tutorial_video",
                  description: "Shows a screen recording tutorial to the user explaining how to look up travel requirements.",
                  parameters: { type: Type.OBJECT, properties: {} }
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

                if (call.name === 'click_element') {
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
                  setStatus('alerting');
                  addAction("Alert", `Detected international flight to ${destination}`);
                  result = `Alert triggered for ${destination}.`;
                } else if (call.name === 'show_tutorial_video') {
                  triggerTutorial();
                  result = "Tutorial video displayed to user.";
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
                        window.open('https://travel.state.gov/en/international-travel.html', '_blank');
                        if (sessionRef.current) {
                          sessionRef.current.sendRealtimeInput({ text: `User confirmed: Check passport validity for ${flightAlert}. I have opened the official site in a new tab for them.` });
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
                        triggerTutorial();
                      }}
                      className="flex-1 md:flex-none px-6 py-3 bg-emerald-100 text-emerald-700 rounded-xl font-bold hover:bg-emerald-200 transition-all flex items-center gap-2"
                    >
                      <Globe className="w-4 h-4" />
                      Watch Tutorial
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
            <div className="w-full h-full relative">
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

      {/* Tutorial Modal */}
      <AnimatePresence>
        {showTutorial && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white rounded-[2rem] shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-black/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600">
                    <Globe className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">Requirement Lookup Tutorial</h3>
                    <p className="text-xs text-black/40 font-mono uppercase">Screen Recording Guide</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowTutorial(false)}
                  className="w-10 h-10 rounded-full hover:bg-black/5 flex items-center justify-center transition-colors"
                >
                  <ChevronRight className="w-6 h-6 rotate-90" />
                </button>
              </div>
              
              <div className="aspect-video bg-black relative group">
                {/* Placeholder Video - User should replace this with their actual recording */}
                <video 
                  controls 
                  autoPlay
                  className="w-full h-full"
                  src="https://www.w3schools.com/html/mov_bbb.mp4" 
                />
                <div className="absolute inset-0 pointer-events-none border-4 border-emerald-500/20 m-4 rounded-xl" />
              </div>

              <div className="p-8 bg-emerald-50/50 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-emerald-900">Ready to check your destination?</p>
                  <p className="text-xs text-emerald-700/70">This guide shows you exactly where to look on travel.state.gov</p>
                </div>
                <div className="flex gap-3 w-full md:w-auto">
                  <button 
                    onClick={() => {
                      window.open('https://travel.state.gov/en/international-travel.html', '_blank');
                      setShowTutorial(false);
                    }}
                    className="flex-1 md:flex-none px-8 py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open State Dept Site
                  </button>
                  <button 
                    onClick={() => setShowTutorial(false)}
                    className="flex-1 md:flex-none px-8 py-3 bg-white text-[#151619] border border-black/10 rounded-xl font-medium hover:bg-black/5 transition-all"
                  >
                    Close Guide
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
