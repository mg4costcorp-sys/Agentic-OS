// ─── Type definitions + generic sample data ─────────────────────────
// These types are used across the dashboard. The sample data below is
// purely fictional — generic developer scenarios, nothing personal.
// Real data comes from useLiveData() at runtime.

export const operator = {
  name: "Operator",
  handle: "operator",
  role: "Developer",
};

export type WorkspaceStatus = "healthy" | "stale" | "missing" | "needs review";

export interface Workspace {
  id: string;
  name: string;
  path: string;
  claudeMdStatus: WorkspaceStatus;
  lastRun: string;
  activeSkills: string[];
  recentFiles: { name: string; changed: string }[];
  recentOutputs: { name: string; type: string }[];
  memoryFreshness: number;
  usageToday: number;
  runs7d: number;
  description: string;
  summary: string;
  memoryFiles: { name: string; size: string; updated: string }[];
  sessions: { id: string; started: string; duration: string; status: string }[];
  warnings: string[];
}

export const workspaces: Workspace[] = [
  {
    id: "ecommerce-api",
    name: "E-Commerce API",
    path: "~/projects/ecommerce-api",
    claudeMdStatus: "healthy",
    lastRun: "20m ago",
    activeSkills: ["Code Reviewer", "Unit Test Writer"],
    recentFiles: [
      { name: "src/routes/checkout.ts", changed: "20m ago" },
      { name: "src/models/order.ts", changed: "1h ago" },
    ],
    recentOutputs: [{ name: "checkout-refactor.md", type: "report" }],
    memoryFreshness: 88,
    usageToday: 3.50,
    runs7d: 24,
    description: "REST API for the online store.",
    summary: "Active workspace. Good skill coverage.",
    memoryFiles: [
      { name: "CLAUDE.md", size: "6.2 KB", updated: "1d ago" },
      { name: "decisions.md", size: "2.8 KB", updated: "2d ago" },
    ],
    sessions: [
      { id: "run_a1b2", started: "20m ago", duration: "5m 30s", status: "success" },
      { id: "run_a1b1", started: "2h ago", duration: "8m 12s", status: "success" },
    ],
    warnings: [],
  },
  {
    id: "mobile-app",
    name: "Mobile App",
    path: "~/projects/mobile-app",
    claudeMdStatus: "needs review",
    lastRun: "3h ago",
    activeSkills: ["Bug Fixer", "API Doc Generator"],
    recentFiles: [
      { name: "lib/screens/home.dart", changed: "3h ago" },
      { name: "lib/services/auth.dart", changed: "5h ago" },
    ],
    recentOutputs: [{ name: "auth-flow-review.md", type: "review" }],
    memoryFreshness: 62,
    usageToday: 5.10,
    runs7d: 31,
    description: "Cross-platform mobile application.",
    summary: "CLAUDE.md needs a refresh. Two skills active.",
    memoryFiles: [
      { name: "CLAUDE.md", size: "4.1 KB", updated: "9d ago" },
    ],
    sessions: [
      { id: "run_c3d4", started: "3h ago", duration: "12m 08s", status: "success" },
    ],
    warnings: ["CLAUDE.md older than 7 days"],
  },
  {
    id: "internal-docs",
    name: "Internal Docs",
    path: "~/projects/internal-docs",
    claudeMdStatus: "healthy",
    lastRun: "45m ago",
    activeSkills: ["API Doc Generator"],
    recentFiles: [
      { name: "docs/api-reference.md", changed: "45m ago" },
      { name: "docs/getting-started.md", changed: "2h ago" },
    ],
    recentOutputs: [{ name: "api-v2-docs.md", type: "documentation" }],
    memoryFreshness: 91,
    usageToday: 1.80,
    runs7d: 12,
    description: "Team documentation and API references.",
    summary: "Clean workspace. Documentation up to date.",
    memoryFiles: [
      { name: "CLAUDE.md", size: "3.5 KB", updated: "2d ago" },
    ],
    sessions: [
      { id: "run_e5f6", started: "45m ago", duration: "3m 50s", status: "success" },
    ],
    warnings: [],
  },
  {
    id: "design-system",
    name: "Design System",
    path: "~/projects/design-system",
    claudeMdStatus: "stale",
    lastRun: "4d ago",
    activeSkills: ["Code Reviewer"],
    recentFiles: [{ name: "src/components/Button.tsx", changed: "4d ago" }],
    recentOutputs: [],
    memoryFreshness: 35,
    usageToday: 0,
    runs7d: 3,
    description: "Shared component library.",
    summary: "Quiet this week. Memory drifting.",
    memoryFiles: [
      { name: "CLAUDE.md", size: "2.9 KB", updated: "14d ago" },
    ],
    sessions: [
      { id: "run_g7h8", started: "4d ago", duration: "6m 22s", status: "success" },
    ],
    warnings: ["Memory freshness below 50%"],
  },
];

