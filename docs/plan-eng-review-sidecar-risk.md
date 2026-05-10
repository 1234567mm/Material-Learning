# Engineering Review: 科研知识库系统设计

**Review Date:** 2026-05-09
**Design Doc:** `docs/design-knowledge-base-20260509.md` (Status: APPROVED)
**Branch:** master
**Focus:** (1) Chroma+llama-server dual sidecar packaging risk, (2) sidecar startup order, (3) process count reduction

---

## Step 0: Scope Challenge

### Complexity Check

The design has these new components:
- Tauri 2.x desktop app (Rust + React)
- llama-server (Python sidecar)
- Chroma standalone (Python sidecar)
- SQLite + filesystem storage
- React UI with Ant Design

**Trigger:** 2 new Python sidecar processes introduced. This matches the complexity smell condition.

### Prior Learning

User stated: "我刚刚在另一个项目(mem-switch)因为 Python sidecar 未打包导致 Windows 空白、Linux 转圈，花了大量时间排查"

This is a strong signal. The design doubles down on Python sidecars (Chroma + llama-server) with no mitigation for the packaging failure mode that bit them in mem-switch.

---

## 1. Architecture Review

### Finding 1: Dual Python Sidecar — Packaging Risk (High Severity)

**Confidence: 9/10** (user-provided prior experience)

**Problem:** Chroma standalone and llama-server are both Python processes. The design document states "第一版直接集成 Chroma standalone" and "HTTP Server 模式（llama-server）" but neither document addresses the packaging complexity of bundling two Python sidecars into a Tauri executable.

**Realistic production failure scenario:**
- On Windows: Tauri bundles the app but Python sidecar fails silently because `PYTHONPATH` or `PATH` isn't set correctly in the installer. User sees a blank window (the Tauri shell loads but the sidecar that provides AI capabilities doesn't). This is exactly what happened in mem-switch.
- On Linux: The sidecar process starts but can't find shared libraries (e.g., `libpython3.so`). The app window spins indefinitely. The user has no visibility into why.
- Both: Even if the binary starts, Chroma uses an ephemeral port for its embedded DB. If llama-server starts first and occupies a port Chroma wants, startup fails silently with no user-visible error.

**What's in the design:**
```
Dependencies:
1. llama.cpp：模型推理核心，作为子进程管理
2. Chroma：向量数据库，作为子进程管理
```

No mention of: how to bundle Python, how to handle port conflicts, how to verify startup health, what happens if one sidecar fails to start.

### Finding 2: Startup Order Dependency (High Severity)

**Confidence: 8/10** (architectural issue)

**Problem:** The design specifies llama-server starts first (llama.cpp 优先加载), Chroma 后加载. This ordering is implicit in the constraint text but never validated or enforced in any startup sequence diagram.

**Concrete failure scenario:**
1. App launches → starts llama-server → waits for `/health` or port open
2. Meanwhile, Chroma starts on a random port
3. App tries to connect to Chroma but it's not ready → retry loop or connection refused
4. User sees "向量检索不可用" but no actionable recovery

The design says "Chroma 后加载；内存不足时 Chroma 降级为纯元数据检索（FTS fallback）" — but this fallback only works if the app detects the failure and switches strategy. There's no health check protocol defined.

### Finding 3: No Process Health Monitoring (Medium Severity)

**Confidence: 7/10**

The design mentions "作为子进程管理" but doesn't define:
- How the Rust process detects a sidecar crash
- Whether to restart or fall back (FTS)
- How to surface sidecar errors to the user
- Whether sidecar output goes to a log file the user can access

Without this, the app is "rust shell + two fragile python processes" with no visibility when things break.

---

## 2. Code Quality Review

Not applicable — design-only review, no implementation code exists yet.

---

## 3. Test Review

No code to test. This review should be re-run after implementation begins to verify test coverage.

---

## 4. Performance Review

### Finding 4: 16GB RAM + 2 Python Sidecars — Memory Pressure Risk (High Severity)

**Confidence: 9/10** (verified against hardware constraint table)

**Problem:** The hardware constraint is i5-13500H + 16GB RAM. The design plans to run:
- llama-server + 3B Q4_K model (~1.7GB working set)
- Chroma standalone (Python + ChromaDB, estimated ~300-500MB)
- Tauri app + React frontend (~200-300MB)
- OS + other overhead (~2-3GB)

