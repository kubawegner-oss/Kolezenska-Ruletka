import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, Users, Trophy, Play, Clock, CheckCircle2, XCircle, Loader2, MessageCircle, Send, X, Shuffle } from 'lucide-react';

const sharedClientToken = (() => {
  if (typeof window === 'undefined') return 'server';
  const key = 'photo-roulette-client-token';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(key, generated);
  return generated;
})();

const sharedSocket = (() => {
  if (typeof window === 'undefined') return null;

  const configuredSocketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined)?.trim();
  const socketUrl = configuredSocketUrl || window.location.origin;

  const w = window as Window & { __photoRouletteSocket?: Socket };
  if (!w.__photoRouletteSocket) {
    w.__photoRouletteSocket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      timeout: 10000,
    });
  }
  return w.__photoRouletteSocket;
})();

interface Player {
  id: string;
  name: string;
  score: number;
  photosUploaded: boolean;
  isHost: boolean;
}

interface Photo {
  ownerId: string;
  ownerName: string;
  data: string;
}

interface GameState {
  status: 'LOBBY' | 'UPLOADING' | 'PLAYING' | 'ROUND_RESULTS' | 'GAME_OVER';
  players: Record<string, Player>;
  photos: Photo[];
  currentRound: number;
  totalRounds: number;
  currentPhoto: Photo | null;
  roundStartTime: number;
  roundDuration: number;
  guesses: Record<string, string>;
  guessTimes: Record<string, number>;
  hostId: string | null;
}

interface ChatMessage {
  id: string;
  senderName: string;
  message: string;
  timestamp: number;
}

interface ReactionEvent {
  id: string;
  senderName: string;
  emoji: string;
  timestamp: number;
  x: number;
}

interface CelebrationPopup {
  id: string;
  text: string;
  x: number;
  y: number;
  rotate: number;
  scale: number;
  tone: string;
}

interface ReviewPhotoItem {
  id: string;
  file: File;
  previewUrl: string;
  loaded: boolean;
}

interface PhotoReviewState {
  selected: ReviewPhotoItem[];
  pool: ReviewPhotoItem[];
}

const celebrationPhrases = ['WOW', 'SZTOS', 'YASSS', '<3', 'OMG', 'LETS GO', 'ICONIC', 'MEGA'];
const celebrationTones = [
  'from-fuchsia-400 via-pink-400 to-orange-300 text-white shadow-fuchsia-500/30',
  'from-cyan-400 via-sky-400 to-indigo-300 text-white shadow-cyan-500/30',
  'from-amber-300 via-yellow-300 to-lime-300 text-zinc-950 shadow-amber-500/20',
  'from-emerald-400 via-teal-400 to-cyan-300 text-white shadow-emerald-500/30',
];

function displayName(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'name' in value) {
    const nested = (value as { name?: unknown }).name;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return 'Player';
}

function sampleRandomItems<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function createReviewPhotoId(file: File): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
}

function createReviewPhotoItem(file: File): ReviewPhotoItem {
  return {
    id: createReviewPhotoId(file),
    file,
    previewUrl: URL.createObjectURL(file),
    loaded: false,
  };
}

