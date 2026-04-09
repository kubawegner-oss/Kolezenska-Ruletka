import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, 'dist');

interface Player {
  id: string;
  name: string;
  score: number;
  photosUploaded: boolean;
  ready: boolean;
  isHost: boolean;
  clientToken: string;
}

interface Photo {
  ownerId: string;
  ownerName: string;
  data: string; // base64
}

interface ChatMessage {
  id: string;
  senderName: string;
  message: string;
  timestamp: number;
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
  guesses: Record<string, string>; // playerId -> guessedPlayerId
  guessTimes: Record<string, number>; // playerId -> submission timestamp
  hostId: string | null;
  hostToken: string | null;
  chatHistory: ChatMessage[];
}

interface PublicPlayer {
  id: string;
  name: string;
  score: number;
  photosUploaded: boolean;
  ready: boolean;
  isHost: boolean;
}

interface PublicGameState extends Omit<GameState, 'players' | 'photos'> {
  players: Record<string, PublicPlayer>;
  photos: [];
  uploadedPhotos: number;
  expectedPhotos: number;
}

interface AckResponse {
  ok: boolean;
  message?: string;
}

let gameState: GameState = {
  status: 'LOBBY',
  players: {},
  photos: [],
  currentRound: 0,
  totalRounds: 0,
  currentPhoto: null,
  roundStartTime: 0,
  roundDuration: 15000, // 15 seconds per round
  guesses: {},
  guessTimes: {},
  hostId: null,
  hostToken: null,
  chatHistory: [],
};

let roundTimeout: NodeJS.Timeout | null = null;
let resultsTimeout: NodeJS.Timeout | null = null;