export const skills = [
  {
    name: "Code Reviewer",
    category: "Coding",
    scope: "global",
    workspace: null,
    lastUsed: "20m ago",
    status: "active",
    inputs: ["diff"],
    outputs: ["md"],
    uses: 85,
    score: 91,
  },
  {
    name: "Unit Test Writer",
    category: "Coding",
    scope: "global",
    workspace: null,
    lastUsed: "1h ago",
    status: "active",
    inputs: ["source"],
    outputs: ["test"],
    uses: 54,
    score: 87,
  },
  {
    name: "API Doc Generator",
    category: "Automation",
    scope: "global",
    workspace: null,
    lastUsed: "45m ago",
    status: "active",
    inputs: ["routes"],
    outputs: ["md"],
    uses: 32,
    score: 82,
  },
  {
    name: "Bug Fixer",
    category: "Coding",
    scope: "global",
    workspace: null,
    lastUsed: "3h ago",
    status: "active",
    inputs: ["error"],
    outputs: ["patch"],
    uses: 41,
    score: 78,
  },
  {
    name: "Dependency Auditor",
    category: "Review",
    scope: "global",
    workspace: null,
    lastUsed: "2d ago",
    status: "stale",
    inputs: ["lockfile"],
    outputs: ["report"],
    uses: 12,
    score: 65,
  },
  {
    name: "Migration Planner",
    category: "Automation",
    scope: "global",
    workspace: null,
    lastUsed: "5d ago",
    status: "stale",
    inputs: ["schema"],
    outputs: ["plan"],
    uses: 8,
    score: 58,
  },
];

export const skillCategories = [
  "Research",
  "Coding",
  "Review",
  "Memory",
  "Video",
  "Design",
  "Automation",
  "Reporting",
] as const;

export const runs = [
  {
    id: "run_a1b2",
    workspace: "E-Commerce API",
    skill: "Code Reviewer",
    started: "20m ago",
    duration: "5m 30s",
    status: "success",
    files: 4,
    outputs: 1,
    tools: ["git", "file edit"],
    tokens: 15200,
    cost: 0.38,
    errors: 0,
    summary: "Reviewed checkout refactor.",
  },
  {
    id: "run_c3d4",
    workspace: "Mobile App",
    skill: "Bug Fixer",
    started: "3h ago",
    duration: "12m 08s",
    status: "success",
    files: 7,
    outputs: 1,
    tools: ["shell", "file edit"],
    tokens: 28400,
    cost: 0.72,
    errors: 0,
    summary: "Fixed auth token refresh loop.",
  },
  {
    id: "run_e5f6",
    workspace: "Internal Docs",
    skill: "API Doc Generator",
    started: "45m ago",
    duration: "3m 50s",
    status: "success",
    files: 3,
    outputs: 1,
    tools: ["file edit"],
    tokens: 9800,
    cost: 0.24,
    errors: 0,
    summary: "Generated API v2 reference docs.",
  },
  {
    id: "run_g7h8",
    workspace: "Design System",
    skill: "Code Reviewer",
    started: "4d ago",
    duration: "6m 22s",
    status: "success",
    files: 5,
    outputs: 0,
    tools: ["file edit"],
    tokens: 18100,
    cost: 0.45,
    errors: 0,
    summary: "Reviewed Button component variants.",
  },
];

