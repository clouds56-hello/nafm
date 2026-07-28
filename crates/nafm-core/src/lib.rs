mod credentials;
mod error;
mod hash;
mod model;
mod repository;
mod workspace;

pub use credentials::{CredentialStore, SavedSmbCredential, SmbCredential, SmbLocation, verify_smb_connection};
pub use error::{NafmError, Result};
pub use hash::{Blake3HashAlgorithm, ContentHasher, HashAlgorithm, default_hash_algorithm};
pub use model::{
  AddSiteFolderRequest, DuplicateFile, DuplicateGroup, HiddenPolicy, MissingContentGroup, ScanProgress, ScanSummary,
  Site, SiteFolder, SiteFolderKind, StageAddReport, StageCommitDryRun, StageHistoryReport, StageRemoveReport,
  StageResetReport, StageWarning, StageWarningReason,
};
pub use repository::{Repository, RepositoryOptions};
pub use workspace::{DEFAULT_WORKSPACE_NAME, WorkspaceInfo, WorkspaceManager, app_root_dir, normalize_workspace_name};
