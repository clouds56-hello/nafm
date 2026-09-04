mod credentials;
mod error;
mod hash;
mod installer;
mod model;
mod onboarding;
mod remote;
mod repository;
mod ssh;
mod workspace;

pub use credentials::{CredentialStore, SavedSmbCredential, SmbCredential, SmbLocation, verify_smb_connection};
pub use error::{NafmError, Result};
pub use hash::{Blake3HashAlgorithm, ContentHasher, HashAlgorithm, default_hash_algorithm};
pub use installer::AgentInstallation;
pub use model::{
  AddSiteFolderRequest, DuplicateFile, DuplicateGroup, FileContentMatch, FileContentMatchStatus,
  FileContentMatchesPage, HiddenPolicy, MissingContentGroup, RemoteMachine, RemotePathMapping, ScanEvent, ScanPhase,
  ScanProgress, ScanStarted, ScanSummary, Site, SiteFolder, SiteFolderKind, SiteHashStatus, SiteOverview,
  StageAddReport, StageCommitDryRun, StageHistoryReport, StageRemoveReport, StageResetReport, StageWarning,
  StageWarningReason, StorageChildrenPage, StorageFileReveal, StorageLocation, StorageNode, StorageNodeKind,
  StorageTree, StorageViewSnapshot,
};
pub use onboarding::{CheckStatus, MappingPreview, PreflightReport, SetupCheck};
pub use remote::{REMOTE_AGENT_PROTOCOL_VERSION, RemoteAgentRequest, RemoteAgentResponse, RemoteFileMetadata};
pub use repository::{Repository, RepositoryOptions};
pub use ssh::{SshConnection, SshConnector, set_ssh_connector, system_ssh_command};
pub use workspace::{DEFAULT_WORKSPACE_NAME, WorkspaceInfo, WorkspaceManager, app_root_dir, normalize_workspace_name};