export const outputs = [
  {
    name: "checkout-refactor.md",
    type: "report",
    workspace: "E-Commerce API",
    run: "run_a1b2",
    skill: "Code Reviewer",
    updated: "20m ago",
    size: "6 KB",
  },
  {
    name: "auth-flow-review.md",
    type: "review",
    workspace: "Mobile App",
    run: "run_c3d4",
    skill: "Bug Fixer",
    updated: "3h ago",
    size: "4 KB",
  },
  {
    name: "api-v2-docs.md",
    type: "documentation",
    workspace: "Internal Docs",
    run: "run_e5f6",
    skill: "API Doc Generator",
    updated: "45m ago",
    size: "12 KB",
  },
];

export type MemorySourceId = string;

export interface MemorySource {
  id: string;
  label: string;
  kind: "local" | "vector";
  color: string;
  vectorCount?: number;
  namespaces?: number;
  dimension?: number;
  tooltip: string;
}

export const memorySources: MemorySource[] = [
  {
    id: "local-notes",
    label: "Local Notes",
    kind: "local",
    color: "#7c3aed",
    tooltip: "Your local markdown notes.",
  },
  {
    id: "claude-memory",
    label: "Claude Memory",
    kind: "local",
    color: "#D97757",
    tooltip: "~/.claude/projects/*/memory/ — captured by Claude.",
  },
  {
    id: "knowledge-base",
    label: "Knowledge Base",
    kind: "vector",
    color: "#3b82f6",
    vectorCount: 4200,
    namespaces: 3,
    dimension: 1024,
    tooltip: "Vector store for project knowledge.",
  },
];

export type MemoryEventType = "edit" | "vectorize" | "recall";
export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  target: string;
  destination?: string;
  time: string;
  source: string;
  meta?: { hits?: number };
}

export const memoryEvents: MemoryEvent[] = [
  { id: "e1", type: "edit", target: "docs/architecture.md", time: "30m ago", source: "local-notes" },
  { id: "e2", type: "recall", target: "API design patterns", time: "1h ago", source: "knowledge-base", meta: { hits: 3 } },
  { id: "e3", type: "vectorize", target: "session-a1b2", destination: "knowledge-base", time: "2h ago", source: "claude-memory" },
];

export const memorySignals = {
  freshness: 72,
  recentlyUpdated: [
    { name: "E-Commerce API / CLAUDE.md", updated: "1d ago" },
    { name: "Internal Docs / CLAUDE.md", updated: "2d ago" },
  ],
  stale: [
    { name: "Design System / CLAUDE.md", updated: "14d ago" },
    { name: "Mobile App / CLAUDE.md", updated: "9d ago" },
  ],
  conflicts: [],
  missing: [],
  archiveCandidates: [],
  recalledThisWeek: 12,
};

export const memoryStats = {
  activeLast7d: 3,
  activatedLast7d: 12,
  totalDataSources: 3,
  missing: 0,
};

export const usageDaily = [
  { day: "Mon", cost: 2.8, runs: 8 },
  { day: "Tue", cost: 4.1, runs: 11 },
  { day: "Wed", cost: 3.5, runs: 9 },
  { day: "Thu", cost: 5.2, runs: 14 },
  { day: "Fri", cost: 4.8, runs: 12 },
  { day: "Sat", cost: 1.2, runs: 3 },
  { day: "Sun", cost: 3.9, runs: 10 },
];

export const overviewStats = {
  runsToday: 10,
  activeSkills: 4,
  estUsageToday: 10.40,
  filesChangedToday: 19,
  failedRuns: 0,
  staleMemories: 2,
};