**Sum:** ~5-6GB minimum, likely hitting 8-9GB with active chat context.

The design mentions "内存不足时 Chroma 降级为纯元数据检索（FTS fallback）" but:
- This fallback isn't implemented, just mentioned as a possibility
- The app doesn't have a runtime memory monitor to trigger this switch
- No circuit breaker that gracefully degrades when memory is low

**Realistic scenario:** User opens app, starts chatting, memory accumulates across sessions. At some point the system starts swapping to disk. Chat becomes slower. Eventually Chrome/chromium processes get killed by OOM killer. User loses work.

---

## Alternative Approaches to Reduce Process Count

### Option A: Keep Both Sidecars (Status Quo) — Not Recommended

**Pros:**
- Chroma has best-in-class semantic search quality
- llama-server is stable and well-maintained
- Separation of concerns is clean

**Cons:**
- Two Python processes to bundle, monitor, and debug
- mem-switch already taught us the packaging pain
- Startup ordering needs explicit handling
- Memory budget becomes tight

**Recommendation:** Not recommended given user's prior experience with mem-switch.

### Option B: Embed Chroma in Rust (Replace Python Sidecar with Rust Alternative)

**Approach:** Use `meilisearch` (Rust, single binary, ~50MB) or `Sonic` (Rust, embedded, no server needed) instead of Chroma.

**Pros:**
- Eliminates Python sidecar entirely
- meilisearch has excellent Rust bindings
- Single binary, no Python dependency
- Built-in health check API

**Cons:**
- Semantic search quality of meilisearch vs Chroma needs evaluation
- Migration of vector search logic to new engine
- Different query API

**Effort:** ~1-2 weeks to evaluate and swap

### Option C: Merge llama-server into Main Tauri Process (FFI)

**Approach:** Use direct `bindgen` llama.cpp bindings instead of HTTP server. The llama-integration-interface-design.md already documents this as the "备选：Direct FFI（未来性能优化）".

**Pros:**
- Eliminates one sidecar process
- Reduces latency (no HTTP overhead)
- Better memory management (shared process)

**Cons:**
- llama.cpp FFI complexity is high (C ABI + memory management)
- Model loading/unloading becomes app responsibility
- Less isolation (crash takes down app)

**Effort:** High — the design correctly notes this is "未来性能优化" not MVP

### Option D: Inline SQLite FTS as Fallback (Reduce "Chroma Required" Surface)

**Approach:** Treat FTS5 not as "fallback" but as "primary when Chroma unavailable." Design the app to work fully without Chroma using SQLite FTS5. Chroma becomes an enhancement, not a requirement.

**Pros:**
- App works on day 1 with zero sidecars
- Reduces memory footprint dramatically
- MVP can ship faster

**Cons:**
- FTS5 is keyword search, not semantic search
- User experience with pure FTS vs semantic search quality gap

**Effort:** Low — SQLite FTS is already in the stack

---

## NOT in Scope

1. **Direct llama.cpp FFI** — deferred to v2 ("未来性能优化")
2. **画像系统 / 习惯统计 / 模型推荐** — Approach C defers these to v2
3. **PDF OCR 支持** — deferred to v2
4. **claude-mem 数据库同步** — deferred to v2
5. **多语言模型支持** — only Chinese/English in scope

---

## What Already Exists

1. **llama-integration-interface-design.md** — complete Rust trait definitions for llama.cpp integration. These traits define the FFI contract that an FFI implementation would satisfy.
2. **knowledge-base Tauri project** — reference architecture (Tauri 2.x + React) that can be forked for project scaffolding.
3. **SQLite schema** — defined in design doc with table structures.

---

## Decisions to Confirm

### Decision 1: Eliminate Python Sidecar Packaging Risk

