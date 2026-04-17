(() => {
  /**
   * Fibonacci text spiral
   * ---------------------
   * The spiral is built from chained quarter-turn arcs whose radii grow
   * along the Fibonacci sequence. We densely sample the shape once,
   * record cumulative arc lengths, then at every frame place characters
   * at fixed pixel spacing along the (scaled, rotated) curve so the
   * outermost character lands exactly under the cursor.
   */

  const config = {
    fontSize: 14,
    charSpacing: 16,        // fixed pixel distance between neighboring chars
    maxCharacterCount: 1100, // pool cap for performance
    charSet: "01-/·+*",
    smoothing: 0.09,
    scale: 5.2,             // static multiplier controlling base spiral size
    centerPull: 0.16,
    minFibSections: 8,
    maxFibSections: 12,
    minTipDistance: 50,     // keeps tip off the exact center
    minScaleFactor: 0.25,   // clamp so the spiral can shrink far but not vanish
    maxScaleFactor: 3.2,    // clamp so the spiral cannot explode off screen

    // --- Experimental shape params (exposed via the "experiment further" panel)
    angleStep: 1,           // multiplier on the per-section quarter turn; negative reverses winding
    radiusCurve: 1,         // power applied to t before the Fibonacci blend
    aspectRatio: 1,         // x/y stretch; 1 = circular, >1 wide, <1 tall
    opacityFloor: 0.38,     // opacity at the innermost character (tip = 1.0)
    rotationOffset: 0,      // static rotation added to the base spiral, in degrees
    radialJitter: 0,        // pixels of random radial noise per sample
    glow: 6,                // text-shadow blur radius in pixels
    tStart: 0,              // start of the t-range; <0 adds a mirrored inner arm
  };

  // Frozen snapshot of the initial config, used by the reset button.
  const DEFAULT_CONFIG = { ...config };

  const stage = document.getElementById("stage");
  const spiral = document.getElementById("spiral");

  let width = window.innerWidth;
  let height = window.innerHeight;
  let centerX = width / 2;
  let centerY = height / 2;

  // Densely sampled polyline of the base spiral with cumulative arc length
  // at each sample. We then sample characters along it by arc-length lookup.
  let baseSamples = [];
  let baseTotalArcLen = 0;

  // Natural polar coordinates of the spiral tip — used to derive the
  // rotation + scale that put the tip exactly at the cursor.
  let tipNaturalAngle = 0;
  let tipNaturalRadius = 1;

  // Target values the renderer eases toward each frame.
  let targetAngle = 0;
  let targetScale = 1;
  let currentAngle = 0;
  let currentScale = 1;

  // Toggled by clicking the stage. When paused, the spiral freezes in place
  // and no longer tracks the mouse until the user clicks again.
  let paused = false;

  // Pool of reusable DOM nodes and their assigned (random) characters.
  let nodes = [];
  let randomChars = [];

  // ----- Math helpers --------------------------------------------------------

  function fibonacciSequence(length) {
    const values = [1, 1];
    while (values.length < length) {
      values.push(values.at(-1) + values.at(-2));
    }
    return values;
  }

  function lerp(start, end, t) {
    return start + (end - start) * t;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeAngle(angle) {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  }

  // ----- Base spiral ---------------------------------------------------------

  /**
   * Produce a dense polyline approximation of the spiral.
   *
   * The curve is parametrized by t in [0, 1]. We split t across
   * `totalSections` quarter-turn Fibonacci sections. Within each section the
   * radius blends linearly between Fib(n) and Fib(n+1), producing the
   * Fibonacci-inspired growth. A small centerPull term nudges outer points
   * slightly inward so the whole piece feels compact.
   */
  function buildBaseSpiralSamples() {
    // Size and center are read from the stage itself — the controls panel is
    // a sibling, so the stage occupies only the remaining viewport area.
    width = stage.clientWidth;
    height = stage.clientHeight;
    centerX = width / 2;
    centerY = height / 2;

    const viewportLimit = Math.min(width, height);
    const safeRadius = viewportLimit * 0.38;

    const fib = fibonacciSequence(15);

    let sectionCount = config.minFibSections;
    for (let i = config.minFibSections; i <= config.maxFibSections; i += 1) {
      if (fib[i] * config.scale <= safeRadius) sectionCount = i;
    }

    const usableFib = fib.slice(0, sectionCount + 1);
    const maxFib = usableFib.at(-1);
    const totalSections = usableFib.length - 1;

    const sampleCount = 4000;
    baseSamples = new Array(sampleCount);

    let cumArcLen = 0;
    let prevX = 0;
    let prevY = 0;

    // Pre-compute once; applied uniformly to every sample.
    const rotationOffsetRad = (config.rotationOffset * Math.PI) / 180;

    // t spans from tStart to 1. tStart < 0 mirrors an inner arm through the
    // origin, producing a two-arm ("yin-yang") spiral whose outer tip still
    // sits at t = 1 — the cursor-following end stays unchanged.
    const tStart = Math.min(0.99, config.tStart);
    const tRange = 1 - tStart;

    for (let s = 0; s < sampleCount; s += 1) {
      const t = tStart + (s / (sampleCount - 1)) * tRange;

      // Radius uses |t| so both sides grow outward from the origin. The
      // radiusCurve shapes the growth (<1 front-loads, >1 back-loads).
      const tAbs = Math.abs(t);
      const tRadius = Math.pow(tAbs, config.radiusCurve);
      const scaledR = tRadius * totalSections;
      const sectionIndex = Math.min(totalSections - 1, Math.floor(scaledR));
      const localR = scaledR - sectionIndex;

      const innerFib = usableFib[sectionIndex];
      const outerFib = usableFib[sectionIndex + 1];

      const radius = lerp(innerFib, outerFib, localR) * config.scale;

      // Angle keeps the sign of t so negative t winds in the opposite
      // direction, creating the mirrored arm. angleStep multiplies the
      // total winding (negative values reverse it entirely); rotationOffset
      // adds a static rotation to the whole shape.
      const theta =
        t * totalSections * (Math.PI / 2) * config.angleStep +
        rotationOffsetRad;

      const normalizedRadius = radius / (maxFib * config.scale);
      const centeredRadius = radius * (1 - normalizedRadius * config.centerPull);

      // radialJitter perturbs each sample's radius by a random amount, frozen
      // until the next rebuild — so the shape wobbles statically rather than
      // shimmering between frames.
      const jitter =
        config.radialJitter > 0
          ? (Math.random() * 2 - 1) * config.radialJitter
          : 0;
      const jitteredRadius = centeredRadius + jitter;

      // aspectRatio squashes/stretches the horizontal axis for elliptical
      // variations of the shape.
      const x = Math.cos(theta) * jitteredRadius * config.aspectRatio;
      const y = -Math.sin(theta) * jitteredRadius;

      if (s > 0) cumArcLen += Math.hypot(x - prevX, y - prevY);
      baseSamples[s] = { x, y, arcLen: cumArcLen };
      prevX = x;
      prevY = y;
    }

    baseTotalArcLen = cumArcLen;

    const tip = baseSamples.at(-1);
    tipNaturalRadius = Math.hypot(tip.x, tip.y) || 1;
    tipNaturalAngle = Math.atan2(tip.y, tip.x);
  }

  /**
   * Return the interpolated (x, y) on the base spiral at a given cumulative
   * arc length (in base-space units). Uses binary search on the samples.
   */
  function sampleAtArcLength(target) {
    if (target <= 0) return { x: 0, y: 0 };
    if (target >= baseTotalArcLen) {
      const tip = baseSamples.at(-1);
      return { x: tip.x, y: tip.y };
    }

    let lo = 0;
    let hi = baseSamples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (baseSamples[mid].arcLen < target) lo = mid;
      else hi = mid;
    }

    const a = baseSamples[lo];
    const b = baseSamples[hi];
    const span = b.arcLen - a.arcLen || 1;
    const k = (target - a.arcLen) / span;
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
    };
  }

  // ----- DOM pool ------------------------------------------------------------

  function generateRandomCharSequence() {
    randomChars = new Array(config.maxCharacterCount);
    for (let i = 0; i < config.maxCharacterCount; i += 1) {
      randomChars[i] = config.charSet[
        Math.floor(Math.random() * config.charSet.length)
      ];
    }
  }

  function ensureNodePool() {
    if (nodes.length === config.maxCharacterCount) return;

    spiral.innerHTML = "";
    nodes = new Array(config.maxCharacterCount);

    for (let i = 0; i < config.maxCharacterCount; i += 1) {
      const node = document.createElement("span");
      node.className = "spiral-char";
      node.style.fontSize = `${config.fontSize}px`;
      node.textContent = randomChars[i];
      node.style.display = "none";
      spiral.appendChild(node);
      nodes[i] = node;
    }
  }

  // ----- Interaction ---------------------------------------------------------

  /**
   * Map a cursor position to the rotation and scale that place the spiral
   * tip under it.
   *
   *   rotation = mouseAngle - tipNaturalAngle
   *   scale    = mouseDistance / tipNaturalRadius
   */
  function updateTargetFromMouse(clientX, clientY) {
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.max(Math.hypot(dx, dy), config.minTipDistance);

    targetAngle = Math.atan2(dy, dx) - tipNaturalAngle;
    targetScale = clamp(
      distance / tipNaturalRadius,
      config.minScaleFactor,
      config.maxScaleFactor
    );
  }

  // ----- Render loop ---------------------------------------------------------

  function render() {
    if (paused) {
      requestAnimationFrame(render);
      return;
    }

    currentAngle += normalizeAngle(targetAngle - currentAngle) * config.smoothing;
    currentScale += (targetScale - currentScale) * config.smoothing;

    const cos = Math.cos(currentAngle);
    const sin = Math.sin(currentAngle);

    // Total arc length of the spiral in screen pixels, at the current scale.
    const totalScaledArcLen = baseTotalArcLen * currentScale;

    // Decide how many characters are needed right now so that the spacing
    // between them stays ~ charSpacing pixels, and the final character lands
    // exactly at the tip (under the cursor).
    const activeCount = Math.min(
      config.maxCharacterCount,
      Math.max(2, Math.round(totalScaledArcLen / config.charSpacing) + 1)
    );
    const actualSpacing = totalScaledArcLen / (activeCount - 1);

    for (let i = 0; i < config.maxCharacterCount; i += 1) {
      const node = nodes[i];

      if (i >= activeCount) {
        if (node.style.display !== "none") node.style.display = "none";
        continue;
      }
      if (node.style.display === "none") node.style.display = "";

      // Arc length along the scaled spiral, then converted back to the
      // base-space arc length used by the sampler.
      const baseArcLen = (i * actualSpacing) / currentScale;
      const point = sampleAtArcLength(baseArcLen);

      const scaledX = point.x * currentScale;
      const scaledY = point.y * currentScale;

      const rotatedX = scaledX * cos - scaledY * sin;
      const rotatedY = scaledX * sin + scaledY * cos;

      const finalX = centerX + rotatedX;
      const finalY = centerY + rotatedY;

      node.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;

      // Opacity ramps toward the tip to emphasize the cursor-following end.
      // opacityFloor lets the user set the innermost character's opacity; the
      // tip is always fully opaque.
      const progress = i / (activeCount - 1);
      const floor = config.opacityFloor;
      node.style.opacity = (floor + (1 - floor) * progress).toFixed(3);
    }

    requestAnimationFrame(render);
  }

  // ----- Controls panel ------------------------------------------------------

  function formatConfigValue(value) {
    if (typeof value === "string") return value;
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }

  function applyConfigChange(key) {
    if (key === "fontSize") {
      for (const node of nodes) {
        node.style.fontSize = `${config.fontSize}px`;
      }
    } else if (key === "charSet") {
      generateRandomCharSequence();
      nodes.forEach((node, i) => {
        node.textContent = randomChars[i];
      });
    } else if (key === "glow") {
      spiral.style.setProperty("--glow", `${config.glow}px`);
    } else if (
      key === "scale" ||
      key === "centerPull" ||
      key === "angleStep" ||
      key === "radiusCurve" ||
      key === "aspectRatio" ||
      key === "rotationOffset" ||
      key === "radialJitter" ||
      key === "tStart"
    ) {
      // These change the geometry of the base spiral itself.
      buildBaseSpiralSamples();
    }
    // charSpacing, smoothing, opacityFloor, min/maxScaleFactor take effect
    // automatically on the next frame.
  }

  function shuffleCharacters() {
    generateRandomCharSequence();
    nodes.forEach((node, i) => {
      node.textContent = randomChars[i];
    });
  }

  /**
   * Restore every tunable to its initial value, resync the panel UI, and
   * reapply the side-effects (font size, glow, random chars if the charset
   * changed, and a single base-spiral rebuild).
   */
  function resetConfig() {
    const charSetChanged = config.charSet !== DEFAULT_CONFIG.charSet;
    Object.assign(config, DEFAULT_CONFIG);

    const panel = document.getElementById("controls");
    if (panel) {
      panel.querySelectorAll("input[data-key]").forEach((input) => {
        const key = input.dataset.key;
        const value = config[key];
        input.value = typeof value === "number" ? String(value) : value;
        const out = panel.querySelector(`output[data-key="${key}"]`);
        if (out) out.textContent = formatConfigValue(value);
      });
    }

    if (charSetChanged) shuffleCharacters();
    for (const node of nodes) {
      node.style.fontSize = `${config.fontSize}px`;
    }
    spiral.style.setProperty("--glow", `${config.glow}px`);
    buildBaseSpiralSamples();
  }

  function bindControls() {
    const panel = document.getElementById("controls");
    if (!panel) return;

    // Seed each input/output with the current config value.
    panel.querySelectorAll("input[data-key]").forEach((input) => {
      const key = input.dataset.key;
      const value = config[key];
      input.value = typeof value === "number" ? String(value) : value;

      const out = panel.querySelector(`output[data-key="${key}"]`);
      if (out) out.textContent = formatConfigValue(value);
    });

    panel.addEventListener("input", (event) => {
      const target = event.target;
      const key = target.dataset?.key;
      if (!key) return;

      let value;
      if (target.type === "range") {
        value = Number.parseFloat(target.value);
      } else {
        // If the user clears the charset, fall back to a single dot so the
        // spiral still has something to render.
        value = target.value.length ? target.value : ".";
      }

      config[key] = value;

      const out = panel.querySelector(`output[data-key="${key}"]`);
      if (out) out.textContent = formatConfigValue(value);

      applyConfigChange(key);
    });

    // Prevent pause-on-click when interacting with the panel, and handle
    // command buttons like "shuffle characters".
    panel.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = event.target?.dataset?.action;
      if (action === "shuffle") shuffleCharacters();
      else if (action === "reset") resetConfig();
    });
  }

  // ----- Lifecycle -----------------------------------------------------------

  function handleResize() {
    buildBaseSpiralSamples();
    updateTargetFromMouse(centerX + 180, centerY - 120);
    currentAngle = targetAngle;
    currentScale = targetScale;
  }

  function init() {
    generateRandomCharSequence();
    buildBaseSpiralSamples();
    ensureNodePool();
    spiral.style.setProperty("--glow", `${config.glow}px`);
    bindControls();

    updateTargetFromMouse(centerX + 180, centerY - 120);
    currentAngle = targetAngle;
    currentScale = targetScale;

    stage.addEventListener("mousemove", (event) => {
      if (paused) return;
      const rect = stage.getBoundingClientRect();
      updateTargetFromMouse(event.clientX - rect.left, event.clientY - rect.top);
    });

    // Click toggles pause. While paused the render loop keeps running but
    // does not advance angle/scale, and mousemove input is ignored.
    stage.addEventListener("click", () => {
      paused = !paused;
    });

    window.addEventListener("resize", handleResize);

    requestAnimationFrame(render);
  }

  init();
})();
