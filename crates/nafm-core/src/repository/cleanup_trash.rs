use std::io;
use std::path::Path;

use crate::Result;

pub(super) fn move_file_to_trash(path: &Path) -> Result<()> {
  if !path.is_absolute() || !path.symlink_metadata()?.is_file() || path.canonicalize()? != path {
    return Err(unavailable("Only regular local files can be moved to Trash.").into());
  }
  if is_system_trash_path(path) {
    return Err(unavailable("The file is already in a Trash directory.").into());
  }
  trash_file(path).map_err(Into::into)
}

fn unavailable(detail: &str) -> io::Error {
  io::Error::new(io::ErrorKind::Unsupported, detail)
}

#[cfg(target_os = "macos")]
fn mac_volume(path: &Path) -> io::Result<libc::statfs> {
  use std::ffi::CString;
  use std::mem::MaybeUninit;
  use std::os::unix::ffi::OsStrExt;

  let native_path = CString::new(path.as_os_str().as_bytes())?;
  let mut volume = MaybeUninit::<libc::statfs>::uninit();
  // statfs initializes the buffer on success.
  if unsafe { libc::statfs(native_path.as_ptr(), volume.as_mut_ptr()) } != 0 {
    return Err(io::Error::last_os_error());
  }
  Ok(unsafe { volume.assume_init() })
}

#[cfg(target_os = "macos")]
fn trash_file(path: &Path) -> io::Result<()> {
  use trash::macos::{DeleteMethod, TrashContextExtMacos};

  let volume = mac_volume(path)?;
  if volume.f_flags & libc::MNT_LOCAL as u32 == 0 {
    return Err(unavailable("Trash is unavailable for this network volume."));
  }

  let mut context = trash::TrashContext::new();
  // This uses NSFileManager's trashItemAtURL and never asks Finder to delete the file.
  context.set_delete_method(DeleteMethod::NsFileManager);
  context.delete(path).map_err(io::Error::other)
}

#[cfg(target_os = "macos")]
pub(super) fn is_system_trash_path(path: &Path) -> bool {
  use std::ffi::{CStr, OsStr};
  use std::os::unix::ffi::OsStrExt;

  path
    .ancestors()
    .any(|ancestor| match ancestor.file_name().and_then(OsStr::to_str) {
      Some(".Trash") => directories::BaseDirs::new().is_some_and(|dirs| {
        let trash = dirs.home_dir().join(".Trash");
        ancestor == trash || trash.canonicalize().is_ok_and(|canonical| ancestor == canonical)
      }),
      Some(".Trashes") => ancestor.parent().is_some_and(|parent| {
        mac_volume(parent).is_ok_and(|volume| {
          // A successful statfs supplies a NUL-terminated mount point.
          let root = unsafe { CStr::from_ptr(volume.f_mntonname.as_ptr()) };
          let root = Path::new(OsStr::from_bytes(root.to_bytes()));
          volume.f_flags & libc::MNT_LOCAL as u32 != 0 && parent == root
        })
      }),
      _ => false,
    })
}

#[cfg(windows)]
pub(super) fn windows_file_identity(file: &std::fs::File) -> io::Result<(u64, u128, i64)> {
  use std::mem::size_of_val;
  use std::os::windows::io::AsRawHandle;
  use windows::Win32::Foundation::HANDLE;
  use windows::Win32::Storage::FileSystem::{
    FILE_BASIC_INFO, FILE_ID_INFO, FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx,
  };

  let handle = HANDLE(file.as_raw_handle());
  let mut id = FILE_ID_INFO::default();
  let mut basic = FILE_BASIC_INFO::default();
  // Both buffers match the information class and remain valid throughout the call.
  unsafe {
    GetFileInformationByHandleEx(handle, FileIdInfo, (&raw mut id).cast(), size_of_val(&id) as u32).and_then(|()| {
      GetFileInformationByHandleEx(
        handle,
        FileBasicInfo,
        (&raw mut basic).cast(),
        size_of_val(&basic) as u32,
      )
    })
  }
  .map_err(io::Error::other)?;
  Ok((
    id.VolumeSerialNumber,
    u128::from_le_bytes(id.FileId.Identifier),
    basic.ChangeTime,
  ))
}

