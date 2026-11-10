/**
 * Motion tokens for code that animates through the Web Animations API or needs
 * the reduced-motion preference. Mirrors the CSS custom properties in
 * style.css (:root --ease-out, --dur-*). transform and opacity only: hardware
 * acceleration is off on Windows.
 */
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const DUR = { press: 120, fast: 150, base: 200, celebrate: 400 } as const;
export const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
