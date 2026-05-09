# Llama.cpp Integration: Modular Rust Interface Design

**Document Version:** 1.0
**Date:** 2026-05-08
**Hardware Context:** Intel i5-13500H + 16GB RAM

---

## Overview

This document defines the safe Rust interface for llama.cpp integration. The design emphasizes:

- **Ownership clarity**: Each resource has a distinct handle type preventing misuse
- **Lifetime safety**: Contexts are bound to their parent model
- **Thread safety**: Send+Sync where applicable, mutex-protected shared state
- **Error transparency**: No exceptions, explicit Result types with typed errors

---

## Error Types

```rust
/// Unified error enum for all llama.cpp operations
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlamaError {
    // Model errors
    ModelNotFound(String),
    ModelLoadFailed { path: String, reason: String },
    ModelIncompatible { path: String, expected: String, found: String },
    GpuOffloadFailed(u32), // suggested gpu_layers

    // Context errors
    ContextCreationFailed { model: String, reason: String },
    ContextFull,
    ContextNotFound(u64), // session_id

    // Inference errors
    EncodeFailed(String),
    DecodeFailed(String),
    InvalidTokenBatch(String),

    // Download errors
    DownloadFailed { model_id: String, reason: String },
    NetworkError(String),
    DiskSpaceInsufficient { required: u64, available: u64 },

    // Hardware errors
    HardwareDetectionFailed(String),
    UnsupportedHardware(String),

    // General
    NullPointer,
    InvalidParameter(String),
    Cancelled,
}
```

---

## Module 1: ModelManager

Manages model lifecycle: loading, unloading, and metadata retrieval.

```rust
use std::path::PathBuf;
use std::sync::Arc;

/// Opaque handle to a loaded model
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModelHandle(u64);

/// Model metadata
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub path: PathBuf,
    pub quantization: String,           // e.g., "Q4_K", "Q5_K"
    pub parameter_count: u64,          // e.g., 1_000_000_000 for 1B
    pub vocabulary_size: u32,
    pub context_length: u32,           // native max context
    pub embedding_dim: u32,
    pub gpu_layers_optimized: u32,
    pub file_size_bytes: u64,
}

/// HuggingFace model listing
#[derive(Debug, Clone)]
pub struct ModelListing {
    pub model_id: String,              // e.g., "meta-llama/Llama-3.1-8B-Instruct-GGUF"
    pub name: String,
    pub size_bytes: u64,
    pub quantization: String,
    pub recommended_context: u32,
    pub description: String,
    pub sha256: Option<String>,
}

/// Progress callback for long-running operations
pub type ModelProgressCallback = Arc<dyn Fn(u32, &str) + Send + Sync>;

/// Model loading parameters
#[derive(Debug, Clone)]
pub struct ModelLoadParams {
    /// Number of layers to offload to GPU (0 = CPU only)
    pub n_gpu_layers: u32,
    /// Use fp16 memory type for KV cache
    pub use_fp16_kv: bool,
    /// Model context length override (0 = default)
    pub context_length: u32,
    /// Number of threads for evaluation (0 = auto)
    pub n_threads: u32,
    /// Number of threads for batch processing (0 = n_threads)
    pub n_threads_batch: u32,
    /// Lock model weights in memory (improves performance but prevents swapping)
    pub lock_memory: bool,
}

/// Default parameters for a typical desktop setup (i5-13500H + 16GB)
impl Default for ModelLoadParams {
    fn default() -> Self {
        Self {
            n_gpu_layers: 0,           // iGPU support would require CUDA/Metal
            use_fp16_kv: false,
            context_length: 0,
            n_threads: 6,              // P-cores for inference
            n_threads_batch: 8,        // total logical cores
            lock_memory: false,
        }
    }
}

pub trait ModelManager {
    /// Load a model from file with progress callback
    ///
    /// # Arguments
    /// * `path` - Path to GGUF model file
    /// * `params` - Loading parameters (see ModelLoadParams)
    /// * `progress` - Optional callback(percent, message) for progress updates
    ///
    /// # Returns
    /// * `Ok(ModelHandle)` - Handle for the loaded model
    ///
    /// # Errors
    /// * `ModelNotFound` - File does not exist
    /// * `ModelLoadFailed` - llama.cpp failed to load (corrupt file, OOM)
    /// * `GpuOffloadFailed` - Requested GPU layers not supported
    fn load_model(
        path: PathBuf,
        params: ModelLoadParams,
        progress: Option<ModelProgressCallback>,
    ) -> Result<ModelHandle, LlamaError>;

    /// Unload model and free all associated memory
    ///
    /// # Behavior
    /// - Invalidates all contexts created from this model
    /// - Triggers llama.cpp cleanup
    /// - Returns error if handle is invalid
    fn unload_model(&self, handle: ModelHandle) -> Result<(), LlamaError>;

    /// Get metadata for a loaded model
    fn get_model_info(&self, handle: ModelHandle) -> Result<ModelInfo, LlamaError>;

    /// List models available for download from HuggingFace
    ///
    /// # Arguments
    /// * `query` - Optional search filter (e.g., "llama 3B Q4")
    ///
    /// # Errors
    /// * `NetworkError` - Cannot reach HuggingFace
    async fn list_downloadable_models(
        &self,
        query: Option<&str>,
    ) -> Result<Vec<ModelListing>, LlamaError>;

    /// Check if a model is currently loaded
    fn is_loaded(&self, path: &PathBuf) -> bool;

    /// Hot-swap to a different model (if currently no active contexts)
    fn swap_model(&self, old: ModelHandle, new: ModelHandle) -> Result<(), LlamaError>;
}
```

