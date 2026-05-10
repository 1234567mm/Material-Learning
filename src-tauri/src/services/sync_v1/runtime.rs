//! 同步 backend 用的"async → sync 桥接"工具
//!
//! `SyncBackendImpl` trait 故意是同步阻塞接口（参 `backend.rs` 注释）。
//! WebDAV / S3 客户端是 async，需要在 trait impl 内部把 future 同步阻塞执行。
//!
//! 使用 `OnceLock + 独立 multi-thread Runtime` 模式 —— 不依赖调用方在哪个 runtime 里。
//! 这样 sync Tauri Command / async Tauri Command 都能稳定调用。

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::Runtime;

fn sync_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("sync-v1-rt")
            .build()
            .expect("failed to build sync_v1 runtime")
    })
}

/// 把 async 函数同步阻塞执行
///
/// 不会 panic 即便父调用栈本身已经在 tokio runtime —— 我们用的是独立 runtime
/// （注：只要不在父 runtime 同一个 worker thread 上，就不会 deadlock；
/// 这里独立 runtime 保证了在它自己的 worker thread 上跑）
pub fn block_on<F: Future>(f: F) -> F::Output {
    sync_runtime().block_on(f)
}
