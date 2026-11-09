import { $ } from "bun";

const release = Bun.argv[2];

if (
  Bun.argv.length !== 3 ||
  (release !== "patch" && release !== "minor" && release !== "major")
) {
  console.error("Usage: bun run release <patch|minor|major>");
  process.exit(1);
}

const branch = (await $`git branch --show-current`.text()).trim();
if (branch !== "main") {
  console.error(`Releases must run from main (currently on ${branch || "a detached HEAD"}).`);
  process.exit(1);
}

const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error("The working tree must be clean before releasing.");
  process.exit(1);
}

await $`git pull --ff-only origin main`;
await $`npm version ${release} -m ${"release: v%s"}`;

const packageJson = await Bun.file("package.json").json();
const tag = `v${packageJson.version}`;

await $`git push origin main`;
await $`git push origin ${tag}`;

console.log(`\n${tag} pushed. GitHub Actions will now publish it to npm.`);