**Thread Safety:** `ModelManager` itself is Send + Sync. Individual `ModelHandle` operations are serialized through an internal mutex.

---

## Module 2: InferenceEngine

Low-level inference operations. Contexts are bound to their parent model.

```rust
use std::path::PathBuf;

/// Opaque handle to an inference context
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContextHandle(u64);

/// Result from a single decode pass
#[derive(Debug, Clone)]
pub struct DecodeResult {
    pub logits: Vec<f32>,              // [vocab_size] logits for next token
    pub next_tokens: Vec<TokenId>,     // top-k candidates
    pub timing_ns: u64,                // decode wall time
    pub tokens_generated: u32,         // batch size actually processed
}

/// Single token representation
pub type TokenId = i32;

/// Token batch for encode/decode
#[derive(Debug, Clone)]
pub struct TokenBatch {
    pub tokens: Vec<TokenId>,
    pub positions: Vec<u32>,           // position ids [0, 1, ..., n]
    pub n_seq: u32,                    // number of sequences in batch
    pub seq_ids: Vec<u32>,             // which sequence each token belongs to
}

/// Inference parameters for context creation
#[derive(Debug, Clone)]
pub struct ContextParams {
    /// Context size (tokens). For 16GB RAM: 3B Q4_K supports 4096
    pub context_size: u32,
    /// Batch size for prompt processing (0 = context_size)
    pub batch_size: u32,
    /// Number of threads for computation
    pub n_threads: u32,
    /// Embedding layer output type
    pub embeddings_only: bool,         // true = extract embeddings, no generate
    /// Ragged batch support (variable sequence lengths)
    pub use_ragged_batch: bool,
}

/// Hardware-thread affinity hint
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThreadAffinity {
    pub cpu_mask: u64,     // bitmask of allowed cores (up to 64 cores)
    pub numa_node: Option<u32>,
}

pub trait InferenceEngine {
    /// Create a new inference context from a model
    ///
    /// # Arguments
    /// * `model` - Parent model handle
    /// * `params` - Context parameters
    ///
    /// # Returns
    /// * `Ok(ContextHandle)` - Handle for the created context
    ///
    /// # Errors
    /// * `ContextCreationFailed` - Out of memory or invalid params
    ///
    /// # Lifetime
    /// Context is invalid if parent model is unloaded
    fn create_context(
        &self,
        model: ModelHandle,
        params: ContextParams,
    ) -> Result<ContextHandle, LlamaError>;

    /// Free inference context
    fn destroy_context(&self, ctx: ContextHandle) -> Result<(), LlamaError>;

    /// Encode a batch of tokens (forward pass without sampling)
    ///
    /// # Arguments
    /// * `ctx` - Inference context
    /// * `batch` - Token batch to process
    ///
    /// # Returns
    /// * `Ok(DecodeResult)` - Logits and timing info
    ///
    /// # Errors
    /// * `EncodeFailed` - Invalid batch or context state
    fn encode(
        &self,
        ctx: ContextHandle,
        batch: TokenBatch,
    ) -> Result<DecodeResult, LlamaError>;

    /// Decode and sample next token (convenience wrapper)
    ///
    /// # Arguments
    /// * `ctx` - Inference context
    /// * `batch` - Input token batch
    ///
    /// # Returns
    /// * `Ok(DecodeResult)` - Logits and sampled tokens
    fn decode(
        &self,
        ctx: ContextHandle,
        batch: TokenBatch,
    ) -> Result<DecodeResult, LlamaError>;

    /// Tokenize text into token IDs
    ///
    /// # Arguments
    /// * `ctx` - Inference context (provides vocab)
    /// * `text` - Text to tokenize
    /// * `add_special` - Include special tokens (bos, eos, etc.)
    ///
    /// # Returns
    /// * `Ok(Vec<TokenId>)` - Token IDs
    fn tokenize(
        &self,
        ctx: ContextHandle,
        text: &str,
        add_special: bool,
    ) -> Result<Vec<TokenId>, LlamaError>;

    /// Detokenize token IDs into text
    ///
    /// # Arguments
    /// * `ctx` - Inference context (provides vocab)
    /// * `tokens` - Token IDs to decode
    ///
    /// # Returns
    /// * `Ok(String)` - Decoded text
    fn detokenize(
        &self,
        ctx: ContextHandle,
        tokens: &[TokenId],
    ) -> Result<String, LlamaError>;

    /// Get vocabulary size for context
    fn vocab_size(&self, ctx: ContextHandle) -> Result<u32, LlamaError>;

    /// Reset KV cache for context
    fn reset_kv_cache(&self, ctx: ContextHandle) -> Result<(), LlamaError>;
}
```

