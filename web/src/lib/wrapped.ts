/** Renders a shareable "Wrapped" card (PNG) in the browser: nothing leaves the device. */
interface Stats { year: number; totalMinutes: number; titles: number; movies: number; episodes: number; favoriteWeekday: string | null; topItems: Array<{ name: string; minutes: number }>; achievements: Array<{ earnedAt: string | null }> }

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number, maxLines = 2) {
  const words = text.split(' ');
  let line = '', n = 0;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) {
      g.fillText(line, x, y + n * lineH);
      line = w;
      if (++n >= maxLines) return;
    } else line = t;
  }
  g.fillText(n >= maxLines - 1 && g.measureText(line).width > maxW ? line.slice(0, 24) + '…' : line, x, y + n * lineH);
}

export function renderCard(s: Stats, name = ''): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1350;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 1080, 1350);
  bg.addColorStop(0, '#5a0b14'); bg.addColorStop(0.55, '#16161c'); bg.addColorStop(1, '#0b0b0e');
  g.fillStyle = bg; g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = 'rgba(229,15,42,.22)'; g.beginPath(); g.arc(930, 230, 360, 0, Math.PI * 2); g.fill();
  const font = (w: number, px: number) => `${w} ${px}px 'Inter Variable', Inter, system-ui, sans-serif`;
  g.fillStyle = '#e50f2a'; g.font = font(900, 54); g.fillText('FRIENDFLIX', 72, 120);
  g.fillStyle = '#f5f5f5'; g.font = font(700, 40); g.fillText(`Wrapped ${s.year}${name ? ' · ' + name : ''}`, 72, 190);
  const h = Math.floor(s.totalMinutes / 60), m = s.totalMinutes % 60;
  g.font = font(900, 190); g.fillText(`${h}`, 72, 420);
  const hw = g.measureText(`${h}`).width;
  g.font = font(700, 56); g.fillStyle = '#b3b3b3'; g.fillText(`Std. ${m} Min.`, 72 + hw + 24, 420);
  g.fillText('geschaut', 72 + hw + 24, 360);
  g.fillStyle = '#f5f5f5'; g.font = font(600, 44);
  g.fillText(`${s.titles} Titel  ·  ${s.movies} Filme  ·  ${s.episodes} Folgen`, 72, 520);
  if (s.favoriteWeekday) { g.fillStyle = '#b3b3b3'; g.font = font(500, 38); g.fillText(`Lieblingstag: ${s.favoriteWeekday}`, 72, 585); }
  g.fillStyle = '#e50f2a'; g.font = font(800, 36); g.fillText('MEINE TOP 3', 72, 700);
  s.topItems.slice(0, 3).forEach((t, i) => {
    const y = 780 + i * 150;
    g.fillStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.roundRect(72, y - 70, 936, 120, 20); g.fill();
    g.fillStyle = '#e50f2a'; g.font = font(900, 76); g.fillText(String(i + 1), 104, y + 22);
    g.fillStyle = '#f5f5f5'; g.font = font(700, 40); wrap(g, t.name, 200, y - 6, 640, 46);
    g.fillStyle = '#b3b3b3'; g.font = font(500, 32); g.textAlign = 'right'; g.fillText(`${t.minutes} min`, 980, y + 18); g.textAlign = 'left';
  });
  const earned = s.achievements.filter((a) => a.earnedAt).length;
  g.fillStyle = '#b3b3b3'; g.font = font(600, 38); g.fillText(`${earned} von ${s.achievements.length} Achievements freigeschaltet`, 72, 1270);
  return c;
}

export async function shareCard(s: Stats, name = '') {
  const c = renderCard(s, name);
  const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) return;
  const file = new File([blob], `friendflix-wrapped-${s.year}.png`, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) { try { await nav.share({ files: [file], title: `Mein FriendFlix Wrapped ${s.year}` }); return; } catch { /* fall through to download */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
