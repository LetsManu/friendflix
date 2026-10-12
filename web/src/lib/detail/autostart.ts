/**
 * Detail view "Vorschau startet Titel automatisch": once the hero preview has run long enough (it ended, or ~25 s),
 * a 5 s countdown starts the title (resume point / next-up episode). Never on touch/phones, on TV, in a hidden tab,
 * without a playable target, after the viewer cancelled, or when the pref is off (missing pref = on).
 */
export const AUTOSTART_AFTER_S = 25;
export const AUTOSTART_COUNTDOWN_S = 5;

export interface AutoStartEnv {
  pref: boolean | undefined;
  touch: boolean;
  tv: boolean;
  hidden: boolean;
  reducedMotion: boolean;
  /** the preview is actually playing (or just ended) */
  previewing: boolean;
  /** a /watch target exists */
  hasTarget: boolean;
  cancelled: boolean;
}

export function autoStartAllowed(e: AutoStartEnv): boolean {
  return e.pref !== false && !e.touch && !e.tv && !e.hidden && !e.reducedMotion && e.previewing && e.hasTarget && !e.cancelled;
}

/** the preview ran long enough: ended, or reached AUTOSTART_AFTER_S */
export const previewDone = (ended: boolean, time: number) => ended || (Number.isFinite(time) && time >= AUTOSTART_AFTER_S);

/** "Folge startet in 5 …" / "Film startet in 5 …" */
export function countdownLabel(kind: 'episode' | 'movie', left: number): string {
  const n = Math.max(0, Math.ceil(left));
  return `${kind === 'episode' ? 'Folge' : 'Film'} startet in ${n} …`;
}