#[cfg(windows)]
fn windows_volume_root(path: &Path) -> io::Result<std::path::PathBuf> {
  use std::ffi::OsString;
  use std::os::windows::ffi::{OsStrExt, OsStringExt};
  use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
  use windows::core::PCWSTR;

  let path = path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
  let mut volume = vec![0; 32_768];
  // GetVolumePathNameW identifies actual volumes even when mounted inside another drive.
  unsafe { GetVolumePathNameW(PCWSTR(path.as_ptr()), &mut volume) }.map_err(io::Error::other)?;
  let length = volume.iter().position(|value| *value == 0).unwrap_or(volume.len());
  Ok(OsString::from_wide(&volume[..length]).into())
}

#[cfg(windows)]
pub(super) fn is_system_trash_path(path: &Path) -> bool {
  path.ancestors().any(|ancestor| {
    ancestor
      .file_name()
      .and_then(|name| name.to_str())
      .is_some_and(|name| name.eq_ignore_ascii_case("$Recycle.Bin"))
      && ancestor.parent().is_some_and(|parent| {
        windows_volume_root(parent)
          .is_ok_and(|root| parent == root || root.canonicalize().is_ok_and(|canonical| parent == canonical))
      })
  })
}

#[cfg(windows)]
fn trash_file(path: &Path) -> io::Result<()> {
  recycle_windows_item(path, |_| Ok(()))
}

#[cfg(windows)]
fn recycle_windows_item(
  path: &Path,
  inspect: impl FnOnce(&windows::Win32::UI::Shell::IShellItem) -> io::Result<()>,
) -> io::Result<()> {
  use std::ffi::OsString;
  use std::os::windows::ffi::{OsStrExt, OsStringExt};
  use std::os::windows::fs::MetadataExt;
  use std::path::{Component, Prefix};
  use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_REPARSE_POINT, GetDriveTypeW};
  use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoTaskMemFree, CoUninitialize,
  };
  use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;
  use windows::Win32::UI::Shell::{
    BHID_Transfer, FOLDERID_RecycleBinFolder, IShellItem, ITransferSource, KF_FLAG_DEFAULT,
    SHCreateItemFromParsingName, SHGetKnownFolderItem, SIGDN_FILESYSPATH, TSF_NORMAL,
  };
  use windows::core::PCWSTR;

  let parent = path
    .parent()
    .ok_or_else(|| unavailable("The file has no parent directory."))?
    .canonicalize()?;
  let canonical = parent.join(path.file_name().ok_or_else(|| unavailable("The file has no name."))?);
  let metadata = canonical.symlink_metadata()?;
  if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
    return Err(unavailable(
      "The Recycle Bin action does not follow links or reparse points.",
    ));
  }
  let Some(Component::Prefix(prefix)) = canonical.components().next() else {
    return Err(unavailable("The file is not on a local Windows drive."));
  };
  if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
    return Err(unavailable("The file is not on a local Windows drive."));
  }
  let full_path = canonical.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
  let volume = windows_volume_root(&canonical)?
    .as_os_str()
    .encode_wide()
    .chain([0])
    .collect::<Vec<_>>();
  if unsafe { GetDriveTypeW(PCWSTR(volume.as_ptr())) } != DRIVE_FIXED {
    return Err(unavailable(
      "The Recycle Bin is available only for files on local fixed drives.",
    ));
  }

  struct ComApartment;
  impl Drop for ComApartment {
    fn drop(&mut self) {
      // Balance a successful CoInitializeEx on this thread after the Shell objects are released.
      unsafe { CoUninitialize() };
    }
  }
  unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
    .ok()
    .map_err(io::Error::other)?;
  let _apartment = ComApartment;

  // The Shell parser expects the drive-letter path without the extended-length prefix.
  let extended_prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
  let shell_path = full_path.strip_prefix(&extended_prefix).unwrap_or(&full_path);
  // Request recycling directly. Unlike DeleteItem, this API has no permanent-delete mode.
  (|| unsafe {
    let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(shell_path.as_ptr()), None).map_err(io::Error::other)?;
    let display_path = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(io::Error::other)?;
    let resolved = OsString::from_wide(display_path.as_wide());
    CoTaskMemFree(Some(display_path.0.cast()));
    if Path::new(&resolved).canonicalize()? != canonical {
      return Err(unavailable("The Recycle Bin could not resolve the exact source path."));
    }
    let source: ITransferSource = item
      .GetParent()
      .and_then(|parent| parent.BindToHandler(None, &BHID_Transfer))
      .map_err(io::Error::other)?;
    let bin: IShellItem =
      SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None).map_err(io::Error::other)?;
    let recycled = source
      .RecycleItem(&item, &bin, TSF_NORMAL.0 as u32)
      .map_err(io::Error::other)?;
    inspect(&recycled)
  })()
}