**Thread Safety:**
- `ContextHandle` is `Send + Sync` — contexts can be shared across threads
- Internal state is protected by mutex; concurrent calls are serialized per-context
- For parallel decode across contexts, use separate `ContextHandle` instances

---

## Module 3: ContextPool

Manages session state and KV cache persistence across inference calls.

```rust
use std::collections::HashMap;

/// Opaque session identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(u64);

/// Session state for save/restore
#[derive(Debug, Clone)]
pub struct SessionState {
    /// KV cache data (opaque to caller)
    pub kv_cache: Vec<u8>,
    /// Current sequence positions
    pub positions: Vec<u32>,
    /// Sampler state (temperature, seed, etc.)
    pub sampler_state: SamplerState,
    /// Session metadata
    pub metadata: HashMap<String, String>,
}

/// Sampler state snapshot
#[derive(Debug, Clone)]
pub struct SamplerState {
    pub last_token: TokenId,
    pub n_prev_tokens: u32,
    // implementation-specific continuation data
    pub data: Vec<u8>,
}

/// Session metadata
#[derive(Debug, Clone)]
pub struct Session {
    pub id: SessionId,
    pub context: ContextHandle,
    pub created_at: std::time::Instant,
    pub last_used: std::time::Instant,
    pub estimated_tokens: u32,
}

pub trait ContextPool {
    /// Acquire or create a session for the given context
    ///
    /// # Arguments
    /// * `ctx` - Inference context to create session for
    /// * `session_id` - Unique session identifier (user-provided)
    ///
    /// # Returns
    /// * `Ok(Session)` - Session handle with metadata
    ///
    /// # Errors
    /// * `ContextNotFound` - Context handle is invalid
    fn acquire_session(
        &self,
        ctx: ContextHandle,
        session_id: SessionId,
    ) -> Result<Session, LlamaError>;

    /// Release session (may recycle KV cache)
    ///
    /// # Behavior
    /// Session is removed from active pool; state may be kept for later restore
    fn release_session(&self, session: Session) -> Result<(), LlamaError>;

    /// Get current session state for saving
    ///
    /// # Returns
    /// * `Ok(SessionState)` - Encoded state (can be large for long contexts)
    fn get_session_state(&self, session: Session) -> Result<SessionState, LlamaError>;

    /// Restore session from saved state
    ///
    /// # Arguments
    /// * `session` - Target session
    /// * `state` - Previously saved state
    ///
    /// # Errors
    /// * `ContextNotFound` - Session invalid
    /// * `InvalidState` - State format mismatch
    fn restore_session(
        &self,
        session: Session,
        state: SessionState,
    ) -> Result<(), LlamaError>;

    /// List all active sessions
    fn list_sessions(&self) -> Vec<Session>;

    /// Evict oldest session to free memory
    fn evict_oldest(&self) -> Result<SessionId, LlamaError>;

    /// Get memory footprint of session's KV cache
    fn session_memory_usage(&self, session: Session) -> Result<u64, LlamaError>;
}
```

**Thread Safety:** `SessionId` is `Send + Sync`. Session operations on different sessions are independent and can proceed in parallel.

---

## Module 4: QuantizationSelector

