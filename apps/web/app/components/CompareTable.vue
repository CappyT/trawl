<script lang="ts" setup>
const barsVisible = shallowRef(false)
const benchGrid = useTemplateRef<HTMLElement>("benchGrid")
let benchmarkObserver: IntersectionObserver

onMounted(() => {
  if (!benchGrid.value) return
  benchmarkObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        barsVisible.value = true
        benchmarkObserver.disconnect()
      }
    },
    { threshold: 0.2 },
  )
  benchmarkObserver.observe(benchGrid.value)
})

onBeforeUnmount(() => benchmarkObserver?.disconnect())

const benchmarks = [
  {
    url: "nowsecure.nl",
    type: "No CF protection (Tier 1)",
    maxMs: 3100,
    results: [
      { name: "TRAWL", ms: 200, label: "0.2s", winner: true },
      { name: "FlareSolverr", ms: 2600, label: "2.6s", winner: false },
      { name: "Byparr", ms: 3100, label: "3.1s", winner: false },
    ],
  },
  {
    url: "iplocation.net",
    type: "Cloudflare interstitial (Tier 3)",
    maxMs: 18700,
    results: [
      { name: "TRAWL", ms: 4200, label: "4.2s", winner: true },
      { name: "FlareSolverr", ms: 11300, label: "11.3s", winner: false },
      { name: "Byparr", ms: 18700, label: "18.7s", winner: false },
    ],
  },
  {
    url: "nopecha.com/demo/cloudflare",
    type: "CF + Turnstile (Tier 3)",
    maxMs: 18200,
    results: [
      { name: "TRAWL", ms: 5900, label: "5.9s", winner: true },
      { name: "FlareSolverr", ms: 13200, label: "13.2s", winner: false },
      { name: "Byparr", ms: 18200, label: "18.2s", winner: false },
    ],
  },
]

type CellTone = "check" | "cross" | "partial"
interface ComparisonCell {
  text: string
  tone: CellTone
}

const statusMarks: Record<CellTone, string> = { check: "✓", partial: "~", cross: "✗" }
const cell = (tone: CellTone, text: string): ComparisonCell => ({ text, tone })

const rows = [
  {
    icon: "⬡",
    feature: "Adaptive routing",
    trawl: cell("check", "HTTP → cache → browser → residential"),
    flaresolver: cell("cross", "Browser only"),
    byparr: cell("cross", "Browser only"),
  },
  {
    icon: "⇄",
    feature: "Challenge proxy",
    trawl: cell("check", "HTTP/S, WebSockets, Range"),
    flaresolver: cell("cross", "API only"),
    byparr: cell("cross", "API only"),
  },
  {
    icon: "↝",
    feature: "Proxy escalation",
    trawl: cell("check", "DC → residential"),
    flaresolver: cell("partial", "Manual proxy"),
    byparr: cell("partial", "Manual proxy"),
  },
  {
    icon: "◎",
    feature: "Session reuse",
    trawl: cell("check", "Redis by domain"),
    flaresolver: cell("partial", "Manual sessions"),
    byparr: cell("cross", "No domain cache"),
  },
  {
    icon: "▣",
    feature: "Browser pool",
    trawl: cell("check", "Configurable and warm"),
    flaresolver: cell("partial", "Temporary or session"),
    byparr: cell("cross", "New browser per request"),
  },
  {
    icon: "⟳",
    feature: "Pool lifecycle",
    trawl: cell("check", "Health checks + recycling"),
    flaresolver: cell("cross", "No warm pool"),
    byparr: cell("cross", "No warm pool"),
  },
  {
    icon: "⊕",
    feature: "Custom headers",
    trawl: cell("check", "Safe across all tiers"),
    flaresolver: cell("cross", "Not supported"),
    byparr: cell("cross", "Not supported"),
  },
  {
    icon: "◈",
    feature: "Browser engine",
    trawl: cell("check", "Camoufox"),
    flaresolver: cell("partial", "Chrome + UDC"),
    byparr: cell("check", "Camoufox"),
  },
  {
    icon: "◇",
    feature: "/v1 API",
    trawl: cell("check", "GET + POST"),
    flaresolver: cell("check", "Native"),
    byparr: cell("partial", "GET only"),
  },
  {
    icon: "○",
    feature: "Paid solver APIs",
    trawl: cell("check", "Not required"),
    flaresolver: cell("check", "Not required"),
    byparr: cell("check", "Not required"),
  },
  {
    icon: "⌂",
    feature: "Self-hosted",
    trawl: cell("check", "Yes"),
    flaresolver: cell("check", "Yes"),
    byparr: cell("check", "Yes"),
  },
]
</script>

