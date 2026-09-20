"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { InfoTip } from "@/components/ui";

type Cell = { x: number; z: number; n: number; w?: number };
type Geometry = {
  bounds: { min: number[]; max: number[] };
  boxes: { p: number[]; s: number[]; r: number[]; c: string; t: number }[];
  spawns: { name: string; p: number[] }[];
};
type HeatItem = {
  componentId: string;
  title: string;
  pos: number[];
  impressions: number;
  approaches: number;
  gazeSeconds: number;
  interactions: number;
  panelOpens: number;
  ctaClicks: number;
  borrowedIn: number;
  pullRate: number | null;
  intentRate: number | null;
  quadrant: string;
};
type HeatData = {
  bucketSize: number;
  layers: Record<string, Cell[]>;
  gazeRays: { x: number; y: number; z: number; componentId: string; seconds: number }[];
  impressionRays: { x: number; y: number; z: number; componentId: string; distance: number }[];
  items: HeatItem[];
};

const FLOOR_LAYERS = [
  { key: "traffic", label: "Where they walked", hint: "path density" },
  { key: "attention", label: "Where they looked from", hint: "gaze origins, weighted by seconds" },
  { key: "approach", label: "Where they arrived", hint: "approach points" },
  { key: "interaction", label: "Where they touched", hint: "prompt triggers" },
  { key: "hesitation", label: "Where they hesitated", hint: "slowed, looked, did not act" },
] as const;

const QUADRANT_COLOUR: Record<string, number> = {
  hotspot: 0xef4444,
  attracts_but_disappoints: 0xf59e0b,
  hidden_gem: 0x38bdf8,
  dead_weight: 0xa855f7,
};

// All four quadrants are relative -- a median split against this store's own
// other products, not a fixed bar -- including dead weight, which is just
// "below median on both axes," the same computation as the other three.
const QUADRANT_LABEL: Record<string, string> = {
  hotspot: "hotspot",
  attracts_but_disappoints: "window shopper",
  hidden_gem: "hidden gem",
  dead_weight: "dead weight",
};

/** Blue → cyan → green → yellow → red. Classic, and readable in both themes. */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [12, 24, 74]],
    [0.25, [22, 128, 190]],
    [0.5, [40, 190, 140]],
    [0.75, [240, 200, 60]],
    [1.0, [230, 60, 40]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Builds a blurred heat texture from bucketed cells. Drawn as soft alpha blobs
 * first, then coloured through the ramp, which is what makes overlapping
 * activity read as intensity rather than as a grid of squares.
 */
function heatTexture(cells: Cell[], bounds: Geometry["bounds"], useWeight: boolean): THREE.CanvasTexture | null {
  if (cells.length === 0) return null;

  const [minX, , minZ] = bounds.min;
  const [maxX, , maxZ] = bounds.max;
  const worldW = maxX - minX;
  const worldD = maxZ - minZ;
  const scale = 8; // px per stud
  const w = Math.round(worldW * scale);
  const h = Math.round(worldD * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const value = (c: Cell) => (useWeight && c.w ? c.w : c.n);
  const peak = Math.max(...cells.map(value));
  if (peak <= 0) return null;

  // Compress the long tail: a handful of very hot cells would otherwise make
  // everything else look empty.
  const norm = (v: number) => Math.pow(v / peak, 0.45);

  ctx.clearRect(0, 0, w, h);
  const radius = 5 * scale;
  for (const cell of cells) {
    const px = (cell.x - minX) * scale;
    const py = (cell.z - minZ) * scale;
    const a = norm(value(cell));
    const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
  }

  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha <= 0.02) {
      data[i + 3] = 0;
      continue;
    }
    const [r, g, b] = ramp(Math.min(1, alpha));
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(Math.min(1, alpha * 1.25) * 255);
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * A thin cylinder standing in for a "thick line" between two points.
 * THREE.Line's `linewidth` is ignored by most WebGL backends (Chrome/ANGLE
 * always renders 1px regardless of the value set), so real, controllable
 * thickness needs actual geometry, not a line material property.
 */
function rayTube(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  colour: THREE.ColorRepresentation,
  opacity: number,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(0.01, direction.length());
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false }),
  );
  mesh.position.copy(new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  return mesh;
}

function labelSprite(text: string, colour: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(10,10,12,0.82)";
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 122);
  ctx.font = 'bold 46px "Builder Sans", Inter, system-ui, sans-serif';
  ctx.fillStyle = "#f4f4f5";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 64);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }),
  );
  sprite.scale.set(16, 4, 1);
  return sprite;
}

