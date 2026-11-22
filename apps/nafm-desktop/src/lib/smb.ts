export function parseSmbLocation(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SMB URL. Use smb://server/share.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "smb:" || !url.hostname || !segments.length) {
    throw new Error("Invalid SMB URL. Use smb://server/share.");
  }
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("SMB URLs cannot include credentials, a query, or a fragment.");
  }

  const [share, ...folders] = segments.map((segment) => {
    const decoded = decodeURIComponent(segment.replace(/%(?![\da-f]{2})/gi, "%25"));
    if (decoded.includes("/") || decoded.includes("\\")) throw new Error("Invalid SMB path segment.");
    return decoded;
  });
  url.hostname = url.hostname.toLowerCase();
  url.pathname = "/" + segments.join("/");
  return {
    normalized_url: url.href, server: url.hostname, port: url.port || "445",
    share: share.replace(/[A-Z]/g, (letter) => letter.toLowerCase()), folders,
  };
}

export function smbRootContains(rootUrl: string, location: ReturnType<typeof parseSmbLocation>) {
  try {
    const root = parseSmbLocation(rootUrl);
    return root.server === location.server && root.port === location.port && root.share === location.share
      && root.folders.every((folder, index) => folder === location.folders[index]);
  } catch {
    // A malformed stored root cannot grant access to the requested share.
    return false;
  }
}
