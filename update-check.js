function normalizeVersion(value) {
  return String(value || '').replace(/^wallet-v/, '').replace(/^v/, '').trim();
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function selectLatestRelease(releases) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => (
      release &&
      /^v\d+\.\d+\.\d+$/.test(String(release.tag_name || '')) &&
      !release.draft &&
      !release.prerelease &&
      /^https:\/\/github\.com\/OBitsPlease\/ETH-II-Wallet-V2\/releases\/tag\/v\d+\.\d+\.\d+$/.test(String(release.html_url || ''))
    ))
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name))[0] || null;
}

module.exports = { compareVersions, normalizeVersion, selectLatestRelease };