export function StoreHeat3D({
  source,
  experimentId,
}: {
  source: string;
  experimentId: string | null;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [heat, setHeat] = useState<HeatData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState<string>("traffic");
  const [showRays, setShowRays] = useState(true);
  const [showShell, setShowShell] = useState(true);
  const [selected, setSelected] = useState<HeatItem | null>(null);

  // Scene/camera/renderer/controls are created once per geometry load (the
  // room shell barely ever changes) and reused across every heat refresh, so
  // a live 15s poll updates the pillars/heatmap in place instead of tearing
  // down and recreating the camera -- which would snap anyone's manually
  // rotated view back to the default framing every refresh.
  const sceneRef = useRef<THREE.Scene | null>(null);
  const shellGroupRef = useRef<THREE.Group | null>(null);
  const dynamicGroupRef = useRef<THREE.Group | null>(null);
  const pickableRef = useRef<THREE.Object3D[]>([]);

  // Geometry (the room shell) is fetched once -- it only changes if someone
  // reshapes the room and restarts the server, so it doesn't belong in a
  // fast poll loop, and keeping it out of that loop is also what lets the
  // scene-setup effect below key on it without re-running every refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/geometry", { cache: "no-store" });
        if (!res.ok) throw new Error("no geometry — run bridge/export-geometry.ts");
        if (cancelled) return;
        setGeometry((await res.json()) as Geometry);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const query = new URLSearchParams({ source });
        if (experimentId) query.set("experimentId", experimentId);
        const res = await fetch(`/api/heatmap?${query}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`heatmap HTTP ${res.status}`);
        if (cancelled) return;
        setHeat((await res.json()) as HeatData);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    // This view previously had no polling at all -- it only ever showed
    // whatever loaded on mount, which is why walking around live never
    // visibly updated it. 15s matches the Overview funnel's poll cadence.
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [source, experimentId]);

  // Scene setup: camera, renderer, controls, lights, floor, wall shell, spawn
  // markers. Runs once geometry (and the first heat payload) is available,
  // and not again after that -- everything here is either static (the room
  // shell) or, for the camera framing, deliberately computed only once so a
  // manually rotated view survives every later heat refresh.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !geometry || !heat) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121215);
    scene.fog = new THREE.Fog(0x121215, 180, 420);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.5, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const [minX, , minZ] = geometry.bounds.min;
    const [maxX, , maxZ] = geometry.bounds.max;

    // Frame the storefront and the spawn, not the whole arena: the interesting
    // part is a corner of a large map, and fitting the map wastes the view.
    // The arena has a second spawn at the far end of the map, hundreds of studs
    // from the shop. Including it would zoom the camera out to frame empty floor.
    const itemCentreZ =
      heat.items.reduce((sum, i) => sum + i.pos[2], 0) / Math.max(1, heat.items.length);
    const nearbySpawns = geometry.spawns.filter((s) => Math.abs(s.p[2] - itemCentreZ) < 120);

    const focusPoints = [...heat.items.map((i) => i.pos), ...nearbySpawns.map((s) => s.p)];
    const fx = focusPoints.map((p) => p[0]);
    const fz = focusPoints.map((p) => p[2]);
    const centre = new THREE.Vector3(
      (Math.min(...fx) + Math.max(...fx)) / 2,
      5,
      (Math.min(...fz) + Math.max(...fz)) / 2,
    );
    const spread = Math.max(Math.max(...fx) - Math.min(...fx), Math.max(...fz) - Math.min(...fz));

    // Looking up the aisle from behind the spawn, which is how players see it.
    camera.position.set(centre.x + spread * 0.55, spread * 0.78, centre.z - spread * 0.82);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(centre);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(-60, 120, -40);
    scene.add(key);

    // ---- a solid floor plane, drawn first so the heatmap has something
    // opaque to sit on regardless of what geometry the room happens to have
    // near floor level ----
    const floorPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(maxX - minX, maxZ - minZ),
      new THREE.MeshLambertMaterial({ color: 0x3a4a5c }),
    );
    floorPlane.rotation.x = -Math.PI / 2;
    floorPlane.position.set((minX + maxX) / 2, 5.05, (minZ + maxZ) / 2);
    scene.add(floorPlane);

    // ---- the arena shell (walls, trim, decor), as plain boxes, very
    // translucent so it reads as a shell you can see into ----
    const shellGroup = new THREE.Group();
    const shellMaterial = new THREE.MeshLambertMaterial({
      color: 0x6b7280,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    for (const box of geometry.boxes) {
      const mesh = new THREE.Mesh(unitBox, shellMaterial);
      mesh.position.set(box.p[0], box.p[1], box.p[2]);
      mesh.scale.set(box.s[0], box.s[1], box.s[2]);
      mesh.rotation.set(box.r[0], box.r[1], box.r[2]);
      shellGroup.add(mesh);
    }
    scene.add(shellGroup);
    shellGroupRef.current = shellGroup;

    // ---- spawn markers ----
    for (const spawn of geometry.spawns) {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(3, 3, 0.4, 20),
        new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.5 }),
      );
      marker.position.set(spawn.p[0], 5.3, spawn.p[2]);
      scene.add(marker);
    }

    // ---- click a pillar to read its numbers -- reads pickableRef so a
    // click always hits whatever pillars the dynamic-content effect below
    // most recently built, not a stale list captured at scene-setup time ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickableRef.current, false)[0];
      setSelected(hit ? (hit.object.userData.item as HeatItem) : null);
    };
    renderer.domElement.addEventListener("click", onClick);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount.clientWidth) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose?.();
        }
      });
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      shellGroupRef.current = null;
    };
    // heat is deliberately excluded -- only its first arrival (gated by the
    // `!heat` guard above) matters here, for the one-time camera framing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, Boolean(heat)]);

  // Dynamic content: floor heat texture, product pillars + labels, and
  // sightline/impression rays. Rebuilt on every heat refresh, every layer
  // switch, and every toggle -- but only this group, so the camera/controls
  // set up above are untouched.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !geometry || !heat) return;

    if (shellGroupRef.current) shellGroupRef.current.visible = showShell;

    if (dynamicGroupRef.current) {
      scene.remove(dynamicGroupRef.current);
      dynamicGroupRef.current.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose?.();
          const mat = obj.material as THREE.Material & { map?: THREE.Texture };
          mat.map?.dispose?.();
          mat.dispose?.();
        } else if (obj instanceof THREE.Sprite) {
          const mat = obj.material as THREE.SpriteMaterial;
          mat.map?.dispose?.();
          mat.dispose?.();
        }
      });
    }

    const group = new THREE.Group();
    const [minX, , minZ] = geometry.bounds.min;
    const [maxX, , maxZ] = geometry.bounds.max;

    // ---- floor heat ----
    const cells = heat.layers[layer] ?? [];
    const texture = heatTexture(cells, geometry.bounds, layer === "attention");
    if (texture) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(maxX - minX, maxZ - minZ),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set((minX + maxX) / 2, 5.15, (minZ + maxZ) / 2);
      group.add(plane);
    }

    // ---- one pillar per product, height = the same pull+intent signal that
    // drives its colour, so a tall bar actually means "more hotspot-like" --
    // height used to be driven by gazeSeconds, an independent metric with no
    // guaranteed relationship to the quadrant colour it sat next to. ----
    const engagementScore = (item: HeatItem) => (item.pullRate ?? 0) + (item.intentRate ?? 0);
    const maxScore = Math.max(1e-6, ...heat.items.map(engagementScore));
    const pickable: THREE.Object3D[] = [];
    for (const item of heat.items) {
      const h = 6 + (engagementScore(item) / maxScore) * 34;
      const colour = QUADRANT_COLOUR[item.quadrant] ?? 0x8b5cf6;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 2.6, h, 18),
        new THREE.MeshLambertMaterial({ color: colour, transparent: true, opacity: 0.85 }),
      );
      pillar.position.set(item.pos[0], 5 + h / 2, item.pos[2]);
      pillar.userData.item = item;
      group.add(pillar);
      pickable.push(pillar);

      const label = labelSprite(
        item.title.replace(/^Waterloo /, ""),
        `#${colour.toString(16).padStart(6, "0")}`,
      );
      label.position.set(item.pos[0], 5 + h + 5, item.pos[2]);
      group.add(label);
    }
    pickableRef.current = pickable;

    // ---- sightlines: who looked at what, from where ----
    const rayGroup = new THREE.Group();
    const byId = new Map(heat.items.map((i) => [i.componentId, i]));
    const maxSeconds = Math.max(1, ...heat.gazeRays.map((r) => r.seconds ?? 0));
    for (const ray of heat.gazeRays) {
      const target = byId.get(ray.componentId);
      if (!target) continue;
      const strength = Math.min(1, (ray.seconds ?? 0) / maxSeconds);
      // Floor the colour lookup so even a weak ray reads as a visible cyan
      // rather than the ramp's near-black navy at t=0 -- thickness and
      // opacity still scale with real strength, but nothing goes invisible.
      const colour = new THREE.Color(...ramp(Math.max(0.3, strength)).map((c) => c / 255) as [number, number, number]);
      const tube = rayTube(
        new THREE.Vector3(ray.x, Math.max(ray.y, 6), ray.z),
        new THREE.Vector3(target.pos[0], 9, target.pos[2]),
        0.18 + strength * 0.35,
        colour,
        0.55 + strength * 0.35,
      );
      rayGroup.add(tube);
    }
    // Long, faint lines from wherever a display was merely visible. Together
    // with the short bright gaze lines this shows the gap the funnel measures:
    // how many people could see it versus how many actually looked.
    for (const ray of heat.impressionRays ?? []) {
      const target = byId.get(ray.componentId);
      if (!target) continue;
      const tube = rayTube(
        new THREE.Vector3(ray.x, Math.max(ray.y, 6), ray.z),
        new THREE.Vector3(target.pos[0], 9, target.pos[2]),
        0.1,
        0x60a5fa,
        0.3,
      );
      rayGroup.add(tube);
    }
    rayGroup.visible = showRays;
    group.add(rayGroup);

    scene.add(group);
    dynamicGroupRef.current = group;
  }, [geometry, heat, layer, showRays, showShell]);

  if (error) {
    return (
      <div className="rbx-inset p-4 text-xs text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="rbx-inset p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {FLOOR_LAYERS.map((l) => (
          <button
            key={l.key}
            title={l.hint}
            onClick={() => setLayer(l.key)}
            className={`rounded px-2.5 py-1.5 font-medium tracking-wider ${
              layer === l.key
                ? "bg-neutral-200 text-neutral-900"
                : "border border-[var(--rbx-line)] text-[var(--rbx-dim)] hover:bg-[var(--rbx-overlay-strong)]"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="relative h-[520px] w-full overflow-hidden rounded bg-[#121215]">
        <div ref={mountRef} className="h-full w-full" />
        {(!geometry || !heat) && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-[var(--rbx-faint)]">
            loading store geometry and heat data…
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-[var(--rbx-dim)]">
        <Legend colour="#ef4444" label="hotspot" />
        <Legend colour="#f59e0b" label={QUADRANT_LABEL.attracts_but_disappoints} />
        <Legend colour="#38bdf8" label="hidden gem" />
        <Legend colour="#a855f7" label="dead weight" />
        <InfoTip
          align="left"
          text="Relative to this store's own other products, not an absolute score -- a median split, run fresh each time. With a small catalog, something always lands in every category, even if all of them are performing fine."
        />
        <span className="ml-auto flex gap-3">
          <Toggle on={showRays} onClick={() => setShowRays(!showRays)} label="Sightlines" />
          <Toggle on={showShell} onClick={() => setShowShell(!showShell)} label="Walls" />
        </span>
      </div>

      {selected && (
        <div className="rbx-inset mt-3 p-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-[var(--rbx-text)]">{selected.title}</span>
            <span className="text-[var(--rbx-dim)]">
              {QUADRANT_LABEL[selected.quadrant] ?? selected.quadrant.replace(/_/g, " ")}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[var(--rbx-dim)] sm:grid-cols-4">
            <Stat label="impressions" value={selected.impressions} />
            <Stat label="approaches" value={selected.approaches} />
            <Stat label="gaze seconds" value={Math.round(selected.gazeSeconds)} />
            <Stat label="interactions" value={selected.interactions} />
            <Stat label="panel opens" value={selected.panelOpens} />
            <Stat label="CTA clicks" value={selected.ctaClicks} />
            <Stat
              label="pull rate"
              value={selected.pullRate === null ? "—" : `${Math.round(selected.pullRate * 100)}%`}
            />
            <Stat
              label="borrowed in"
              value={selected.borrowedIn}
              hint="times reached by tabbing from another display"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs font-medium tracking-wider ${
        on ? "text-[var(--rbx-text)]" : "text-[var(--rbx-dim)]"
      }`}
    >
      <span
        className={`relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full transition-colors ${
          on ? "bg-[var(--rbx-accent)]" : "bg-[var(--rbx-line)]"
        }`}
      >
        <span
          className={`inline-block h-[14px] w-[14px] transform rounded-full bg-white transition-transform ${
            on ? "translate-x-[16px]" : "translate-x-[2px]"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
      {label}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[11px] tracking-wider text-[var(--rbx-dim)]">{label}</div>
      <div className="text-sm text-[var(--rbx-text)]">{value}</div>
    </div>
  );
}
