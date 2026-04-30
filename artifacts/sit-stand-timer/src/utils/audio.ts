const SOUND_KEY = "sit-stand-sound-enabled";

export function isSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SOUND_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, String(enabled));
  } catch {
    // ignore
  }
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, type: OscillatorType = "sine", gain = 0.3): void {
  if (!isSoundEnabled()) return;
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    oscillator.type = type;

    gainNode.gain.setValueAtTime(gain, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  } catch {
    // Audio not available
  }
}

export function playStandTone(): void {
  playTone(523, 0.15);
  setTimeout(() => playTone(659, 0.15), 180);
  setTimeout(() => playTone(784, 0.4), 360);
}

export function playSitTone(): void {
  playTone(784, 0.15);
  setTimeout(() => playTone(659, 0.15), 180);
  setTimeout(() => playTone(523, 0.4), 360);
}

export function playConfirmTone(): void {
  playTone(440, 0.08, "sine", 0.15);
  setTimeout(() => playTone(554, 0.15, "sine", 0.12), 100);
}

export function playRestTone(): void {
  playTone(392, 0.5, "sine", 0.1);
}

export function playGoalCelebrationTone(): void {
  if (!isSoundEnabled()) return;
  playTone(523, 0.12, "sine", 0.25);
  setTimeout(() => playTone(659, 0.12, "sine", 0.22), 130);
  setTimeout(() => playTone(784, 0.12, "sine", 0.22), 260);
  setTimeout(() => playTone(1047, 0.4, "sine", 0.28), 390);
  setTimeout(() => playTone(880, 0.12, "sine", 0.18), 560);
  setTimeout(() => playTone(1047, 0.6, "sine", 0.22), 680);
}
