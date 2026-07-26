import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const distDirectory = resolve(root, "dist");
      const outputDirectory = resolve(distDirectory, ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }

      if (await exists(distDirectory)) {
        const entries = await readdir(distDirectory, { withFileTypes: true });
        const workerDirectory = entries.find(
          (entry) =>
            entry.isDirectory() &&
            ![".openai", "client", "server"].includes(entry.name),
        );

        if (workerDirectory) {
          const workerOutput = resolve(distDirectory, workerDirectory.name);
          await rm(resolve(workerOutput, ".dev.vars"), { force: true });

          const workerEntry = resolve(workerOutput, "index.js");
          if (await exists(workerEntry)) {
            const serverDirectory = resolve(distDirectory, "server");
            await mkdir(serverDirectory, { recursive: true });
            await cp(workerEntry, resolve(serverDirectory, "index.js"));
          }
        }
      }
    },
  };
}