#[cfg(all(test, windows))]
#[test]
#[ignore = "moves a synthetic fixture to the Windows system Recycle Bin"]
fn windows_recycles_synthetic_fixture() {
  use std::ffi::OsString;
  use std::os::windows::ffi::OsStringExt;
  use windows::Win32::System::Com::CoTaskMemFree;
  use windows::Win32::UI::Shell::SIGDN_NORMALDISPLAY;

  let fixture = tempfile::tempdir().unwrap();
  let name = format!("NAFM-Recycle-Fixture-{}", uuid::Uuid::new_v4().simple());
  let original = fixture.path().join(&name);
  std::fs::write(&original, b"synthetic NAFM Recycle Bin test").unwrap();
  let original = original.canonicalize().unwrap();
  recycle_windows_item(&original, |recycled| {
    // The returned Shell item must be the newly recycled fixture.
    let recycled_name = unsafe { recycled.GetDisplayName(SIGDN_NORMALDISPLAY) }.map_err(io::Error::other)?;
    let display_name = unsafe { OsString::from_wide(recycled_name.as_wide()) };
    unsafe { CoTaskMemFree(Some(recycled_name.0.cast())) };
    assert_eq!(display_name, name.as_str());
    Ok(())
  })
  .unwrap();
  assert!(!original.exists());
}

#[cfg(target_os = "linux")]
pub(super) fn is_system_trash_path(path: &Path) -> bool {
  linux::is_system_trash_path(path, || {
    directories::BaseDirs::new().map(|dirs| dirs.data_dir().to_path_buf())
  })
}