**D1 — Replace Chroma with Rust Vector Search**
Project/branch/task: Material-Learning master — reduce sidecar process count from 2 to 1
ELI10: You burned yourself on Python sidecar packaging in mem-switch. This design doubles down on two Python sidecars (Chroma + llama-server). We can replace Chroma with a Rust-native search engine (meilisearch or tantivy) and keep only llama-server as the sidecar. That cuts the packaging risk in half.
Stakes if we pick wrong: If we keep dual Python sidecars, we re-live the mem-switch blank window / spinning loader pain. Users get an app that fails to start with no actionable error.
Recommendation: **Option B** — replace Chroma with meilisearch/tantivy. Keep llama-server only. This halves the packaging surface and eliminates the startup ordering problem (one sidecar, no ordering issue).
Completeness: A=8/10, B=3/10 (A = eliminate Python sidecar; B = keep status quo)

Pros / cons:
A) Replace Chroma with Rust vector search (recommended)
  ✅ Single Python sidecar to package (llama-server only)
  ✅ meilisearch is single binary, no Python dependency
  ✅ Startup ordering problem disappears (one sidecar)
  ❌ Semantic search quality needs evaluation (meilisearch vs Chroma)
  ❌ Migration effort to swap vector engine
B) Keep both Chroma + llama-server sidecars
  ✅ No migration work
  ✅ Chroma's semantic search is proven
  ❌ Python sidecar packaging risk — we know this bites us
  ❌ Startup ordering complexity

Net: Option A trades one semantic search engine for zero Python packaging risk. Given the user's explicit prior experience with Python sidecar failure, this is the clear choice.

---

### Decision 2: FTS Fallback as First-Class Feature, Not "Emergency Fallback"

**D2 — Design App to Work Without Vector Search**
Project/branch/task: Material-Learning master — ensure app ships with usable search even if vector engine fails
ELI10: The design says Chroma "降级为纯元数据检索（FTS fallback）" but treats this as an emergency mode when memory is low. We should instead design FTS as the primary search path, with vector search as an enhancement. This way the app always works, even if the vector engine crashes.
Stakes if we pick wrong: If vector search is "required" and it fails to start, the user has no search at all. If we design FTS as first-class, they always have working search and vector is a bonus.
Recommendation: **A** — make FTS the baseline search, vector search the enhancement. Simplifies startup contract and makes the app more resilient.
Completeness: A=8/10, B=4/10

Pros / cons:
A) FTS as primary, vector as enhancement (recommended)
  ✅ App ships with working search on day 1
  ✅ No hard dependency on vector sidecar startup
  ✅ Simpler error handling (no fallback logic needed)
  ❌ Keyword search vs semantic search quality gap
B) Vector search required, FTS as fallback
  ✅ Semantic search is the product differentiator
  ❌ If vector sidecar fails, user gets degraded experience
  ❌ More complex startup sequence (must try vector, then fallback)

Net: App resilience over feature completeness for MVP.

---

## Recommended Implementation Order

1. **Phase 1 (MVP):** SQLite FTS as primary search, llama-server as only sidecar. App works fully without vector search.
2. **Phase 2:** Add meilisearch/tantivy as enhancement layer on top of FTS. Vector search becomes opt-in.
3. **Phase 3:** If/when FFI llama.cpp is ready, merge llama-server into main process.

This reduces sidecar count from 2 → 1 in Phase 1, eliminates startup ordering problem, and ensures the app ships with working search regardless of sidecar startup.

---

## Failure Modes

| Failure Mode | Likelihood | User Impact | Detection | Recovery |
|---|---|---|---|---|
| llama-server fails to start | High (packaging) | Blank window / no AI | Health check on startup | Show error, disable local AI only |
| Chroma fails to start (if kept) | High (packaging) | No vector search | Health check | Fallback to FTS |
| Port conflict between sidecars | Medium | Startup failure | Port scan before bind | Retry with different port |
| Memory exhaustion | High (16GB) | Slow / crash | Runtime memory monitor | Trigger FTS fallback, reduce context size |
| Model file not found | Medium | "Cannot load model" error | File existence check on startup | Clear error message with path |
| Chroma data corruption | Low | "向量库损坏" | Startup integrity check | Offer to reset Chroma DB |

---

## NEXT STEPS

Run `/plan-eng-review` again after:
1. Decision 1 is resolved (Chroma replacement decision)
2. A revised design doc is produced incorporating the decision
3. Startup sequence and health check protocol are defined

---

*Review produced by /plan-eng-review on 2026-05-09*