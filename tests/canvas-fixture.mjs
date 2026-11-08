/**
 * A canvas UI with nothing to enumerate, for testing the only remaining route.
 *
 * This is what a game, a charting widget or a remote-desktop session looks like from
 * the outside: one rectangle that paints itself. There is no DOM inside the canvas, so
 * no accessibility tree can describe the buttons — their positions below are the only
 * ground truth, and a test can therefore tell a hit from a miss by reading them.
 *
 * Three deliberately different zones, because "did the click work" has three different
 * honest answers on a painted surface:
 *
 *   - the toolbar buttons: still, so a change near them is the click;
 *   - `CANVAS_STILL_ZONE`: also still and empty, so clicking it must report that nothing
 *     changed rather than inventing a result;
 *   - `CANVAS_NOISE_ZONE`: resprayed with fresh random speckle every frame, so no
 *     comparison can ever attribute a change there to the click — the test asserts the
 *     tool says so instead of guessing.
 */

export const CANVAS_WIDTH = 900;
export const CANVAS_HEIGHT = 600;

/** Ground truth: where the painted buttons really are, in canvas pixels. */
export const CANVAS_BUTTONS = [
  { id: 'start', label: 'START', x: 60, y: 40, w: 140, h: 54, fill: '#2f6f4f' },
  { id: 'pause', label: 'PAUSE', x: 220, y: 40, w: 140, h: 54, fill: '#6f5f2f' },
  { id: 'reset', label: 'RESET', x: 380, y: 40, w: 140, h: 54, fill: '#6f2f3f' },
];

/** Flat and never repainted: a click here must be reported as having changed nothing. */
export const CANVAS_STILL_ZONE = { x: 40, y: 300, w: 200, h: 150 };

/** Random speckle every frame: pixels here can never testify about a click. */
export const CANVAS_NOISE_ZONE = { x: 700, y: 420, w: 100, h: 80 };

/** A moving band, for the "the scene itself animates" case. */
export const CANVAS_MOVING_BAND = { x: 0, y: 500, w: CANVAS_WIDTH, h: 100 };

export const CANVAS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>canvas game</title>
<style>
  html, body { margin: 0; padding: 0; background: #101318; overflow: hidden; }
  canvas { display: block; }
</style>
<canvas id="c" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
<script>
  const canvas = document.getElementById('c');
  const g = canvas.getContext('2d');
  const BUTTONS = ${JSON.stringify(CANVAS_BUTTONS)};
  const STILL = ${JSON.stringify(CANVAS_STILL_ZONE)};
  const NOISE = ${JSON.stringify(CANVAS_NOISE_ZONE)};
  const state = { start: 0, pause: 0, reset: 0, frame: 0, last: '' };

  const inside = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);
    let hit = null;
    for (const button of BUTTONS) if (inside(button, x, y)) hit = button.id;
    if (hit) {
      state[hit] += 1;
      state.last = hit + ' #' + state[hit];
    } else if (inside(STILL, x, y)) {
      state.last = 'still@' + x + ',' + y;
    } else if (inside(NOISE, x, y)) {
      state.last = 'noise@' + x + ',' + y;
    } else {
      state.last = 'miss@' + x + ',' + y;
    }
  });

  function paint() {
    state.frame += 1;
    g.fillStyle = '#101318';
    g.fillRect(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT});

    for (const button of BUTTONS) {
      g.fillStyle = button.fill;
      g.fillRect(button.x, button.y, button.w, button.h);
      g.fillStyle = '#eaf2ec';
      g.font = 'bold 20px sans-serif';
      g.fillText(button.label + ' ' + state[button.id], button.x + 14, button.y + 35);
    }

    // A flat panel that is never repainted: anything changing here changed because
    // something else did it.
    g.fillStyle = '#1a2430';
    g.fillRect(STILL.x, STILL.y, STILL.w, STILL.h);
    g.fillStyle = '#2b3a4a';
    g.font = '14px sans-serif';
    g.fillText('static panel', STILL.x + 12, STILL.y + 24);

    // Fresh random speckle every frame: no two captures of this zone are alike, so no
    // pixel comparison can attribute a change here to a click.
    for (let i = 0; i < 260; i += 1) {
      const px = NOISE.x + Math.floor(Math.random() * NOISE.w);
      const py = NOISE.y + Math.floor(Math.random() * NOISE.h);
      const shade = 60 + Math.floor(Math.random() * 170);
      g.fillStyle = 'rgb(' + shade + ',' + (shade >> 1) + ',' + (255 - shade) + ')';
      g.fillRect(px, py, 5, 5);
    }

    g.fillStyle = '#93a7bc';
    g.font = '16px sans-serif';
    g.fillText('last: ' + (state.last || 'none'), 560, 76);

    // Kept inside its own band: an earlier version swept the whole canvas and would drift
    // over the flat panel, which turned "nothing changed there" into an intermittent
    // failure that looked exactly like a broken verification.
    const t = state.frame;
    g.fillStyle = '#39d0ff';
    g.beginPath();
    g.arc(620 + Math.sin(t / 18) * 180, 200 + Math.cos(t / 13) * 60, 34, 0, Math.PI * 2);
    g.fill();

    for (let i = 0; i < 14; i += 1) {
      g.fillStyle = i % 2 ? '#1b2230' : '#151a24';
      g.fillRect(((i * 80 + t * 5) % 1120) - 110, 520, 64, 64);
    }
  }

  // setInterval, not requestAnimationFrame: rAF throttles hard for a window the
  // compositor thinks nobody is watching, and this scene has to keep moving.
  // Readable from the outside so a test can see whether a synthetic click actually
  // reached the canvas, instead of inferring it from pixels.
  window.__state = state;

  setInterval(paint, 40);
  paint();
</script>`;