Analyzes hardware and recommends optimal quantization format.

```rust
/// Hardware capability summary
#[derive(Debug, Clone, Default)]
pub struct HardwareProfile {
    pub cpu_brand: String,
    pub cpu_cores_physical: u32,
    pub cpu_cores_logical: u32,
    pub ram_bytes: u64,
    pub ram_available_bytes: u64,
    pub gpu_available: bool,
    pub gpu_memory_bytes: Option<u64>,
    pub gpu_name: Option<String>,
    // Future: numa_nodes, disk_speed, etc.
}

/// Quantization format info
#[derive(Debug, Clone)]
pub struct QuantizationInfo {
    pub name: String,                  // e.g., "Q4_K", "Q5_K", "F16"
    pub description: String,
    pub memory_per_param_bytes: f32,   // e.g., 0.5 for Q4_K
    pub quality_score: u32,            // relative quality (1-10)
    pub speed_score: u32,             // relative speed (1-10)
    pub recommended_for: Vec<String>, // e.g., ["desktop", "laptop"]
}

/// Quantization recommendation
#[derive(Debug, Clone)]
pub struct QuantizationConfig {
    pub format: String,               // e.g., "Q4_K"
    pub suggested_context: u32,        // safe context size
    pub n_gpu_layers: u32,            // recommended GPU offload
    pub memory_budget_mb: u32,        // target RAM usage
    pub rationale: String,            // why this format was chosen
}

/// Model compatibility check result
#[derive(Debug, Clone)]
pub struct CompatibilityResult {
    pub compatible: bool,
    pub issues: Vec<String>,          // e.g., "Insufficient RAM by 500MB"
    pub suggested_alternative: Option<String>,
}

pub trait QuantizationSelector {
    /// Recommend optimal quantization for the current hardware
    ///
    /// # Arguments
    /// * `hardware` - Hardware profile (from HardwareDetector)
    /// * `model_size_hint` - Optional model size hint (1B, 3B, 7B, etc.)
    ///
    /// # Returns
    /// * `Ok(QuantizationConfig)` - Recommended config
    fn recommend_for_hardware(
        &self,
        hardware: &HardwareProfile,
        model_size_hint: Option<u64>,
    ) -> Result<QuantizationConfig, LlamaError>;

    /// List all available quantization formats with metadata
    fn list_available_quantizations(&self) -> Vec<QuantizationInfo>;

    /// Check if a specific model file is compatible with desired quantization
    ///
    /// # Arguments
    /// * `model_path` - Path to model GGUF file
    /// * `quantization` - Desired quantization (e.g., "Q4_K")
    ///
    /// # Returns
    /// * `Ok(CompatibilityResult)` - Compatibility status
    fn validate_model_compatibility(
        &self,
        model_path: &PathBuf,
        quantization: &str,
    ) -> Result<CompatibilityResult, LlamaError>;

    /// Estimate memory required for a given model + context combination
    ///
    /// # Arguments
    /// * `model_path` - Path to model
    /// * `quantization` - Quantization format
    /// * `context_size` - Desired context size
    /// * `n_gpu_layers` - GPU layers to offload
    fn estimate_memory(
        &self,
        model_path: &PathBuf,
        quantization: &str,
        context_size: u32,
        n_gpu_layers: u32,
    ) -> Result<u64, LlamaError>;
}
```

**Static Data:** All `QuantizationInfo` data is static (compiled into the library) — no I/O required.

---

## Module 5: ModelDownloader

Downloads and caches models from HuggingFace Hub.