// Demo knowledge graph for the Memory page's Knowledge Explorer — a small
// AI-engineering study vault so a fresh clone renders the relational view
// keyless. Real vaults replace this via `bun run scripts/aggregate.ts`
// (memory.knowledge in live-data.json). Shape mirrors the aggregator's.
export const knowledgeDemo = {
  vault: "demo-vault",
  stats: {
    notes: 14,
    links: 24,
    byType: { concept: 6, source: 4, entity: 2, topic: 2 },
    unresolved: 0,
  },
  notes: [
    { id: "context-engineering", title: "Context engineering", type: "concept", folder: "concepts", tags: ["context", "prompts", "agents"], confidence: "high", updated: "2026-05-02", excerpt: "Managing what enters the model's window beats clever wording: curate, compress, and order context deliberately. The window is a budget — spend it on signal.", out: ["prompt-caching", "agentic-loops", "2026-04-02-lecture-long-context", "rag-pipelines"], sourceCount: 3 },
    { id: "prompt-caching", title: "Prompt caching", type: "concept", folder: "concepts", tags: ["caching", "cost", "latency"], confidence: "high", updated: "2026-04-28", excerpt: "Stable prefixes make repeat calls cheap and fast. Structure system prompts so the immutable part comes first and the volatile part last.", out: ["context-engineering", "2026-03-14-docs-caching-deep-dive"], sourceCount: 2 },
    { id: "agentic-loops", title: "Agentic loops", type: "concept", folder: "concepts", tags: ["agents", "tools", "autonomy"], confidence: "high", updated: "2026-05-10", excerpt: "Gather context → act → verify → repeat. The verify step separates agents that ship from agents that wander.", out: ["eval-harnesses", "tool-design", "2026-04-19-talk-building-agents"], sourceCount: 4 },
    { id: "eval-harnesses", title: "Eval harnesses", type: "concept", folder: "concepts", tags: ["evals", "testing", "quality"], confidence: "medium", updated: "2026-04-20", excerpt: "An agent without evals is vibes with extra steps. Small graded task suites catch regressions that demos hide.", out: ["agentic-loops", "2026-04-19-talk-building-agents"], sourceCount: 2 },
    { id: "rag-pipelines", title: "RAG pipelines", type: "concept", folder: "concepts", tags: ["retrieval", "embeddings", "search"], confidence: "medium", updated: "2026-03-30", excerpt: "Retrieval quality is the ceiling on answer quality. Chunking strategy and reranking matter more than embedding model choice.", out: ["context-engineering", "vector-stores"], sourceCount: 2 },
    { id: "tool-design", title: "Tool design", type: "concept", folder: "concepts", tags: ["tools", "interfaces", "agents"], confidence: "high", updated: "2026-05-08", excerpt: "Tools are prompts in disguise: names, descriptions, and error messages teach the model how to behave. Design them like APIs for a brilliant intern.", out: ["agentic-loops", "2026-04-19-talk-building-agents"], sourceCount: 2 },
    { id: "2026-03-14-docs-caching-deep-dive", title: "Docs — Prompt caching deep dive", type: "source", folder: "sources", tags: ["caching", "docs"], confidence: "high", updated: "2026-03-14", excerpt: "Official guidance on cache breakpoints, TTLs, and prefix stability — the economics of warm context.", out: ["prompt-caching"], sourceCount: 1 },
    { id: "2026-04-02-lecture-long-context", title: "Lecture — Long-context tradeoffs", type: "source", folder: "sources", tags: ["context", "lecture"], confidence: "high", updated: "2026-04-02", excerpt: "Why bigger windows don't mean better recall: position bias, distractors, and the case for aggressive curation.", out: ["context-engineering"], sourceCount: 1 },
    { id: "2026-04-19-talk-building-agents", title: "Talk — Building effective agents", type: "source", folder: "sources", tags: ["agents", "talk"], confidence: "high", updated: "2026-04-19", excerpt: "Start with workflows, graduate to agents only when the task demands autonomy. Simple composable patterns beat frameworks.", out: ["agentic-loops", "tool-design", "anthropic-cookbook"], sourceCount: 1 },
    { id: "2026-05-06-paper-memory-systems", title: "Paper — Memory systems survey", type: "source", folder: "sources", tags: ["memory", "paper"], confidence: "medium", updated: "2026-05-06", excerpt: "Taxonomy of agent memory: episodic logs, semantic stores, and reflective summaries — and when each pays off.", out: ["vector-stores", "context-engineering"], sourceCount: 1 },
    { id: "anthropic-cookbook", title: "Anthropic Cookbook", type: "entity", folder: "entities", tags: ["resource", "examples"], confidence: "high", updated: "2026-04-19", excerpt: "Canonical worked examples for tool use, RAG, and agent patterns — the reference implementations the concepts trace back to.", out: ["tool-design", "rag-pipelines"], sourceCount: 5 },
    { id: "claude-code", title: "Claude Code", type: "entity", folder: "entities", tags: ["agent", "cli"], confidence: "high", updated: "2026-05-10", excerpt: "Agentic coding harness — a live case study in context management, tool design, and verification loops.", out: ["agentic-loops", "context-engineering", "eval-harnesses"], sourceCount: 4 },
    { id: "vector-stores", title: "Vector stores", type: "topic", folder: "topics", tags: ["retrieval", "infrastructure"], confidence: "medium", updated: "2026-03-28", excerpt: "Index-per-domain vs namespaces, hybrid search, and the operational cost of keeping embeddings fresh.", out: ["rag-pipelines"], sourceCount: 2 },
    { id: "agents", title: "Agents", type: "topic", folder: "topics", tags: ["agents", "overview"], confidence: "high", updated: "2026-05-11", excerpt: "Hub page: everything filed under autonomous and semi-autonomous LLM systems.", out: ["agentic-loops", "tool-design", "eval-harnesses", "claude-code"], sourceCount: 6 },
  ],
  links: [
    { s: "context-engineering", t: "prompt-caching" },
    { s: "context-engineering", t: "agentic-loops" },
    { s: "context-engineering", t: "2026-04-02-lecture-long-context" },
    { s: "context-engineering", t: "rag-pipelines" },
    { s: "prompt-caching", t: "context-engineering" },
    { s: "prompt-caching", t: "2026-03-14-docs-caching-deep-dive" },
    { s: "agentic-loops", t: "eval-harnesses" },
    { s: "agentic-loops", t: "tool-design" },
    { s: "agentic-loops", t: "2026-04-19-talk-building-agents" },
    { s: "eval-harnesses", t: "agentic-loops" },
    { s: "eval-harnesses", t: "2026-04-19-talk-building-agents" },
    { s: "rag-pipelines", t: "context-engineering" },
    { s: "rag-pipelines", t: "vector-stores" },
    { s: "tool-design", t: "agentic-loops" },
    { s: "tool-design", t: "2026-04-19-talk-building-agents" },
    { s: "2026-03-14-docs-caching-deep-dive", t: "prompt-caching" },
    { s: "2026-04-02-lecture-long-context", t: "context-engineering" },
    { s: "2026-04-19-talk-building-agents", t: "agentic-loops" },
    { s: "2026-04-19-talk-building-agents", t: "tool-design" },
    { s: "2026-04-19-talk-building-agents", t: "anthropic-cookbook" },
    { s: "2026-05-06-paper-memory-systems", t: "vector-stores" },
    { s: "2026-05-06-paper-memory-systems", t: "context-engineering" },
    { s: "anthropic-cookbook", t: "tool-design" },
    { s: "anthropic-cookbook", t: "rag-pipelines" },
    { s: "claude-code", t: "agentic-loops" },
    { s: "claude-code", t: "context-engineering" },
    { s: "claude-code", t: "eval-harnesses" },
    { s: "vector-stores", t: "rag-pipelines" },
    { s: "agents", t: "agentic-loops" },
    { s: "agents", t: "tool-design" },
    { s: "agents", t: "eval-harnesses" },
    { s: "agents", t: "claude-code" },
  ],
};
