export type Slot = {
  slotId: string;
  trafficRank: number;
  pos: number[];
  facing: number[];
};

export type ComponentRow = {
  componentId: string;
  productId: string | null;
  title: string;
  price: number | null;
  slotId: string | null;
  trafficRank: number | null;
  kind: string | null;
  prominence: number | null;
  impressions: number;
  approaches: number;
  dwellSeconds: number;
  gazeSeconds: number;
  interactions: number;
  hesitations: number;
  panelOpens: number;
  panelActiveSeconds: number;
  ctaClicks: number;
  linkShows: number;
  purchases: number;
  sightlineRate: number | null;
  engagementRate: number | null;
  depthRate: number | null;
  intentRate: number | null;
  conversionRate: number | null;
  approachConcordance: number | null;
  avgInteractionDistance: number | null;
};

export type Analytics = {
  experimentId: string | null;
  source: string;
  experiments: string[];
  sourceBreakdown: { source: string; events: number; sessions: number }[];
  slots: Slot[];
  place?: { name: string; placeId: number; gameId: number };
  registryUpdatedAt: number | null;
  components: ComponentRow[];
  heatmap?: { x: number; z: number; n: number }[];
};

export type Plan = {
  hypothesis: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  expectedEffect: string;
  ops: Record<string, unknown>[];
};

export type Validation = {
  ok: boolean;
  accepted: Record<string, unknown>[];
  rejected: { op: Record<string, unknown>; reason: string }[];
};

export type Experiment = {
  id: string;
  name: string | null;
  hypothesis: string | null;
  status: string;
  created_at: number;
  plan_json: string | null;
  result_json: string | null;
  snapshot_before_json: string | null;
  image_before: string | null;
  image_after: string | null;
  error: string | null;
};