```rust
use std::path::PathBuf;

/// Download progress information
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub model_id: String,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,               // bytes per second
    pub eta_seconds: Option<u32>,
    pub current_file: String,
}

/// Download completion result
#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub model_id: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
}

/// Progress callback type
pub type DownloadProgressCallback = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

/// Cached model entry
#[derive(Debug, Clone)]
pub struct CachedModel {
    pub model_id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub last_used: std::time::SystemTime,
    pub download_date: std::time::SystemTime,
    pub quantization: String,
}

pub trait ModelDownloader {
    /// Download a model from HuggingFace
    ///
    /// # Arguments
    /// * `model_id` - HuggingFace model ID (e.g., "meta-llama/Llama-3.1-8B-Instruct-GGUF")
    /// * `quantization` - Specific quantization variant (e.g., "Q4_K")
    /// * `progress` - Optional progress callback
    ///
    /// # Returns
    /// * `Ok(DownloadResult)` - Local path and metadata
    ///
    /// # Errors
    /// * `DownloadFailed` - Network error, disk full, etc.
    /// * `ModelNotFound` - Model ID doesn't exist on HF
    async fn download_model(
        &self,
        model_id: &str,
        quantization: Option<&str>,
        progress: Option<DownloadProgressCallback>,
    ) -> Result<DownloadResult, LlamaError>;

    /// List all cached models
    fn list_cached_models(&self) -> Vec<CachedModel>;

    /// Delete a cached model
    ///
    /// # Arguments
    /// * `model_id` - Model ID to delete
    ///
    /// # Errors
    /// * `ModelNotFound` - Model not in cache
    fn delete_model(&self, model_id: &str) -> Result<(), LlamaError>;

    /// Get cache directory path
    fn cache_path(&self) -> PathBuf;

    /// Check if model is cached
    fn is_cached(&self, model_id: &str) -> bool;

    /// Get path of cached model (without downloading)
    fn get_cached_path(&self, model_id: &str) -> Option<PathBuf>;

    /// Cancel an in-progress download
    fn cancel_download(&self, model_id: &str) -> Result<(), LlamaError>;

    /// Verify cached model integrity (hash check)
    fn verify_integrity(&self, model_id: &str) -> Result<bool, LlamaError>;
}
```

**Thread Safety:** Download operations are async and share state through internal mutex. Multiple concurrent downloads are supported.

---

## Module 6: HardwareDetector

Detects and reports system hardware capabilities.

```rust
/// CPU information
#[derive(Debug, Clone)]
pub struct CpuInfo {
    pub brand: String,
    pub vendor: String,
    pub architecture: String,          // e.g., "x86_64", "arm64"
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub max_frequency_mhz: Option<u32>,
    pub has_avx2: bool,
    pub has_avx512: bool,
    pub has_fma: bool,
    pub supports_batch_dequant: bool, // can do mmp usage efficiently
}

/// RAM information
#[derive(Debug, Clone)]
pub struct RamInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub page_size_bytes: u64,
}

/// GPU information
#[derive(Debug, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,               // "NVIDIA", "AMD", "Intel", "Apple"
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub compute_units: u32,
    pub supports_cuda: bool,
    pub supports_hip: bool,
    pub supports_metal: bool,
    pub driver_version: Option<String>,
}

/// Memory budget suggestion
#[derive(Debug, Clone)]
pub enum MemoryBudget {
    /// Conservative: leaves headroom for OS
    Conservative(u64),
    /// Balanced: typical workload
    Balanced(u64),
    /// Aggressive: maximize model size
    Aggressive(u64),
}

/// Model capacity recommendation
#[derive(Debug, Clone)]
pub struct ModelCapacity {
    pub max_parameters: u64,         // e.g., 3_000_000_000 for 3B
    pub recommended_quantization: String,
    pub recommended_context: u32,
    pub memory_budget: MemoryBudget,
    pub warnings: Vec<String>,        // e.g., "RAM may be constrained for large contexts"
}

pub trait HardwareDetector {
    /// Detect CPU capabilities
    fn detect_cpu(&self) -> Result<CpuInfo, LlamaError>;

    /// Detect RAM availability
    fn detect_ram(&self) -> Result<RamInfo, LlamaError>;

    /// Detect GPU (if available)
    ///
    /// # Returns
    /// * `Ok(Some(GpuInfo))` - GPU found
    /// * `Ok(None)` - No GPU detected
    fn detect_gpu(&self) -> Result<Option<GpuInfo>, LlamaError>;

    /// Get combined hardware profile
    fn detect_hardware(&self) -> Result<HardwareProfile, LlamaError> {
        Ok(HardwareProfile {
            cpu_brand: self.detect_cpu()?.brand,
            cpu_cores_physical: self.detect_cpu()?.physical_cores,
            cpu_cores_logical: self.detect_cpu()?.logical_cores,
            ram_bytes: self.detect_ram()?.total_bytes,
            ram_available_bytes: self.detect_ram()?.available_bytes,
            gpu_available: self.detect_gpu()?.is_some(),
            gpu_memory_bytes: self.detect_gpu()?.map(|g| g.memory_total_bytes),
            gpu_name: self.detect_gpu()?.map(|g| g.name),
        })
    }

    /// Estimate optimal model capacity for detected hardware
    fn estimate_model_capacity(&self) -> Result<ModelCapacity, LlamaError>;

    /// Get recommended thread counts for inference
    fn recommended_threads(&self) -> Result<(u32, u32), LlamaError> {
        // Returns (n_threads, n_threads_batch)
        let cpu = self.detect_cpu()?;
        let cores = cpu.physical_cores;
        Ok((cores, cores + cpu.logical_cores - cores))
    }
}
```