#[cfg(target_os = "linux")]
use linux::trash_file;

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn trash_file(_path: &Path) -> io::Result<()> {
  Err(unavailable("This platform does not provide a supported Trash."))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(super) fn is_system_trash_path(_path: &Path) -> bool {
  false
}

#[cfg(target_os = "linux")]
mod linux {
  use super::{Path, io, unavailable};
  use chrono::Local;
  use directories::BaseDirs;
  use percent_encoding::{AsciiSet, CONTROLS, percent_encode};
  use rustix::fd::{AsFd, OwnedFd};
  use rustix::fs::{
    AtFlags, CWD, FileType, Mode, OFlags, RenameFlags, StatxFlags, fstat, fsync, mkdirat, openat, renameat_with,
    statat, statx, unlinkat,
  };
  use rustix::io::Errno;
  use rustix::process::getuid;
  use std::ffi::{OsStr, OsString};
  use std::fs::{self, File};
  use std::io::Write;
  use std::os::unix::ffi::{OsStrExt, OsStringExt};
  use std::path::PathBuf;
  use uuid::Uuid;

  const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
  const URI_PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']');

  pub(super) fn is_system_trash_path(path: &Path, data_dir: impl Fn() -> Option<PathBuf>) -> bool {
    path
      .ancestors()
      .any(|ancestor| match ancestor.file_name().and_then(OsStr::to_str) {
        Some("Trash") => data_dir().is_some_and(|data| {
          let trash = data.join("Trash");
          ancestor == trash || trash.canonicalize().is_ok_and(|canonical| ancestor == canonical)
        }),
        Some(name) if is_volume_trash_name(name) => ancestor.parent().is_some_and(|parent| {
          mount_id(CWD, parent, AtFlags::empty())
            .and_then(local_mount)
            .is_ok_and(|mount| parent == mount)
        }),
        _ => false,
      })
  }

  fn is_volume_trash_name(name: &str) -> bool {
    name == ".Trash"
      || name
        .strip_prefix(".Trash-")
        .is_some_and(|uid| !uid.is_empty() && uid.bytes().all(|byte| byte.is_ascii_digit()))
  }

  pub(super) fn trash_file(path: &Path) -> io::Result<()> {
    let parent = path
      .parent()
      .ok_or_else(|| unavailable("The file has no parent directory."))?
      .canonicalize()?;
    let parent_fd = openat(CWD, &parent, DIRECTORY_FLAGS, Mode::empty())?;
    let name = path.file_name().ok_or_else(|| unavailable("The file has no name."))?;
    let metadata = statat(&parent_fd, name, AtFlags::SYMLINK_NOFOLLOW)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
      return Err(unavailable("Only regular local files can be moved to Trash."));
    }
    let source = parent.join(name);
    let mount_id = mount_id(&parent_fd, "", AtFlags::EMPTY_PATH)?;
    let mount = local_mount(mount_id)?;
    let uid = getuid().as_raw();
    let user_trash_name = format!(".Trash-{uid}");

    let base_dirs = BaseDirs::new().ok_or_else(|| unavailable("The home Trash location is unavailable."))?;
    let data = base_dirs.data_dir();
    let (trash, original) = if existing_mount_id(data)? == mount_id {
      fs::create_dir_all(data)?;
      let data_fd = openat(CWD, data, DIRECTORY_FLAGS, Mode::empty())?;
      (private_dir(&data_fd, "Trash", uid)?, source.as_path())
    } else {
      let root = openat(CWD, &mount, DIRECTORY_FLAGS, Mode::empty())?;
      let user_dir = openat(&root, ".Trash", DIRECTORY_FLAGS, Mode::empty())
        .ok()
        .filter(|directory| fstat(directory).is_ok_and(|metadata| metadata.st_mode & 0o1000 != 0))
        .and_then(|directory| private_dir(&directory, uid.to_string(), uid).ok());
      let trash = match user_dir {
        Some(directory) => directory,
        None => private_dir(&root, &user_trash_name, uid)?,
      };
      let original = source.strip_prefix(&mount).map_err(io::Error::other)?;
      (trash, original)
    };
    let info = private_dir(&trash, "info", uid)?;
    let files = private_dir(&trash, "files", uid)?;
    create_entry(&parent_fd, name, &info, &files, original)
  }

  fn private_dir(parent: impl AsFd, name: impl AsRef<OsStr>, uid: u32) -> io::Result<OwnedFd> {
    let name = name.as_ref();
    match mkdirat(&parent, name, Mode::from_raw_mode(0o700)) {
      Ok(()) | Err(Errno::EXIST) => (),
      Err(error) => return Err(error.into()),
    }
    let directory = openat(&parent, name, DIRECTORY_FLAGS, Mode::empty())?;
    let metadata = fstat(&directory)?;
    if metadata.st_uid != uid || metadata.st_mode & 0o077 != 0 {
      return Err(unavailable("The Trash directory is not securely owned by this user."));
    }
    Ok(directory)
  }

  fn create_entry(
    parent: impl AsFd,
    name: &OsStr,
    info: impl AsFd,
    files: impl AsFd,
    original: &Path,
  ) -> io::Result<()> {
    // The info file is reserved atomically before moving the payload, as required by the specification.
    let key = Uuid::new_v4().simple().to_string();
    let info_name = format!("{key}.trashinfo");
    let mut entry = File::from(openat(
      &info,
      &info_name,
      OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
      Mode::from_raw_mode(0o600),
    )?);
    let result = (|| {
      writeln!(entry, "[Trash Info]")?;
      writeln!(
        entry,
        "Path={}",
        percent_encode(original.as_os_str().as_bytes(), URI_PATH)
      )?;
      writeln!(entry, "DeletionDate={}", Local::now().format("%Y-%m-%dT%H:%M:%S"))?;
      entry.sync_all()?;
      fsync(&info)?;
      // Report an error if an atomic move is unsupported, including across device or mount boundaries.
      renameat_with(parent, name, files, key, RenameFlags::NOREPLACE)?;
      Ok(())
    })();
    if result.is_err() {
      let _ = unlinkat(info, info_name, AtFlags::empty());
    }
    result
  }

  fn existing_mount_id(path: &Path) -> io::Result<u64> {
    for directory in path.ancestors() {
      match mount_id(CWD, directory, AtFlags::empty()) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
        result => return result,
      }
    }
    Err(unavailable("The home Trash volume could not be identified."))
  }

  fn mount_id(directory: impl AsFd, path: impl rustix::path::Arg, flags: AtFlags) -> io::Result<u64> {
    let metadata = statx(directory, path, flags, StatxFlags::MNT_ID)?;
    if metadata.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
      return Err(unavailable("The filesystem mount could not be identified."));
    }
    Ok(metadata.stx_mnt_id)
  }

  fn local_mount(mount_id: u64) -> io::Result<PathBuf> {
    let mounts = fs::read("/proc/self/mountinfo")?;
    for line in mounts.split(|byte| *byte == b'\n') {
      let mut fields = line.split(|byte| *byte == b' ');
      let id = fields
        .next()
        .and_then(|id| std::str::from_utf8(id).ok())
        .and_then(|id| id.parse().ok());
      if id != Some(mount_id) {
        continue;
      }
      let encoded = fields
        .nth(3)
        .ok_or_else(|| unavailable("The mounted volume could not be identified."))?;
      let filesystem = fields.skip_while(|field| *field != b"-").nth(1);
      if !matches!(
        filesystem,
        Some(
          b"ext2"
            | b"ext3"
            | b"ext4"
            | b"btrfs"
            | b"xfs"
            | b"zfs"
            | b"f2fs"
            | b"bcachefs"
            | b"ntfs3"
            | b"vfat"
            | b"exfat"
            | b"hfsplus"
            | b"tmpfs"
            | b"overlay"
        )
      ) {
        return Err(unavailable(
          "Trash is unavailable for this network or unsupported filesystem.",
        ));
      }
      return decode_mount_path(encoded).map(PathBuf::from);
    }
    Err(unavailable("The mounted volume could not be identified."))
  }

  fn decode_mount_path(mut encoded: &[u8]) -> io::Result<OsString> {
    // /proc/self/mountinfo escapes space, tab, newline and backslash with octal bytes.
    let mut decoded = Vec::with_capacity(encoded.len());
    while let Some((&byte, remaining)) = encoded.split_first() {
      if byte == b'\\' {
        let [
          first @ b'0'..=b'3',
          second @ b'0'..=b'7',
          third @ b'0'..=b'7',
          rest @ ..,
        ] = remaining
        else {
          return Err(unavailable("The mounted volume path could not be decoded."));
        };
        decoded.push((first - b'0') * 64 + (second - b'0') * 8 + (third - b'0'));
        encoded = rest;
      } else {
        decoded.push(byte);
        encoded = remaining;
      }
    }
    Ok(OsString::from_vec(decoded))
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn trash_entry_moves_payload_and_preserves_raw_original_path() {
      let fixture = tempfile::tempdir().unwrap();
      let root = openat(CWD, fixture.path(), DIRECTORY_FLAGS, Mode::empty()).unwrap();
      let info = private_dir(&root, "info", getuid().as_raw()).unwrap();
      let files = private_dir(&root, "files", getuid().as_raw()).unwrap();
      let name = OsStr::from_bytes(b"notes %\xff.txt");
      let source = fixture.path().join(name);
      fs::write(&source, b"test payload").unwrap();

      create_entry(&root, name, &info, &files, &source).unwrap();
      assert!(!source.exists());
      let payload = fs::read_dir(fixture.path().join("files"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
      assert_eq!(fs::read(payload.path()).unwrap(), b"test payload");
      let receipt = fixture
        .path()
        .join("info")
        .join(payload.file_name())
        .with_extension("trashinfo");
      let receipt = fs::read_to_string(receipt).unwrap();
      assert!(receipt.starts_with("[Trash Info]\nPath=/"));
      assert!(receipt.contains("/notes%20%25%FF.txt\nDeletionDate="));
    }

    #[test]
    fn trash_mount_path_decodes_kernel_escapes() {
      let path = decode_mount_path(br"/media/Backup\040disk\134archive").unwrap();
      assert_eq!(path, OsStr::new(r"/media/Backup disk\archive"));
      assert!(decode_mount_path(br"/media/invalid\099").is_err());
    }

    #[test]
    fn trash_paths_match_system_storage_without_hiding_ordinary_folder_names() {
      let fixture = tempfile::tempdir().unwrap();
      let data = fixture.path().join("xdg data");
      assert!(is_system_trash_path(&data.join("Trash/files/copy"), || Some(
        data.clone()
      )));
      assert!(is_system_trash_path(&data.join("Trash"), || Some(data.clone())));
      assert!(!is_system_trash_path(
        &fixture.path().join("Trash/files/copy"),
        || Some(data.clone())
      ));
      assert!(!is_system_trash_path(&fixture.path().join(".Trash/files/copy"), || {
        None
      }));
      assert!(!is_system_trash_path(
        &fixture.path().join(".Trash-1000/files/copy"),
        || None
      ));

      let mount = mount_id(CWD, fixture.path(), AtFlags::empty())
        .and_then(local_mount)
        .unwrap();
      assert!(is_system_trash_path(&mount.join(".Trash/1000/files/copy"), || None));
      assert!(is_system_trash_path(&mount.join(".Trash-1000/info"), || None));
      assert!(!is_system_trash_path(&mount.join(".Trash-photos"), || None));
    }
  }
}