function normalizeText(value: unknown, fallback = 'Player'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (value && typeof value === 'object' && 'name' in value) {
    const nestedName = (value as { name?: unknown }).name;
    if (typeof nestedName === 'string' && nestedName.trim()) {
      return nestedName.trim();
    }
  }

  return fallback;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 50 * 1024 * 1024, // 50MB limit for photo uploads
    cors: process.env.NODE_ENV !== 'production'
      ? {
          origin: true,
          credentials: true,
        }
      : undefined,
  });

  function sanitizeState() {
    Object.values(gameState.players).forEach((player) => {
      player.name = normalizeText(player.name);
    });

    gameState.photos = gameState.photos.map((photo) => ({
      ...photo,
      ownerName: normalizeText(photo.ownerName),
    }));

    gameState.chatHistory = gameState.chatHistory.map((msg) => ({
      ...msg,
      senderName: normalizeText(msg.senderName),
      message: normalizeText(msg.message, ''),
    }));
  }

  function toPublicState(): PublicGameState {
    const players = Object.fromEntries(
      Object.values(gameState.players).map((player) => [
        player.id,
        {
          id: player.id,
          name: normalizeText(player.name),
          score: player.score,
          photosUploaded: player.photosUploaded,
          ready: player.ready,
          isHost: player.isHost,
        } satisfies PublicPlayer,
      ]),
    );

    const currentPhoto = gameState.currentPhoto
      ? {
          ownerId: gameState.currentPhoto.ownerId,
          ownerName: normalizeText(gameState.currentPhoto.ownerName),
          data: gameState.currentPhoto.data,
        }
      : null;

    return {
      status: gameState.status,
      players,
      photos: [],
      currentRound: gameState.currentRound,
      totalRounds: gameState.totalRounds,
      currentPhoto,
      roundStartTime: gameState.roundStartTime,
      roundDuration: gameState.roundDuration,
      guesses: gameState.guesses,
      guessTimes: gameState.guessTimes,
      hostId: gameState.hostId,
      hostToken: null,
      chatHistory: [],
      uploadedPhotos: gameState.photos.length,
      expectedPhotos: Object.keys(gameState.players).length * 10,
    };
  }

  function emitGameState(target?: Socket) {
    sanitizeState();
    const payload = toPublicState();

    if (target) {
      target.emit('gameState', payload);
      return;
    }

    io.emit('gameState', payload);
  }

  function syncHost() {
    const playerIds = Object.keys(gameState.players);

    if (playerIds.length === 0) {
      gameState.hostId = null;
      return;
    }

    if (!gameState.hostId || !gameState.players[gameState.hostId]) {
      gameState.hostId = playerIds[0];
    }

    if (gameState.hostToken) {
      const matchingPlayer = Object.values(gameState.players).find((player) => player.clientToken === gameState.hostToken);
      if (matchingPlayer) {
        gameState.hostId = matchingPlayer.id;
      }
    }

    Object.values(gameState.players).forEach((player) => {
      player.isHost = player.id === gameState.hostId;
    });
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send initial state to the new client
    emitGameState(socket);
    socket.emit('chatHistory', gameState.chatHistory);

    socket.on('requestState', () => {
      emitGameState(socket);
      socket.emit('chatHistory', gameState.chatHistory);
    });

    socket.on('join', (payload: { name: string; clientToken?: string } | string, ack?: (response: AckResponse) => void) => {
      const parsedName = typeof payload === 'string' ? payload : payload?.name;
      const parsedToken = typeof payload === 'string' ? socket.id : payload?.clientToken;
      const name = normalizeText(parsedName, '').trim();
      const clientToken = normalizeText(parsedToken, socket.id).trim();

      if (!name || !clientToken) {
        socket.emit('error', 'Invalid join data');
        ack?.({ ok: false, message: 'Invalid join data' });
        return;
      }

      if (Object.keys(gameState.players).length >= 10) {
        socket.emit('error', 'Room is full');
        ack?.({ ok: false, message: 'Room is full' });
        return;
      }
      if (gameState.status !== 'LOBBY') {
        socket.emit('error', 'Game already in progress');
        ack?.({ ok: false, message: 'Game already in progress' });
        return;
      }

      gameState.players[socket.id] = {
        id: socket.id,
        name,
        score: 0,
        photosUploaded: false,
        ready: false,
        isHost: false,
        clientToken,
      };

      if (!gameState.hostToken) {
        gameState.hostToken = clientToken;
      }

      if (gameState.hostToken === clientToken) {
        gameState.hostId = socket.id;
      }

      syncHost();

      emitGameState();
      ack?.({ ok: true });
    });

    socket.on('startGame', (requestedRounds: number, ack?: (response: AckResponse) => void) => {
      const host = gameState.players[socket.id];
      const rounds = Number.isFinite(requestedRounds) ? Math.floor(requestedRounds) : 10;

      if (!host?.isHost) {
        socket.emit('error', 'Only the host can start the game');
        ack?.({ ok: false, message: 'Only the host can start the game' });
        return;
      }

      if (gameState.status === 'LOBBY' && Object.keys(gameState.players).length >= 2) {
        gameState.totalRounds = Math.max(1, rounds);
        gameState.status = 'UPLOADING';
        emitGameState();
        ack?.({ ok: true });
        return;
      }

      ack?.({ ok: false, message: 'Need at least 2 players in lobby to start' });
    });

    socket.on('chatMessage', (message: string) => {
      const player = gameState.players[socket.id];
      const trimmed = message.trim();

      if (!player || !trimmed) return;

      const chatMessage: ChatMessage = {
        id: `${socket.id}-${Date.now()}`,
        senderName: player.name,
        message: trimmed,
        timestamp: Date.now(),
      };

      gameState.chatHistory.push(chatMessage);
      gameState.chatHistory = gameState.chatHistory.slice(-50);

      io.emit('chatMessage', chatMessage);
    });

    socket.on('photoReaction', (emoji: string, ack?: (response: AckResponse) => void) => {
      const player = gameState.players[socket.id];
      if (!player || gameState.status !== 'PLAYING') {
        ack?.({ ok: false, message: 'Reactions are available only during a round' });
        return;
      }

      io.volatile.emit('photoReaction', {
        id: `${socket.id}-${Date.now()}`,
        senderName: player.name,
        emoji,
        timestamp: Date.now(),
      });

      ack?.({ ok: true });
    });

    socket.on('uploadPhotos', (photos: string[], ack?: (response: AckResponse) => void) => {
      const player = gameState.players[socket.id];
      if (!player || gameState.status !== 'UPLOADING') {
        ack?.({ ok: false, message: 'Uploads are not accepted right now' });
        return;
      }

      if (!Array.isArray(photos) || photos.length === 0) {
        ack?.({ ok: false, message: 'No photos to upload' });
        return;
      }

      const newPhotos = photos.map(data => ({
        ownerId: socket.id,
        ownerName: player.name,
        data,
      }));

      gameState.photos.push(...newPhotos);
      player.photosUploaded = true;

      // Check if all players have uploaded
      const allUploaded = Object.values(gameState.players).every(p => p.photosUploaded);
      if (allUploaded) {
        startPlaying();
      } else {
        emitGameState();
      }

      ack?.({ ok: true });
    });

    socket.on('submitGuess', (guessedPlayerId: string, ack?: (response: AckResponse) => void) => {
      if (gameState.status !== 'PLAYING') {
        ack?.({ ok: false, message: 'Round is not active' });
        return;
      }
      if (gameState.guesses[socket.id]) {
        ack?.({ ok: false, message: 'Guess already submitted' });
        return;
      }

      const submittedAt = Date.now();
      gameState.guesses[socket.id] = guessedPlayerId;
      gameState.guessTimes[socket.id] = submittedAt;

      const correctOwnerId = gameState.currentPhoto?.ownerId;
      if (guessedPlayerId === correctOwnerId) {
        const elapsedMs = Math.max(0, submittedAt - gameState.roundStartTime);
        const roundDuration = gameState.roundDuration;
        const points =
          elapsedMs <= 1000
            ? 1000
            : elapsedMs >= roundDuration
              ? 100
              : Math.round(1000 - ((elapsedMs - 1000) / (roundDuration - 1000)) * 900);

        const player = gameState.players[socket.id];
        if (player) {
          player.score += Math.max(100, points);
        }
      }
      
      // Check if everyone has guessed
      const totalPlayers = Object.keys(gameState.players).length;
      const totalGuesses = Object.keys(gameState.guesses).length;

      if (totalGuesses === totalPlayers) {
        endRound();
      } else {
        emitGameState();
      }

      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      const wasHost = gameState.hostId === socket.id;
      delete gameState.players[socket.id];
      delete gameState.guesses[socket.id];
      delete gameState.guessTimes[socket.id];

      gameState.photos = gameState.photos.filter(photo => photo.ownerId !== socket.id);

      const remainingPlayers = Object.keys(gameState.players).length;
      const currentOwnerDisconnected = gameState.currentPhoto?.ownerId === socket.id;

      if (remainingPlayers === 0) {
        resetGame();
        return;
      }

      if (wasHost) {
        gameState.hostId = Object.keys(gameState.players)[0] ?? null;
      }

      syncHost();

      if (gameState.status !== 'LOBBY' && remainingPlayers < 2) {
        resetGame();
        emitGameState();
        return;
      }

      if (gameState.status === 'UPLOADING') {
        const allUploaded = Object.values(gameState.players).every(p => p.photosUploaded);
        if (allUploaded && remainingPlayers >= 2) {
          startPlaying();
          return;
        }
      }

      if (currentOwnerDisconnected && gameState.status === 'PLAYING') {
        endRound();
      } else {
        emitGameState();
      }
    });
  });

  function clearRoundTimers() {
    if (roundTimeout) {
      clearTimeout(roundTimeout);
      roundTimeout = null;
    }
    if (resultsTimeout) {
      clearTimeout(resultsTimeout);
      resultsTimeout = null;
    }
  }

  function startPlaying() {
    clearRoundTimers();
    gameState.status = 'PLAYING';
    gameState.currentRound = 0;
    gameState.totalRounds = Math.min(Math.max(1, gameState.totalRounds || gameState.photos.length), gameState.photos.length, 20); // Limit to selected rounds
    // Shuffle photos (Fisher-Yates)
    for (let i = gameState.photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [gameState.photos[i], gameState.photos[j]] = [gameState.photos[j], gameState.photos[i]];
    }
    nextRound();
  }

  function nextRound() {
    if (gameState.currentRound >= gameState.totalRounds) {
      clearRoundTimers();
      gameState.status = 'GAME_OVER';
      gameState.currentPhoto = null;
      gameState.guesses = {};
      gameState.guessTimes = {};
      gameState.roundStartTime = 0;
      gameState.photos = [];
      emitGameState();
      return;
    }

    gameState.status = 'PLAYING';
    gameState.currentPhoto = gameState.photos[gameState.currentRound];
    gameState.guesses = {};
    gameState.guessTimes = {};
    gameState.roundStartTime = Date.now();
    gameState.currentRound++;

    emitGameState();

    // Auto-end round after duration
    const roundNumber = gameState.currentRound;
    clearRoundTimers();
    roundTimeout = setTimeout(() => {
      if (gameState.status === 'PLAYING' && gameState.currentRound === roundNumber) {
        endRound();
      }
    }, gameState.roundDuration);
  }

  function endRound() {
    clearRoundTimers();
    gameState.status = 'ROUND_RESULTS';

    emitGameState();

    // Wait 5 seconds before next round
    resultsTimeout = setTimeout(() => {
      if (gameState.status === 'ROUND_RESULTS') {
        nextRound();
      }
    }, 5000);
  }

  function resetGame() {
    clearRoundTimers();
    gameState = {
      status: 'LOBBY',
      players: {},
      photos: [],
      currentRound: 0,
      totalRounds: 0,
      currentPhoto: null,
      roundStartTime: 0,
      roundDuration: 15000,
      guesses: {},
      guessTimes: {},
      hostId: null,
      hostToken: null,
      chatHistory: [],
    };
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