**Thread Safety:** All detection methods are pure (no mutation) and can be called concurrently.

---

## Module Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application                              │
└─────────────────────────────────────────────────────────────────┘
            │            │            │            │
            ▼            ▼            ▼            ▼
    ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
    │  Model    │ │ Inference │ │  Context  │ │  Model    │
    │  Manager  │ │  Engine   │ │   Pool    │ │ Downloader│
    └───────────┘ └───────────┘ └───────────┘ └───────────┘
            │            │            │
            ▼            ▼            ▼
    ┌───────────┐ ┌───────────┐ ┌───────────┐
    │Quantization│ │ Hardware │
    │  Selector │ │ Detector │
    └───────────┘ └───────────┘
```

### Dependency Flow

- **ModelManager** owns `ModelHandle` and delegates to llama.cpp FFI
- **InferenceEngine** requires `ModelHandle` to create `ContextHandle`
- **ContextPool** manages `ContextHandle` lifetimes with session semantics
- **QuantizationSelector** uses **HardwareDetector** to recommend formats
- **ModelDownloader** feeds paths to **ModelManager**

---

## Lifetime and Ownership Summary

| Type | Handle Type | Ownership | Drop Behavior |
|------|-------------|-----------|----------------|
| Model | `ModelHandle` | Exclusive | Unload from llama.cpp |
| Context | `ContextHandle` | Bound to ModelHandle | Free context, keep model |
| Session | `SessionId` | Pool-managed | Recycle or evict |
| SessionState | `SessionState` | Owned by caller | Caller decides save/discard |

### Drop Order Guarantee

1. Contexts must be destroyed before their parent model
2. Sessions must be released before their context is destroyed
3. ModelManager coordinates drops to enforce this

---

## Trait Objects and Dynamic Dispatch

All traits use `dyn Trait` for FFI binding flexibility:

```rust
// Concrete implementation wraps llama.cpp C API
pub struct LlamaEngine {
    // internal: *mut llama_model, *mut llama_context, etc.
}

// User-facing trait object
pub type InferenceEngineHandle = Arc<dyn InferenceEngine + Send + Sync>;
```

Error handling is always explicit `Result<T, LlamaError>` — no unwrap() in library code.

---

## Async Considerations

Only **ModelDownloader** requires async (network I/O). All other modules are synchronous and blocking, matching llama.cpp's synchronous nature.

```rust
// Example: async model loading with progress
async fn load_model_async(
    manager: &dyn ModelManager,
    path: PathBuf,
) -> Result<ModelHandle, LlamaError> {
    // For now, download is separate from load
    // Future: could add async load with callback polling
    manager.load_model(path, Default::default(), None)
}
```

---

## Usage Example

```rust
// High-level workflow
async fn main() -> Result<(), LlamaError> {
    let detector = LlamaHardwareDetector::new();
    let hardware = detector.detect_hardware()?;

    let selector = LlamaQuantizationSelector::new();
    let config = selector.recommend_for_hardware(&hardware, Some(3_000_000_000))?;

    let downloader = LlamaModelDownloader::new();
    let model_path = downloader
        .download_model("meta-llama/Llama-3.1-3B-Instruct-GGUF", Some(&config.format), None)
        .await?;

    let manager = LlamaModelManager::new();
    let model = manager.load_model(model_path, Default::default(), None)?;

    let engine = LlamaInferenceEngine::new();
    let ctx = engine.create_context(model, Default::default())?;

    let tokens = engine.tokenize(ctx, "Hello world", true)?;
    let result = engine.decode(ctx, TokenBatch::from_tokens(&tokens))?;

    println!("Generated: {}", engine.detokenize(ctx, &result.next_tokens)?);
    Ok(())
}
```

---

## Summary

This interface design provides:

1. **Type-safe handles** — No raw pointers exposed to users
2. **Explicit error types** — Every failure mode is surfaced in Result
3. **Clear ownership** — Model → Context → Session hierarchy
4. **Async for network** — Only where needed (download)
5. **Sync for compute** — Matches llama.cpp's blocking model
6. **Hardware-aware** — QuantizationSelector + HardwareDetector work together

All functions include documentation comments specifying arguments, returns, and errors. Implementation details are hidden behind traits allowing different backends (FFI, mock, remote).