function releaseReviewSelection(selection: PhotoReviewState | null) {
  if (!selection) return;

  for (const item of [...selection.selected, ...selection.pool]) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const runWorker = async () => {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [name, setName] = useState('');
  const [isJoined, setIsJoined] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [roundCount, setRoundCount] = useState(10);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [floatingReactions, setFloatingReactions] = useState<ReactionEvent[]>([]);
  const [celebrationPopups, setCelebrationPopups] = useState<CelebrationPopup[]>([]);
  const [animatedScores, setAnimatedScores] = useState<Record<string, number>>({});
  const [photoReview, setPhotoReview] = useState<PhotoReviewState | null>(null);
  const lastCelebrationKeyRef = useRef<string>('');
  const celebrationTimeoutRef = useRef<number | null>(null);
  const scoreAnimationRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastReactionSentAtRef = useRef(0);
  const photoReviewRef = useRef<PhotoReviewState | null>(null);

  useEffect(() => {
    const savedMessages = window.localStorage.getItem('photo-roulette-chat');
    if (savedMessages) {
      try {
        setChatMessages(JSON.parse(savedMessages));
      } catch {
        window.localStorage.removeItem('photo-roulette-chat');
      }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('photo-roulette-chat', JSON.stringify(chatMessages.slice(-50)));
  }, [chatMessages]);

  useEffect(() => {
    photoReviewRef.current = photoReview;
  }, [photoReview]);

  useEffect(() => {
    if (!chatOpen) return;
    const panel = chatScrollRef.current;
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }, [chatMessages, chatOpen]);

  useEffect(() => {
    const newSocket = sharedSocket;
    if (!newSocket) return;

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      newSocket.emit('requestState');
    });

    newSocket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
    });

    newSocket.on('gameState', (state: GameState) => {
      console.log('Received game state:', state.status);
      setGameState(state);
    });

    newSocket.on('chatHistory', (history: ChatMessage[]) => {
      setChatMessages((current) => {
        const combined = [...current, ...history];
        const unique = Array.from(new Map(combined.map((item) => [item.id, item])).values());
        return unique.slice(-50);
      });
    });

    newSocket.on('chatMessage', (message: ChatMessage) => {
      setChatMessages((current) => [...current, message].slice(-50));
    });

    newSocket.on('photoReaction', (reaction: Omit<ReactionEvent, 'x'>) => {
      const id = `${reaction.id}-${Math.random().toString(36).slice(2)}`;
      const x = 12 + Math.random() * 76;
      const floatingReaction: ReactionEvent = { ...reaction, id, x };

      setFloatingReactions((current) => [...current, floatingReaction]);

      window.setTimeout(() => {
        setFloatingReactions((current) => current.filter((item) => item.id !== id));
      }, 1600);
    });

    newSocket.on('error', (msg: string) => {
      alert(msg);
    });

    if (newSocket.connected) {
      newSocket.emit('requestState');
    }

    return () => {
      newSocket.off('connect');
      newSocket.off('connect_error');
      newSocket.off('gameState');
      newSocket.off('chatMessage');
      newSocket.off('chatHistory');
      newSocket.off('photoReaction');
      newSocket.off('error');
      newSocket.off('requestState');
    };
  }, []);

  useEffect(() => {
    if (gameState?.status === 'PLAYING' && gameState.roundStartTime) {
      const updateTimeLeft = () => {
        const elapsed = Date.now() - gameState.roundStartTime;
        const remaining = Math.max(0, Math.ceil((gameState.roundDuration - elapsed) / 1000));
        setTimeLeft((current) => (current === remaining ? current : remaining));
      };

      updateTimeLeft();
      const interval = setInterval(() => {
        updateTimeLeft();
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [gameState?.status, gameState?.roundStartTime, gameState?.roundDuration]);

  useEffect(() => {
    if (!isUploading || !gameState) return;

    const myPlayer = socket?.id ? gameState.players[socket.id] : null;
    if (gameState.status !== 'UPLOADING' || myPlayer?.photosUploaded) {
      setIsUploading(false);
      setUploadProgress(0);

      if (myPlayer?.photosUploaded) {
        releaseReviewSelection(photoReviewRef.current);
        photoReviewRef.current = null;
        setPhotoReview(null);
      }
    }
  }, [gameState, isUploading, socket?.id]);

  useEffect(() => {
    const currentPhoto = gameState?.currentPhoto;
    const celebrationKey = gameState?.status && currentPhoto
      ? `${gameState.status}-${gameState.currentRound}-${currentPhoto.ownerId}`
      : '';

    if (!currentPhoto || gameState?.status !== 'PLAYING') {
      setCelebrationPopups([]);
      lastCelebrationKeyRef.current = '';
      return;
    }

    if (lastCelebrationKeyRef.current === celebrationKey) {
      return;
    }

    lastCelebrationKeyRef.current = celebrationKey;

    if (Math.random() > 0.45) {
      setCelebrationPopups([]);
      return;
    }

    if (celebrationTimeoutRef.current) {
      window.clearTimeout(celebrationTimeoutRef.current);
      celebrationTimeoutRef.current = null;
    }

    const popupCount = 1 + Math.floor(Math.random() * 3);
    const popups = Array.from({ length: popupCount }, (_, index) => {
      const id = `${gameState.currentRound}-${currentPhoto.ownerId ?? 'photo'}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;

      return {
        id,
        text: celebrationPhrases[Math.floor(Math.random() * celebrationPhrases.length)],
        x: 8 + Math.random() * 76,
        y: 12 + Math.random() * 58,
        rotate: -18 + Math.random() * 36,
        scale: 0.85 + Math.random() * 0.45,
        tone: celebrationTones[Math.floor(Math.random() * celebrationTones.length)],
      } satisfies CelebrationPopup;
    });

    setCelebrationPopups(popups);

    celebrationTimeoutRef.current = window.setTimeout(() => {
      setCelebrationPopups((current) => current.filter((popup) => !popups.some((item) => item.id === popup.id)));
      celebrationTimeoutRef.current = null;
    }, 1200);

    return () => {
      if (celebrationTimeoutRef.current) {
        window.clearTimeout(celebrationTimeoutRef.current);
        celebrationTimeoutRef.current = null;
      }
    };
  }, [gameState?.currentPhoto, gameState?.currentRound, gameState?.status]);

  useEffect(() => {
    return () => {
      if (celebrationTimeoutRef.current) {
        window.clearTimeout(celebrationTimeoutRef.current);
      }
      if (scoreAnimationRef.current) {
        window.cancelAnimationFrame(scoreAnimationRef.current);
      }
      releaseReviewSelection(photoReviewRef.current);
    };
  }, []);

  useEffect(() => {
    const scoreEntries = Object.entries(gameState?.players ?? {}) as Array<[string, Player]>;
    if (scoreEntries.length === 0) {
      setAnimatedScores({});
      return;
    }

    const targetScores = Object.fromEntries(scoreEntries.map(([id, player]) => [id, player.score]));

    if (Object.keys(animatedScores).length === 0) {
      setAnimatedScores(targetScores);
      return;
    }

    const startScores = { ...animatedScores };
    const duration = 650;
    const start = performance.now();

    if (scoreAnimationRef.current) {
      window.cancelAnimationFrame(scoreAnimationRef.current);
    }

    const tick = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextScores: Record<string, number> = {};

      for (const [id, target] of Object.entries(targetScores)) {
        const from = startScores[id] ?? 0;
        nextScores[id] = Math.round(from + (target - from) * eased);
      }

      setAnimatedScores(nextScores);

      if (progress < 1) {
        scoreAnimationRef.current = window.requestAnimationFrame(tick);
      } else {
        scoreAnimationRef.current = null;
      }
    };

    scoreAnimationRef.current = window.requestAnimationFrame(tick);
  }, [gameState?.players]);

  const joinGame = () => {
    if (name.trim() && socket) {
      socket.emit('join', { name: name.trim(), clientToken: sharedClientToken });
      setIsJoined(true);
    }
  };

  const startGame = () => {
    socket?.emit('startGame', roundCount);
  };

  const sendChatMessage = () => {
    const message = chatText.trim();
    if (!message || !socket) return;

    socket.emit('chatMessage', message);
    setChatText('');
  };

  const sendReaction = (emoji: string) => {
    if (!socket) return;

    const now = Date.now();
    if (now - lastReactionSentAtRef.current < 250) {
      return;
    }

    lastReactionSentAtRef.current = now;
    socket.emit('photoReaction', emoji);
  };

  const openPhotoReview = (files: File[]) => {
    if (files.length < 10) {
      alert('Please select at least 10 photos for the roulette!');
      return;
    }

    releaseReviewSelection(photoReviewRef.current);

    const pickedFiles = sampleRandomItems(files, 10);
    const pickedSet = new Set(pickedFiles);
    const poolFiles = files.filter((file) => !pickedSet.has(file));

    setUploadProgress(0);
    setIsUploading(false);
    setPhotoReview({
      selected: pickedFiles.map(createReviewPhotoItem),
      pool: sampleRandomItems(poolFiles, poolFiles.length).map(createReviewPhotoItem),
    });
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    openPhotoReview(files);
    e.target.value = '';
  };

  const markReviewPhotoLoaded = (photoId: string) => {
    setPhotoReview((current) => {
      if (!current) return current;

      return {
        ...current,
        selected: current.selected.map((item) => (item.id === photoId ? { ...item, loaded: true } : item)),
        pool: current.pool.map((item) => (item.id === photoId ? { ...item, loaded: true } : item)),
      };
    });
  };

  const swapReviewPhoto = (photoId: string) => {
    setPhotoReview((current) => {
      if (!current || current.pool.length === 0) return current;

      const selectedIndex = current.selected.findIndex((item) => item.id === photoId);
      if (selectedIndex === -1) return current;

      const poolIndex = Math.floor(Math.random() * current.pool.length);
      const replacement = current.pool[poolIndex];
      const replacedPhoto = current.selected[selectedIndex];

      const nextSelected = [...current.selected];
      nextSelected[selectedIndex] = replacement;

      const nextPool = [...current.pool];
      nextPool.splice(poolIndex, 1, replacedPhoto);

      return {
        ...current,
        selected: nextSelected,
        pool: nextPool,
      };
    });
  };

  const confirmPhotoReview = async () => {
    if (!photoReview || photoReview.selected.length < 10 || isUploading) return;

    if (!socket) {
      alert('Unable to connect to the server. Please try again.');
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const selectedFiles: File[] = photoReview.selected.map((item) => item.file);
      let completed = 0;
      const processedPhotos = await mapWithConcurrency(selectedFiles, 3, async (file) => {
        const resized = await resizeAndCompressImage(file);
        completed += 1;
        setUploadProgress(Math.round((completed / selectedFiles.length) * 95));
        return resized;
      });

      setUploadProgress(100);
      socket.emit('uploadPhotos', processedPhotos);
    } catch (error) {
      console.error('Photo processing failed:', error);
      alert('Unable to process photos. Please try again.');
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const resizeAndCompressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image'));
      };
      img.onload = async () => {
        const MAX_DIMENSION = 1024;
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Canvas not supported'));
          return;
        }

        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(img, 0, 0, width, height);

        const base64 = canvas.toDataURL('image/jpeg', 0.6);
        canvas.width = 0;
        canvas.height = 0;
        URL.revokeObjectURL(objectUrl);
        resolve(base64);
      };
    });
  };

  const submitGuess = (playerId: string) => {
    socket?.emit('submitGuess', playerId);
  };

  if (!gameState) {
    return (
      <div className="relative min-h-dvh overflow-hidden bg-[#09090f] text-zinc-100">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.30),transparent_30%),radial-gradient(circle_at_top_right,rgba(34,211,238,0.22),transparent_28%),radial-gradient(circle_at_bottom,rgba(250,204,21,0.15),transparent_30%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.07)_0%,transparent_20%,transparent_80%,rgba(255,255,255,0.05)_100%)] opacity-60" />
        <div className="relative flex min-h-dvh items-center justify-center p-4">
          <div className="flex flex-col items-center gap-4 rounded-3xl border border-white/10 bg-white/5 px-6 py-8 shadow-2xl shadow-fuchsia-950/20 backdrop-blur-xl">
            <Loader2 className="h-8 w-8 animate-spin text-fuchsia-400" />
            <p className="font-medium text-zinc-200">Connecting to game server...</p>
          </div>
        </div>
      </div>
    );
  }

  const myId = socket?.id;
  const players: Player[] = Object.values(gameState.players);
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  const maxScore = Math.max(...players.map((p) => p.score), 1);
  const myGuessSubmitted = !!gameState.guesses[myId || ''];
  const me = myId ? gameState.players[myId] : null;
  const isHost = !!me?.isHost || gameState.hostId === myId;
  const reviewSelectedCount = photoReview?.selected.length ?? 0;
  const reviewPoolCount = photoReview?.pool.length ?? 0;
  const canSwapPhoto = reviewPoolCount > 0;

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#09090f] text-zinc-100 font-sans selection:bg-fuchsia-500/30 selection:text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute -left-24 top-0 h-72 w-72 rounded-full bg-fuchsia-500/30 blur-3xl"
          animate={{ x: [0, 24, 0], y: [0, 18, 0], scale: [1, 1.08, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute right-[-5rem] top-20 h-80 w-80 rounded-full bg-cyan-400/25 blur-3xl"
          animate={{ x: [0, -18, 0], y: [0, 20, 0], scale: [1, 1.12, 1] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-[-6rem] left-1/4 h-96 w-96 rounded-full bg-amber-300/20 blur-3xl"
          animate={{ x: [0, 14, 0], y: [0, -16, 0], scale: [1, 1.05, 1] }}
          transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(255,255,255,0.05),transparent_24%),radial-gradient(circle_at_center,rgba(255,255,255,0.03),transparent_45%)]" />
      </div>

      <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        
        {/* Header */}
        <header className="sticky top-0 z-20 -mx-4 mb-6 flex items-center justify-between border-b border-white/10 bg-zinc-950/65 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 shadow-lg shadow-fuchsia-900/30 ring-1 ring-white/20">
              <Camera className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black tracking-tight sm:text-xl bg-gradient-to-r from-white via-fuchsia-200 to-cyan-200 bg-clip-text text-transparent">Koleżeńska Ruletka</h1>
                {isHost && isJoined && (
                  <span className="rounded-full border border-fuchsia-400/40 bg-fuchsia-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-fuchsia-300">
                    Host
                  </span>
                )}
              </div>
            </div>
          </div>
          {isJoined && (
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 shadow-lg shadow-black/10 backdrop-blur-md">
              <Users className="h-4 w-4 text-cyan-300" />
              <span className="text-sm font-medium">{players.length}/10</span>
            </div>
          )}
        </header>

        <main className="flex flex-1 flex-col pb-4">
          <AnimatePresence mode="wait">
            
            {/* Lobby / Join Screen */}
            {!isJoined && (
              <motion.div
                key="join"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col gap-6 pt-8 sm:pt-12"
              >
                <div className="space-y-2">
                  <h2 className="text-3xl font-black sm:text-4xl bg-gradient-to-r from-fuchsia-300 via-pink-200 to-cyan-200 bg-clip-text text-transparent">Welcome!</h2>
                  <p className="text-sm text-zinc-300 sm:text-base">Enter your nickname to join the room.</p>
                </div>
                <div className="space-y-4">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your nickname"
                    className="w-full rounded-3xl border border-white/10 bg-white/8 px-6 py-4 text-base shadow-lg shadow-black/10 transition-all placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-fuchsia-500 sm:text-lg"
                    onKeyDown={(e) => e.key === 'Enter' && joinGame()}
                  />
                  <button
                    onClick={joinGame}
                    disabled={!name.trim()}
                    className="flex w-full items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-4 font-black text-white shadow-xl shadow-fuchsia-900/30 transition-all hover:scale-[1.01] hover:from-fuchsia-400 hover:to-orange-300 disabled:opacity-50 disabled:hover:scale-100"
                  >
                    Join Room
                  </button>
                </div>
              </motion.div>
            )}

            {/* In Lobby */}
            {isJoined && gameState.status === 'LOBBY' && (
              <motion.div
                key="lobby"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-6"
              >
                <div className="space-y-4">
                  <h2 className="text-3xl font-black sm:text-4xl bg-gradient-to-r from-cyan-200 via-fuchsia-200 to-orange-200 bg-clip-text text-transparent">Waiting for players...</h2>
                  <div className="grid gap-3">
                    {players.map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded-3xl border border-white/10 bg-white/6 p-4 shadow-lg shadow-black/10 backdrop-blur-sm">
                        <span className="font-medium">{displayName(p.name)} {p.id === myId && "(You)"}</span>
                        {p.id === myId && <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />}
                      </div>
                    ))}
                  </div>
                </div>
                
                {isHost && (
                  <div className="space-y-4 rounded-[1.75rem] border border-white/10 bg-gradient-to-br from-fuchsia-500/10 via-white/5 to-cyan-500/10 p-4 shadow-xl shadow-fuchsia-950/10 backdrop-blur-xl">
                    <div className="space-y-1">
                      <h3 className="text-sm font-black uppercase tracking-widest text-fuchsia-200">Game Settings</h3>
                      <p className="text-sm text-zinc-300">Choose how many rounds this game should have.</p>
                    </div>
                    <label className="block space-y-2">
                      <span className="text-xs font-black uppercase tracking-widest text-cyan-200">Rounds</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={roundCount}
                        onChange={(e) => setRoundCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                        className="w-full rounded-2xl border border-white/10 bg-zinc-950/80 px-4 py-3 text-base font-bold text-zinc-100 outline-none focus:ring-2 focus:ring-fuchsia-500"
                      />
                    </label>
                  </div>
                )}

                {isHost && (
                  <div className="rounded-3xl border border-fuchsia-400/20 bg-fuchsia-400/10 p-3 text-sm text-fuchsia-100 backdrop-blur-sm">
                    {players.length >= 2
                      ? 'You are the host. Choose rounds and start the game when ready.'
                      : 'You are the host. The Start Game button will activate when at least 2 players are in the room.'}
                  </div>
                )}

                {isHost && (
                  <button
                    onClick={startGame}
                    disabled={players.length < 2}
                    className="flex w-full items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-4 font-black text-white shadow-xl shadow-fuchsia-900/30 transition-all hover:scale-[1.01] hover:from-fuchsia-400 hover:to-orange-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                  >
                    <Play className="w-5 h-5 fill-current" />
                    Start Game
                  </button>
                )}
                {!isHost && players.length >= 2 && (
                  <p className="text-center text-sm text-zinc-400 italic">Waiting for the host to start the game</p>
                )}
                {players.length < 2 && (
                  <p className="text-center text-zinc-400 text-sm italic">Need at least 2 players to start</p>
                )}
              </motion.div>
            )}

            {/* Uploading Screen */}
            {isJoined && gameState.status === 'UPLOADING' && (
              <motion.div
                key="uploading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-8 flex flex-col items-center gap-8 text-center"
              >
                {!me?.photosUploaded ? (
                  <>
                    <div className="space-y-2">
                      <h2 className="text-3xl font-black sm:text-4xl bg-gradient-to-r from-fuchsia-300 via-pink-200 to-cyan-200 bg-clip-text text-transparent">Photo Roulette!</h2>
                      <p className="text-sm text-zinc-300 sm:text-base">Select a batch of photos. We'll randomly pick 10 for the game.</p>
                    </div>

                    {!photoReview ? (
                      <label className="group flex w-full aspect-square max-w-[min(280px,80vw)] cursor-pointer flex-col items-center justify-center gap-4 rounded-[2rem] border-2 border-dashed border-fuchsia-300/30 bg-gradient-to-br from-white/8 via-fuchsia-500/10 to-cyan-500/10 transition-all hover:scale-[1.01] hover:border-fuchsia-300/60">
                        <input
                          type="file"
                          multiple
                          accept="image/*"
                          onChange={handlePhotoUpload}
                          className="hidden"
                          disabled={isUploading}
                        />
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 shadow-lg shadow-fuchsia-900/30 transition-transform group-hover:scale-110">
                          <Camera className="h-8 w-8 text-white" />
                        </div>
                        <span className="font-bold text-lg">Access Gallery</span>
                      </label>
                    ) : (
                      <div className="w-full space-y-4 text-left">
                        <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-4 shadow-2xl shadow-black/20 backdrop-blur-xl">
                          <div className="mb-4 flex items-start justify-between gap-4">
                            <div>
                              <h3 className="text-xl font-black text-white">Review &amp; Swap</h3>
                              <p className="mt-1 text-sm text-zinc-300">Ten random photos are ready. Swap any of them before the upload.</p>
                            </div>
                            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-right">
                              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">Selected</p>
                              <p className="text-lg font-black text-white">{reviewSelectedCount}/10</p>
                            </div>
                          </div>

                          <div className="max-h-[min(58dvh,540px)] overflow-y-auto rounded-[1.5rem] border border-white/10 bg-zinc-950/30 p-3">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                              {photoReview.selected.map((photo, index) => (
                                <div key={photo.id} className="group relative overflow-hidden rounded-[1.35rem] border border-white/10 bg-zinc-900 shadow-lg shadow-black/20">
                                  <div className="relative aspect-square">
                                    <img
                                      src={photo.previewUrl}
                                      alt={`Selected photo ${index + 1}`}
                                      onLoad={() => markReviewPhotoLoaded(photo.id)}
                                      onError={() => markReviewPhotoLoaded(photo.id)}
                                      className={`h-full w-full object-cover transition-all duration-300 ${photo.loaded ? 'scale-100 opacity-100' : 'scale-[1.02] opacity-0'}`}
                                    />
                                    {!photo.loaded && (
                                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-white/10 via-white/5 to-cyan-400/10 text-zinc-200">
                                        <Loader2 className="h-5 w-5 animate-spin text-fuchsia-300" />
                                        <span className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-300">Loading...</span>
                                      </div>
                                    )}
                                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,transparent_65%,rgba(0,0,0,0.58)_100%)]" />
                                    <div className="absolute left-2 top-2 rounded-full border border-white/15 bg-black/35 px-2 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-white backdrop-blur-md">
                                      #{index + 1}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => swapReviewPhoto(photo.id)}
                                      disabled={!canSwapPhoto || isUploading}
                                      className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-lg shadow-black/20 backdrop-blur-md transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      <Shuffle className="h-3.5 w-3.5" />
                                      Swap
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="mt-4 space-y-3">
                            {!canSwapPhoto ? (
                              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm font-medium text-amber-100">
                                Wybierz więcej zdjęć z galerii, aby mieć na co wymienić!
                              </div>
                            ) : (
                              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-300">
                                You have {reviewPoolCount} spare photo{reviewPoolCount === 1 ? '' : 's'} in the pool.
                              </div>
                            )}

                            <div className="grid gap-3 sm:grid-cols-2">
                              <button
                                type="button"
                                onClick={() => {
                                  releaseReviewSelection(photoReviewRef.current);
                                  photoReviewRef.current = null;
                                  setPhotoReview(null);
                                  setUploadProgress(0);
                                }}
                                disabled={isUploading}
                                className="rounded-3xl border border-white/10 bg-white/5 py-4 font-black text-zinc-200 transition-all hover:border-white/20 hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Choose Different Photos
                              </button>
                              <button
                                type="button"
                                onClick={confirmPhotoReview}
                                disabled={isUploading}
                                className="flex items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-4 font-black text-white shadow-xl shadow-fuchsia-900/30 transition-all hover:scale-[1.01] hover:from-fuchsia-400 hover:to-orange-300 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
                              >
                                {isUploading ? (
                                  <>
                                    <Loader2 className="h-5 w-5 animate-spin" />
                                    Preparing Upload... {uploadProgress}%
                                  </>
                                ) : (
                                  'Zatwierdź i Graj'
                                )}
                              </button>
                            </div>

                            {isUploading && (
                              <div className="space-y-2 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-3 text-sm text-fuchsia-100">
                                <div className="flex items-center gap-2 font-semibold">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  <span>Compressing and sending photos...</span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                                  <div
                                    className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 via-pink-400 to-cyan-300 transition-[width] duration-300"
                                    style={{ width: `${uploadProgress}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-6">
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-500/10">
                      <CheckCircle2 className="w-10 h-10 text-green-500" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-3xl font-black bg-gradient-to-r from-emerald-300 to-cyan-200 bg-clip-text text-transparent">Ready!</h2>
                      <p className="text-sm text-zinc-300 sm:text-base">Waiting for other players to finish uploading...</p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                      {players.map(p => (
                        <div key={p.id} className={`px-3 py-1 rounded-full text-xs font-bold ${p.photosUploaded ? 'bg-green-500/20 text-green-300' : 'bg-white/6 text-zinc-400'}`}>
                          {displayName(p.name)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* Playing Screen */}
            {isJoined && gameState.status === 'PLAYING' && (
              <motion.div
                key="playing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-black uppercase tracking-widest text-cyan-200/90 sm:text-sm">Round {gameState.currentRound}/{gameState.totalRounds}</span>
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-2 font-mono text-lg font-black text-fuchsia-300 shadow-lg shadow-black/10 sm:text-xl">
                    <Clock className="w-5 h-5" />
                    {timeLeft}s
                  </div>
                </div>

                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[2rem] border border-white/10 bg-zinc-900 shadow-2xl shadow-fuchsia-950/30 ring-1 ring-white/5">
                  {gameState.currentPhoto && (
                    <img
                      src={gameState.currentPhoto.data}
                      alt="Roulette"
                      className="h-full w-full object-cover"
                    />
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_0%,rgba(0,0,0,0.08)_55%,rgba(0,0,0,0.45)_100%)]" />
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/20 to-transparent mix-blend-screen" />
                  <div className="pointer-events-none absolute inset-0 overflow-hidden">
                    <AnimatePresence>
                      {celebrationPopups.map((popup) => (
                        <motion.div
                          key={popup.id}
                          initial={{ opacity: 0, scale: 0.6, y: 18 }}
                          animate={{ opacity: [0, 1, 1, 0], scale: [popup.scale * 0.9, popup.scale * 1.12, popup.scale], y: -110 }}
                          exit={{ opacity: 0, scale: 0.5 }}
                          transition={{ duration: 1.7, ease: 'easeOut' }}
                          className={`absolute rounded-full border border-white/15 bg-gradient-to-r px-4 py-2 text-sm font-black uppercase tracking-[0.25em] backdrop-blur-md ${popup.tone}`}
                          style={{ left: `${popup.x}%`, top: `${popup.y}%`, rotate: `${popup.rotate}deg`, transform: `translate(-50%, -50%) scale(${popup.scale})` }}
                        >
                          {popup.text}
                        </motion.div>
                      ))}
                      {floatingReactions.map((reaction) => (
                        <motion.div
                          key={reaction.id}
                          initial={{ opacity: 0, y: 20, scale: 0.7 }}
                          animate={{ opacity: 1, y: -120, scale: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 1.5, ease: 'easeOut' }}
                          className="absolute text-4xl drop-shadow-lg"
                          style={{ left: `${reaction.x}%`, bottom: '12%' }}
                        >
                          {reaction.emoji}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  {gameState.guesses[myId || ''] && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                      <div className="text-center space-y-2">
                        <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
                        <p className="font-bold text-xl">Guess Submitted!</p>
                        <p className="text-zinc-400 text-sm">Waiting for others...</p>
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
                    <div className="flex gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-2 backdrop-blur-xl shadow-lg shadow-black/20">
                      {['🔥', '😂', '😮', '👏'].map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => sendReaction(emoji)}
                          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl transition-transform hover:scale-110 active:scale-95"
                          aria-label={`Send reaction ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="vote-grid">
                  {players.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => submitGuess(p.id)}
                      disabled={myGuessSubmitted}
                      className={`min-h-14 rounded-2xl border px-4 py-4 text-sm font-bold transition-all ${
                        gameState.guesses[myId || ''] === p.id
                          ? 'bg-gradient-to-r from-fuchsia-500 to-orange-400 border-fuchsia-300 text-white shadow-lg shadow-fuchsia-900/20'
                          : 'bg-white/6 border-white/10 hover:border-fuchsia-300/40 text-zinc-200'
                      } disabled:opacity-50`}
                    >
                      <span className="inline-flex items-center gap-2">
                        {displayName(p.name)}
                        {!gameState.guesses[p.id] ? (
                          <span className="h-2 w-2 rounded-full bg-amber-300 animate-pulse" aria-label="Waiting for vote" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                        )}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="grid gap-2 rounded-2xl border border-white/10 bg-white/5 p-3">
                  <p className="text-[11px] font-black uppercase tracking-widest text-zinc-400">Who is still voting?</p>
                  <div className="flex flex-wrap gap-2">
                    {players.map((player) => {
                      const waiting = !gameState.guesses[player.id];
                      return (
                        <span
                          key={player.id}
                          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                            waiting ? 'bg-amber-300/15 text-amber-200' : 'bg-emerald-300/15 text-emerald-200'
                          }`}
                        >
                          <span className={`h-2 w-2 rounded-full ${waiting ? 'bg-amber-300 animate-pulse' : 'bg-emerald-300'}`} />
                          {displayName(player.name)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Round Results */}
            {isJoined && gameState.status === 'ROUND_RESULTS' && (
              <motion.div
                key="results"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col gap-6"
              >
                <div className="space-y-2 text-center">
                  <h2 className="text-xs font-black uppercase tracking-widest text-cyan-200 sm:text-sm">The Owner Was</h2>
                  <p className="text-3xl font-black sm:text-4xl bg-gradient-to-r from-fuchsia-300 via-pink-200 to-orange-200 bg-clip-text text-transparent">{displayName(gameState.currentPhoto?.ownerName)}</p>
                </div>

                <div className="relative aspect-video w-full overflow-hidden rounded-[2rem] border border-fuchsia-400/30 bg-zinc-900 shadow-2xl shadow-fuchsia-900/20 ring-1 ring-white/10">
                  {gameState.currentPhoto && (
                    <img
                      src={gameState.currentPhoto.data}
                      alt="Roulette"
                      className="h-full w-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),transparent_40%),linear-gradient(180deg,transparent,rgba(0,0,0,0.28))]" />
                </div>

                <div className="space-y-4">
                  <h3 className="flex items-center gap-2 font-bold">
                    <Trophy className="w-5 h-5 text-amber-300" />
                    Leaderboard
                  </h3>
                  <div className="grid gap-2">
                    {sortedPlayers.map((p, idx) => {
                      const isCorrect = gameState.guesses[p.id] === gameState.currentPhoto?.ownerId;
                      const scorePercent = Math.max(6, Math.round((p.score / maxScore) * 100));
                      return (
                        <div key={p.id} className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/6 p-4 shadow-lg shadow-black/10 backdrop-blur-sm">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${scorePercent}%` }}
                            transition={{ duration: 0.6, ease: 'easeOut' }}
                            className="pointer-events-none absolute inset-y-0 left-0 rounded-2xl bg-gradient-to-r from-fuchsia-500/25 to-cyan-400/20"
                          />
                          <div className="relative z-10 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                            <span className="text-zinc-500 font-mono w-4">{idx + 1}.</span>
                            <span className="font-bold">{displayName(p.name)}</span>
                            {isCorrect ? (
                              <CheckCircle2 className="w-4 h-4 text-green-500" />
                            ) : (
                              <XCircle className="w-4 h-4 text-red-500/50" />
                            )}
                          </div>
                            <span className="font-mono font-bold text-fuchsia-300">{animatedScores[p.id] ?? p.score}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Game Over */}
            {isJoined && gameState.status === 'GAME_OVER' && (
              <motion.div
                key="gameover"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-6 flex flex-col items-center gap-8 text-center"
              >
                <div className="space-y-2">
                  <Trophy className="mx-auto mb-4 h-16 w-16 text-amber-300" />
                  <h2 className="text-3xl font-black sm:text-4xl bg-gradient-to-r from-fuchsia-300 via-pink-200 to-cyan-200 bg-clip-text text-transparent">Game Over!</h2>
                  <p className="text-sm text-zinc-300 sm:text-base">Final scores are in.</p>
                </div>

                <div className="w-full space-y-3">
                  {sortedPlayers.map((p, idx) => (
                    <div key={p.id} className={`flex items-center justify-between rounded-3xl border p-4 sm:p-5 ${idx === 0 ? 'border-fuchsia-300/40 bg-gradient-to-r from-fuchsia-500/20 via-pink-500/15 to-orange-400/20' : 'border-white/10 bg-white/6'}`}>
                      <div className="flex items-center gap-4">
                        <span className={`text-2xl font-black ${idx === 0 ? 'text-amber-300' : 'text-zinc-400'}`}>{idx + 1}</span>
                        <span className="text-lg font-bold sm:text-xl">{displayName(p.name)}</span>
                      </div>
                      <span className="text-2xl font-mono font-black text-fuchsia-300">{animatedScores[p.id] ?? p.score}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => window.location.reload()}
                  className="w-full rounded-3xl bg-gradient-to-r from-white via-fuchsia-100 to-cyan-100 py-4 font-black text-zinc-950 shadow-xl shadow-black/20 transition-all hover:scale-[1.01] hover:from-white hover:to-white"
                >
                  Play Again
                </button>
              </motion.div>
            )}

          </AnimatePresence>
        </main>

        <footer className="mt-6 pb-2 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Photos are cleared after each game</p>
        </footer>
      </div>

      {isJoined && isHost && gameState?.status === 'LOBBY' && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-zinc-950/70 px-4 py-3 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-sm text-fuchsia-100">
              <span className="font-bold uppercase tracking-widest text-[10px]">Host Panel</span>
              <span>{roundCount} rounds</span>
            </div>
            <button
              onClick={startGame}
              disabled={players.length < 2}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-4 font-black text-white shadow-xl shadow-fuchsia-900/30 transition-all hover:scale-[1.01] hover:from-fuchsia-400 hover:to-orange-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
            >
              <Play className="w-5 h-5 fill-current" />
              Start Game
            </button>
          </div>
        </div>
      )}

      {isJoined && (
        <>
          <button
            onClick={() => setChatOpen((current) => !current)}
            className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 text-white shadow-2xl shadow-fuchsia-900/30 backdrop-blur-md transition-transform hover:scale-105"
            aria-label="Toggle chat"
          >
            <MessageCircle className="h-6 w-6" />
          </button>

          <motion.aside
            initial={false}
            animate={{ x: chatOpen ? 0 : '110%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-4 right-4 z-40 flex h-[min(70dvh,560px)] w-[min(90vw,360px)] flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-950/70 shadow-2xl shadow-black/30 backdrop-blur-xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-3">
              <div>
                <p className="text-sm font-bold">Chat</p>
                <p className="text-xs text-zinc-400">Real-time room messages</p>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-zinc-300"
                aria-label="Close chat"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div ref={chatScrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {chatMessages.length === 0 ? (
                <p className="text-sm text-zinc-500">No messages yet.</p>
              ) : (
                chatMessages.map((message) => (
                  <div key={message.id} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 backdrop-blur-sm">
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-fuchsia-300">{displayName(message.senderName)}</span>
                      <span className="text-zinc-500">
                        {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-100 break-words">{message.message}</p>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-white/10 bg-black/20 p-3">
              <div className="flex items-end gap-2">
                <input
                  type="text"
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  placeholder="Write a message..."
                  className="min-h-12 flex-1 rounded-2xl border border-white/10 bg-zinc-950/80 px-4 py-3 text-sm outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-fuchsia-500"
                  onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                />
                <button
                  onClick={sendChatMessage}
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-r from-fuchsia-500 to-orange-400 text-white transition-colors hover:from-fuchsia-400 hover:to-orange-300"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </div>
  );
}