<template>
  <section id="compare" class="section">
    <div class="container">
      <p class="eyebrow">benchmarks</p>
      <h2 class="section-title">Less browser overhead. More ways through.</h2>
      <p class="section-lead">
        Compare real request timings and the paths each engine can take—from direct HTTP to full browser solving and
        proxy escalation.
      </p>

      <div ref="benchGrid" class="bench-grid">
        <div
          v-for="b in benchmarks"
          :key="b.url"
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
          class="bench-card"
        >
          <div class="bench-url">{{ b.url }}</div>
          <div class="bench-type">{{ b.type }}</div>
          <div class="bench-bars">
            <div v-for="r in b.results" :key="r.name" class="bench-row">
              <span class="bench-name" :class="{ 'bench-winner': r.winner }">{{ r.name }}</span>
              <div class="bench-bar-wrap">
                <div
                  class="bench-bar"
                  :class="{ 'bench-bar-winner': r.winner }"
                  :style="{ width: barsVisible ? `${(r.ms / b.maxMs) * 100}%` : '0%' }"
                />
              </div>
              <span class="bench-ms" :class="{ 'accent': r.winner }">{{ r.label }}</span>
            </div>
          </div>
        </div>
      </div>

      <p class="benchmark-note">
        Measurements recorded on the same machine and network. They are illustrative, not guarantees; live results vary
        with target protection, IP reputation, software versions, and session state. Capability rows were reviewed
        against the upstream projects.
      </p>

      <div class="table-wrap" style="margin-top: 56px;">
        <table>
          <caption class="sr-only">
            Feature comparison across TRAWL, FlareSolverr, and Byparr
          </caption>
          <colgroup>
            <col class="feature-width" />
            <col class="trawl-width" />
            <col class="competitor-width" />
            <col class="competitor-width" />
          </colgroup>
          <thead>
            <tr>
              <th>capability</th>
              <th class="col-trawl"><span class="accent">TRAWL</span></th>
              <th>FlareSolverr</th>
              <th>Byparr</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.feature">
              <td class="feature-col">
                <span class="feature-icon" aria-hidden="true">{{ row.icon }}</span>{{ row.feature }}
              </td>
              <td class="col-trawl">
                <span :class="row.trawl.tone"
                  ><span class="status-mark">{{ statusMarks[row.trawl.tone] }}</span>{{ row.trawl.text }}</span
                >
              </td>
              <td>
                <span :class="row.flaresolver.tone"
                  ><span class="status-mark">{{ statusMarks[row.flaresolver.tone] }}</span>
                  {{ row.flaresolver.text }}</span
                >
              </td>
              <td>
                <span :class="row.byparr.tone"
                  ><span class="status-mark">{{ statusMarks[row.byparr.tone] }}</span>{{ row.byparr.text }}</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section-title {
  font-size: clamp(22px, 3vw, 34px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  margin-bottom: 12px;
}

.section-lead {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-muted);
  max-width: 650px;
  margin-bottom: 24px;
}

.benchmark-note {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.benchmark-note {
  max-width: 760px;
  margin-bottom: 48px;
}

/* ── Benchmark cards ── */
.bench-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border);
}

.bench-card {
  background: var(--bg);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bench-url {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.01em;
}

.bench-type {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-top: -8px;
}

.bench-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bench-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bench-name {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  min-width: 72px;
  flex-shrink: 0;
}

.bench-winner {
  color: var(--accent);
  font-weight: 600;
}

.bench-bar-wrap {
  flex: 1;
  height: 4px;
  background: var(--border);
}

.bench-bar {
  height: 100%;
  background: var(--border-strong);
  transition: width 1.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.bench-bar-winner {
  background: var(--accent);
}

.bench-ms {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
  flex-shrink: 0;
}

/* ── Feature table ── */
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
}

table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}

.feature-width {
  width: 19%;
}

.trawl-width {
  width: 31%;
}

.competitor-width {
  width: 25%;
}

th,
td {
  padding: 11px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

th {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-subtle);
  font-weight: 600;
}

td {
  color: var(--text-muted);
}

.feature-col {
  color: var(--text);
  font-weight: 500;
  white-space: normal;
}

.feature-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 8px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  vertical-align: middle;
}

.col-trawl {
  background: var(--accent-tint);
}

tr:last-child td {
  border-bottom: none;
}
tr:hover td {
  background: var(--bg-subtle);
}
tr:hover .col-trawl {
  background: color-mix(in srgb, var(--accent-tint) 150%, transparent);
}

.check {
  color: var(--accent);
  font-weight: 600;
}
.cross {
  color: var(--text-muted);
  opacity: 0.4;
}
.partial {
  color: #f59e0b;
}

.status-mark {
  display: inline-block;
  width: 16px;
  font-weight: 700;
}

@media (max-width: 800px) {
  .bench-grid {
    grid-template-columns: 1fr;
  }

  table {
    min-width: 860px;
    table-layout: auto;
  }
}
</style>
