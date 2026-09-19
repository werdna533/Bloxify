"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Cell = { x: number; z: number; n: number; w?: number };
type Geometry = {
  bounds: { min: number[]; max: number[] };
  boxes: { p: number[]; s: number[]; r: number[]; c: string; t: number }[];
  spawns: { name: string; p: number[] }[];
};
type HeatItem = {
  componentId: string;
  title: string;
  slotId: string;
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
  { key: "traffic", label: "WHERE THEY WALKED", hint: "path density" },
  { key: "attention", label: "WHERE THEY LOOKED FROM", hint: "gaze origins, weighted by seconds" },
  { key: "approach", label: "WHERE THEY ARRIVED", hint: "approach points" },
  { key: "interaction", label: "WHERE THEY TOUCHED", hint: "prompt triggers" },
  { key: "hesitation", label: "WHERE THEY HESITATED", hint: "slowed, looked, did not act" },
] as const;

const QUADRANT_COLOUR: Record<string, number> = {
  hotspot: 0xef4444,
  attracts_but_disappoints: 0xf59e0b,
  hidden_gem: 0x38bdf8,
  dead_weight: 0x52525b,
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const query = new URLSearchParams({ source });
        if (experimentId) query.set("experimentId", experimentId);
        const [g, h] = await Promise.all([
          fetch("/api/geometry", { cache: "no-store" }),
          fetch(`/api/heatmap?${query}`, { cache: "no-store" }),
        ]);
        if (!g.ok) throw new Error("no geometry — run bridge/export-geometry.ts");
        if (!h.ok) throw new Error(`heatmap HTTP ${h.status}`);
        if (cancelled) return;
        setGeometry((await g.json()) as Geometry);
        setHeat((await h.json()) as HeatData);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, experimentId]);

  const layerHint = useMemo(
    () => FLOOR_LAYERS.find((l) => l.key === layer)?.hint ?? "",
    [layer],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !geometry || !heat) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121215);
    scene.fog = new THREE.Fog(0x121215, 180, 420);

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

    // ---- the arena shell, as plain boxes ----
    const shellGroup = new THREE.Group();
    const shellMaterial = new THREE.MeshLambertMaterial({
      color: 0x6b7280,
      transparent: true,
      opacity: 0.16,
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
    shellGroup.visible = showShell;
    scene.add(shellGroup);

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
      scene.add(plane);
    }

    // ---- spawn markers ----
    for (const spawn of geometry.spawns) {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(3, 3, 0.4, 20),
        new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.5 }),
      );
      marker.position.set(spawn.p[0], 5.3, spawn.p[2]);
      scene.add(marker);
    }

    // ---- one pillar per product, height = attention, colour = quadrant ----
    const maxGaze = Math.max(1, ...heat.items.map((i) => i.gazeSeconds));
    const pickable: THREE.Object3D[] = [];
    for (const item of heat.items) {
      const h = 6 + (item.gazeSeconds / maxGaze) * 34;
      const colour = QUADRANT_COLOUR[item.quadrant] ?? 0x8b5cf6;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 2.6, h, 18),
        new THREE.MeshLambertMaterial({ color: colour, transparent: true, opacity: 0.85 }),
      );
      pillar.position.set(item.pos[0], 5 + h / 2, item.pos[2]);
      pillar.userData.item = item;
      scene.add(pillar);
      pickable.push(pillar);

      const label = labelSprite(
        item.title.replace(/^Waterloo /, ""),
        `#${colour.toString(16).padStart(6, "0")}`,
      );
      label.position.set(item.pos[0], 5 + h + 5, item.pos[2]);
      scene.add(label);
    }

    // ---- sightlines: who looked at what, from where ----
    const rayGroup = new THREE.Group();
    const byId = new Map(heat.items.map((i) => [i.componentId, i]));
    const maxSeconds = Math.max(1, ...heat.gazeRays.map((r) => r.seconds ?? 0));
    for (const ray of heat.gazeRays) {
      const target = byId.get(ray.componentId);
      if (!target) continue;
      const strength = Math.min(1, (ray.seconds ?? 0) / maxSeconds);
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(...ramp(strength).map((c) => c / 255) as [number, number, number]),
        transparent: true,
        opacity: 0.1 + strength * 0.4,
      });
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(ray.x, Math.max(ray.y, 6), ray.z),
          new THREE.Vector3(target.pos[0], 9, target.pos[2]),
        ]),
        material,
      );
      rayGroup.add(line);
    }
    // Long, faint lines from wherever a display was merely visible. Together
    // with the short bright gaze lines this shows the gap the funnel measures:
    // how many people could see it versus how many actually looked.
    for (const ray of heat.impressionRays ?? []) {
      const target = byId.get(ray.componentId);
      if (!target) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(ray.x, Math.max(ray.y, 6), ray.z),
          new THREE.Vector3(target.pos[0], 9, target.pos[2]),
        ]),
        new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.05 }),
      );
      rayGroup.add(line);
    }

    rayGroup.visible = showRays;
    scene.add(rayGroup);

    // ---- click a pillar to read its numbers ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickable, false)[0];
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
      texture?.dispose();
      mount.removeChild(renderer.domElement);
    };
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
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px]">
        {FLOOR_LAYERS.map((l) => (
          <button
            key={l.key}
            onClick={() => setLayer(l.key)}
            className={`rounded px-2 py-1 tracking-wider ${
              layer === l.key
                ? "bg-neutral-200 text-neutral-900"
                : "border border-[var(--rbx-line)] text-[var(--rbx-dim)] hover:bg-[var(--rbx-overlay-strong)]"
            }`}
          >
            {l.label}
          </button>
        ))}
        <span className="ml-auto flex gap-2">
          <Toggle on={showRays} onClick={() => setShowRays(!showRays)} label="SIGHTLINES" />
          <Toggle on={showShell} onClick={() => setShowShell(!showShell)} label="WALLS" />
        </span>
      </div>

      <div className="relative h-[520px] w-full overflow-hidden rounded bg-[#121215]">
        <div ref={mountRef} className="h-full w-full" />
        {(!geometry || !heat) && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-[var(--rbx-faint)]">
            loading store geometry and heat data…
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--rbx-dim)]">
        <span>{layerHint} · drag to orbit, scroll to zoom, click a pillar</span>
        <span className="flex gap-3">
          <Legend colour="#ef4444" label="hotspot" />
          <Legend colour="#f59e0b" label="attracts, doesn't convert" />
          <Legend colour="#38bdf8" label="hidden gem" />
          <Legend colour="#52525b" label="dead weight" />
        </span>
      </div>

      {selected && (
        <div className="rbx-inset mt-3 p-3 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="text-[var(--rbx-text)]">{selected.title}</span>
            <span className="text-[var(--rbx-dim)]">
              {selected.slotId} · {selected.quadrant.replace(/_/g, " ")}
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
      className={`rounded px-2 py-1 tracking-wider ${
        on ? "bg-neutral-700 text-[var(--rbx-text)]" : "border border-[var(--rbx-line)] text-[var(--rbx-dim)]"
      }`}
    >
      {label}
    </button>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colour }} />
      {label}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[9px] uppercase tracking-wider text-[var(--rbx-faint)]">{label}</div>
      <div className="text-[var(--rbx-text)]">{value}</div>
    </div>
  );
}
