/**
 * Play a pleasant notification sound using Web Audio API
 * No external audio files needed - generates sound programmatically
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

/**
 * Play a pleasant "ding" notification sound
 * Uses two tones for a pleasant chime effect
 */
export function playNotificationSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Create a pleasant two-tone chime
    const frequencies = [830, 1046]; // G5 and C6 - pleasant major interval

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      // Envelope: quick attack, gentle decay
      const startTime = now + i * 0.15; // Stagger the tones
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.02); // Quick attack
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.5); // Gentle decay

      oscillator.start(startTime);
      oscillator.stop(startTime + 0.5);
    });
  } catch (error) {
    console.warn('Could not play notification sound:', error);
  }
}

/**
 * Play a success sound (completion)
 * Three ascending tones
 */
export function playSuccessSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Ascending major chord: C5, E5, G5
    const frequencies = [523, 659, 784];

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      const startTime = now + i * 0.1;
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.4);

      oscillator.start(startTime);
      oscillator.stop(startTime + 0.4);
    });
  } catch (error) {
    console.warn('Could not play success sound:', error);
  }
}
