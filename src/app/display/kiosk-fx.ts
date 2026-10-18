/**
 * MO-09: opt-in tap feedback for the Nest Hub kiosk — a ~30 ms WebAudio click
 * (synthesised, no asset file) plus an 8 ms vibration where the device has one.
 * Enabled by `?fx=1` on the kiosk URL or `display.tapFeedback` when the settings carry it.
 */
let ctx: AudioContext | null = null;

export function tapFx(): void {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* no vibration motor / not allowed */
  }
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1900, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.03);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.07, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.045);
  } catch {
    /* audio blocked until the first gesture, or unsupported */
  }
}
