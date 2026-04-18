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
    shape: "spiral",        // "spiral" | "cube" | "sphere"
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

    // --- 3D-shape params (cube / sphere). Applied at render time, so they
    // never trigger a sample rebuild.
    twist: 0,               // degrees of yaw twist applied per unit Y; spirals the shape vertically
    perspective: 600,       // camera distance for the perspective projection; smaller = stronger
    roundness: 0,           // cube only: morph cube edges toward a sphere of equal extent
    pulse: 0,               // sphere only: sinusoidal radial bumpiness, 0 = smooth
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

  // 3D shapes (cube, sphere) use yaw/pitch driven by cursor position,
  // smoothed the same way spiral angle/scale are.
  let targetYaw = 0;
  let targetPitch = 0;
  let currentYaw = 0;
  let currentPitch = 0;

  // Rough bounding half-size of the current 3D shape, used for depth-based
  // opacity shading.
  let shapeExtent = 1;

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
  /**
   * Compute a `scale` value that makes the active shape roughly fill the
   * drawing area. For 3D shapes we also factor in the perspective projection
   * (the closest face expands by D/(D-r)), so the apparent size stays within
   * the viewport rather than the raw geometric size.
   */
  function fitScaleForShape(shape) {
    // Spiral's sample builder already caps section count against a safeRadius
    // derived from the viewport, so any reasonable scale fills it; keep the
    // historically-tuned default so the spiral's turn count feels right.
    if (shape === "spiral") return DEFAULT_CONFIG.scale;

    const halfView = Math.min(spiral.clientWidth, spiral.clientHeight) / 2;
    if (halfView <= 0) return DEFAULT_CONFIG.scale;

    const target = halfView * 0.9;
    const D = config.perspective;
    const maxFib = fibonacciSequence(config.maxFibSections + 1).at(-1);

    // Solve apparent = r * D / (D - r) = target  ⇒  r = target * D / (D + target).
    const r = (target * D) / (D + target);

    let raw;
    if (shape === "cube") {
      // Cube circumradius = (edgeLen/2) * √3, and edgeLen = maxFib * scale.
      const half = r / Math.sqrt(3);
      raw = (2 * half) / maxFib;
    } else {
      // Sphere: R = maxFib * scale * 0.55 (see buildSphereSamples).
      raw = r / (maxFib * 0.55);
    }

    // Snap to the slider's 0.1 step and clamp to its range.
    return clamp(Math.round(raw * 10) / 10, 0.5, 12);
  }

  /**
   * Override `config.scale` with the fit value for the active shape and
   * re-sync the scale slider's value + readout so the UI stays truthful.
   * Called on init and on shape switch; not on resize (to preserve the
   * user's manual tweaks in a session).
   */
  function applyAutoFitScale() {
    const fit = fitScaleForShape(config.shape);
    config.scale = fit;

    const panel = document.getElementById("controls");
    if (!panel) return;
    const input = panel.querySelector('input[data-key="scale"]');
    const out = panel.querySelector('output[data-key="scale"]');
    if (input) input.value = String(fit);
    if (out) out.textContent = formatConfigValue(fit);
  }

  /**
   * Dispatch to the builder for the active shape. All shapes consume the
   * same config knobs where meaningful: `scale` drives overall size,
   * `charSpacing` drives point density, `radialJitter` perturbs samples,
   * `aspectRatio` and `rotationOffset` are applied at render time.
   */
  function buildBaseSamples() {
    // #spiral is now a flex child of #stage (sibling to the shape menu) and
    // is the positioning context for the chars, so its dimensions define the
    // drawing area — not the full stage.
    width = spiral.clientWidth;
    height = spiral.clientHeight;
    centerX = width / 2;
    centerY = height / 2;

    if (config.shape === "cube") buildCubeSamples();
    else if (config.shape === "sphere") buildSphereSamples();
    else buildBaseSpiralSamples();
  }

  function buildBaseSpiralSamples() {
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
   * Wireframe cube: the 12 edges are sampled at fixed `charSpacing` intervals.
   * Edge length tracks the largest Fibonacci section so the cube has the same
   * size reference as the spiral at the same `scale`.
   */
  function buildCubeSamples() {
    const fib = fibonacciSequence(config.maxFibSections + 1);
    const edgeLen = fib.at(-1) * config.scale;
    const half = edgeLen / 2;
    shapeExtent = half * Math.sqrt(3);

    const corners = [
      [-half, -half, -half], [ half, -half, -half],
      [ half,  half, -half], [-half,  half, -half],
      [-half, -half,  half], [ half, -half,  half],
      [ half,  half,  half], [-half,  half,  half],
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    const perEdge = Math.max(2, Math.floor(edgeLen / config.charSpacing));
    const total = Math.min(perEdge * edges.length, config.maxCharacterCount);
    baseSamples = new Array(total);

    let idx = 0;
    for (const [a, b] of edges) {
      const [ax, ay, az] = corners[a];
      const [bx, by, bz] = corners[b];
      for (let i = 0; i < perEdge && idx < total; i += 1, idx += 1) {
        const t = i / (perEdge - 1);
        const jx = config.radialJitter > 0 ? (Math.random() * 2 - 1) * config.radialJitter : 0;
        const jy = config.radialJitter > 0 ? (Math.random() * 2 - 1) * config.radialJitter : 0;
        const jz = config.radialJitter > 0 ? (Math.random() * 2 - 1) * config.radialJitter : 0;
        baseSamples[idx] = {
          x: lerp(ax, bx, t) + jx,
          y: lerp(ay, by, t) + jy,
          z: lerp(az, bz, t) + jz,
        };
      }
    }
    baseSamples.length = idx;
  }

  /**
   * Fibonacci sphere: points distributed via the golden-angle spiral so the
   * surface density is roughly uniform. Point count is derived from surface
   * area / charSpacing², capped by the node pool.
   */
  function buildSphereSamples() {
    const fib = fibonacciSequence(config.maxFibSections + 1);
    const R = fib.at(-1) * config.scale * 0.55;
    shapeExtent = R;

    const area = 4 * Math.PI * R * R;
    const target = Math.max(
      20,
      Math.min(
        config.maxCharacterCount,
        Math.floor(area / (config.charSpacing * config.charSpacing)),
      ),
    );

    const phi = (Math.sqrt(5) + 1) / 2;
    const goldenAngle = 2 * Math.PI * (1 - 1 / phi);

    baseSamples = new Array(target);
    for (let i = 0; i < target; i += 1) {
      const yNorm = target > 1 ? 1 - (i / (target - 1)) * 2 : 0;
      const ringR = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));
      const theta = i * goldenAngle;

      const jitter =
        config.radialJitter > 0
          ? 1 + ((Math.random() * 2 - 1) * config.radialJitter) / Math.max(1, R)
          : 1;

      baseSamples[i] = {
        x: Math.cos(theta) * ringR * R * jitter,
        y: yNorm * R * jitter,
        z: Math.sin(theta) * ringR * R * jitter,
      };
    }
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
    if (config.shape === "spiral") {
      const dx = clientX - centerX;
      const dy = clientY - centerY;
      const distance = Math.max(Math.hypot(dx, dy), config.minTipDistance);

      targetAngle = Math.atan2(dy, dx) - tipNaturalAngle;
      targetScale = clamp(
        distance / tipNaturalRadius,
        config.minScaleFactor,
        config.maxScaleFactor
      );
      return;
    }

    // 3D shapes: cursor position maps to yaw (horizontal) and pitch
    // (vertical). Normalized to [-1, 1] against the stage half-size.
    const nx = clamp((clientX - centerX) / Math.max(1, width / 2), -1, 1);
    const ny = clamp((clientY - centerY) / Math.max(1, height / 2), -1, 1);
    targetYaw = nx * Math.PI;
    targetPitch = -ny * (Math.PI / 2);
  }

  // ----- Render loop ---------------------------------------------------------

  function render() {
    if (paused) {
      requestAnimationFrame(render);
      return;
    }

    if (config.shape === "spiral") renderSpiral();
    else render3D();

    requestAnimationFrame(render);
  }

  function renderSpiral() {
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
  }

  // Per-sample scratch for the 3D modulators; reused each frame so the hot
  // loop in render3D doesn't allocate.
  const sample3D = { x: 0, y: 0, z: 0 };

  // Cube only: push each point from its current radius to the bounding-sphere
  // radius. roundness = 1 turns the cube wireframe into a sphere of the same
  // circumradius; intermediate values morph smoothly.
  function applyRoundness(p, roundness, extent) {
    const r = Math.hypot(p.x, p.y, p.z);
    if (r === 0) return;
    const f = 1 + roundness * (extent / r - 1);
    p.x *= f; p.y *= f; p.z *= f;
  }

  // Sphere only: sinusoidal radial modulation indexed by longitude × latitude
  // — produces a lumpy "golfball" surface as `amp` rises.
  function applyPulse(p, amp, extent) {
    const lon = Math.atan2(p.z, p.x);
    const latNorm = clamp(p.y / extent, -1, 1);
    const f = 1 + amp * Math.sin(lon * 6) * Math.cos(latNorm * Math.PI * 2);
    p.x *= f; p.y *= f; p.z *= f;
  }

  // Yaw rotation around Y proportional to Y position — at twist = 360, the
  // top and bottom of the shape differ by a full turn so strands spiral.
  function applyTwist(p, twistRad, extent) {
    const a = (p.y / extent) * twistRad;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tx = p.x * ca + p.z * sa;
    const tz = -p.x * sa + p.z * ca;
    p.x = tx; p.z = tz;
  }

  function setNodeShown(node, shown) {
    const want = shown ? "" : "none";
    if (node.style.display !== want) node.style.display = want;
  }

  function render3D() {
    currentYaw += normalizeAngle(targetYaw - currentYaw) * config.smoothing;
    currentPitch += normalizeAngle(targetPitch - currentPitch) * config.smoothing;

    const cy = Math.cos(currentYaw);
    const sy = Math.sin(currentYaw);
    const cp = Math.cos(currentPitch);
    const sp = Math.sin(currentPitch);
    const rollRad = (config.rotationOffset * Math.PI) / 180;
    const cr = Math.cos(rollRad);
    const sr = Math.sin(rollRad);

    const total = baseSamples.length;
    const floor = config.opacityFloor;
    const extent = Math.max(1, shapeExtent);
    const D = config.perspective;
    const twistRad = (config.twist * Math.PI) / 180;
    const roundness = config.shape === "cube" ? config.roundness : 0;
    const pulseAmp = config.shape === "sphere" ? config.pulse : 0;

    for (let i = 0; i < config.maxCharacterCount; i += 1) {
      const node = nodes[i];
      if (i >= total) { setNodeShown(node, false); continue; }
      setNodeShown(node, true);

      const s = baseSamples[i];
      sample3D.x = s.x; sample3D.y = s.y; sample3D.z = s.z;

      if (roundness > 0) applyRoundness(sample3D, roundness, extent);
      if (pulseAmp > 0) applyPulse(sample3D, pulseAmp, extent);
      if (twistRad !== 0) applyTwist(sample3D, twistRad, extent);

      const x = sample3D.x;
      const y = sample3D.y;
      const z = sample3D.z;

      // Yaw (around Y), then pitch (around X).
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;

      // Roll (around Z) — rotationOffset, the user's static spin.
      const x3 = x1 * cr - y2 * sr;
      const y3 = x1 * sr + y2 * cr;

      // Perspective projection. Camera sits at (0, 0, -D) looking toward +z.
      const depth = D / (D + z2);
      const px = x3 * depth * config.aspectRatio;
      const py = y3 * depth;

      node.style.transform = `translate3d(${centerX + px}px, ${centerY + py}px, 0)`;

      // Depth-based opacity: closer to camera = brighter. z2 ∈ roughly
      // [-extent, +extent], so normalize about 0.
      const depthT = clamp(0.5 - z2 / (2 * extent), 0, 1);
      node.style.opacity = (floor + (1 - floor) * depthT).toFixed(3);
    }
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
    } else if (key === "maxCharacterCount") {
      // Pool size changed: re-roll the character sequence to fit, rebuild
      // the DOM node pool, then resample so the 3D shapes' point counts
      // (which are capped by maxCharacterCount) update.
      generateRandomCharSequence();
      ensureNodePool();
      buildBaseSamples();
    } else if (affectsGeometry(key)) {
      buildBaseSamples();
    }
    // charSpacing (spiral), smoothing, opacityFloor, min/maxScaleFactor take
    // effect automatically on the next frame.
  }

  // Keys that trigger a sample rebuild. `charSpacing` only matters for 3D
  // shapes (it drives their point count); the spiral interpolates it live.
  function affectsGeometry(key) {
    const spiralKeys = new Set([
      "scale", "centerPull", "angleStep", "radiusCurve", "aspectRatio",
      "rotationOffset", "radialJitter", "tStart",
    ]);
    const solidKeys = new Set([
      "scale", "charSpacing", "radialJitter",
    ]);
    if (config.shape === "spiral") return spiralKeys.has(key);
    return solidKeys.has(key);
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

    if (nodes.length !== config.maxCharacterCount) {
      generateRandomCharSequence();
      ensureNodePool();
    } else if (charSetChanged) {
      shuffleCharacters();
    }
    for (const node of nodes) {
      node.style.fontSize = `${config.fontSize}px`;
    }
    spiral.style.setProperty("--glow", `${config.glow}px`);
    document.querySelectorAll(".shape-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.shape === config.shape);
    });
    applyShapeVisibility();
    buildBaseSamples();
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

  function snapToTargets() {
    currentAngle = targetAngle;
    currentScale = targetScale;
    currentYaw = targetYaw;
    currentPitch = targetPitch;
  }

  function handleResize() {
    buildBaseSamples();
    updateTargetFromMouse(centerX + 180, centerY - 120);
    snapToTargets();
  }

  function setShape(shape) {
    if (!shape || shape === config.shape) return;
    config.shape = shape;
    document.querySelectorAll(".shape-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.shape === shape);
    });
    applyShapeVisibility();
    applyAutoFitScale();
    buildBaseSamples();
    // Re-derive targets for the new mode from the last known cursor center,
    // then snap so we don't ease in from stale rotation state.
    snapToTargets();
  }

  /**
   * Show/hide ctls based on `data-shapes`. Whitespace-separated tokens of
   * shape names ("spiral", "cube", "sphere"); a ctl with no `data-shapes`
   * attribute is always visible.
   */
  function applyShapeVisibility() {
    const shape = config.shape;
    document.querySelectorAll("[data-shapes]").forEach((el) => {
      const shapes = el.dataset.shapes.split(/\s+/);
      el.style.display = shapes.includes(shape) ? "" : "none";
    });
  }

  function bindShapeMenu() {
    const menu = document.querySelector(".menu-shapes");
    if (!menu) return;
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      const btn = event.target.closest(".shape-btn");
      if (!btn) return;
      setShape(btn.dataset.shape);
    });
  }

  function init() {
    generateRandomCharSequence();
    applyAutoFitScale();
    buildBaseSamples();
    ensureNodePool();
    spiral.style.setProperty("--glow", `${config.glow}px`);
    bindControls();
    bindShapeMenu();
    applyShapeVisibility();

    updateTargetFromMouse(centerX + 180, centerY - 120);
    snapToTargets();

    stage.addEventListener("mousemove", (event) => {
      if (paused) return;
      const rect = spiral.getBoundingClientRect();
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
