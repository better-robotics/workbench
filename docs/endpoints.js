// GitHub repo behind this Pages site — derived from location (org project
// pages serve at <owner>.github.io/<repo>/) so a repo rename can't strand
// links. The literal is only the local-dev fallback; the canonical URL
// lives in the repo's About (homepage) field.
export const REPO_URL = (() => {
  const owner = location.hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
  const repo  = location.pathname.split("/").filter(Boolean)[0];
  return owner && repo ? `https://github.com/${owner}/${repo}`
                       : "https://github.com/sprocket-robotics/workbench";
})();
