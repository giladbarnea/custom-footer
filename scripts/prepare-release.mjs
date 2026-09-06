import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageMetadata.name)}/latest`);
if (!response.ok && response.status !== 404) {
  throw new Error(`Cannot read npm release: HTTP ${response.status}`);
}
const publishedVersion = response.ok ? (await response.json()).version : undefined;
let version = packageMetadata.version;
if (publishedVersion === version) {
  execFileSync("npm", ["version", "patch", "-m", "Release %s [skip ci]"], { stdio: "inherit" });
  version = JSON.parse(readFileSync("package.json", "utf8")).version;
} else {
  const nextVersion = publishedVersion?.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  if (publishedVersion !== undefined && version !== nextVersion) {
    throw new Error(`Expected repository version ${publishedVersion} or ${nextVersion}, found ${version}`);
  }
  const existingTag = execFileSync("git", ["tag", "--list", `v${version}`], { encoding: "utf8" }).trim();
  if (!existingTag) execFileSync("git", ["tag", "-a", `v${version}`, "-m", `Release ${version}`]);
}
execFileSync("git", ["push", "origin", "HEAD:main", "--follow-tags"], { stdio: "inherit" });
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
