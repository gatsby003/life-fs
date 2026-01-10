#!/Users/ganesh/.bun/bin/bun

import { mkdir, exists } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import readline from "readline";
import { askAgent } from "./agents/ask";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), "life");

const ROOT_AGENT_TEMPLATE = `# Agent Context

## Who I Am

<!-- Describe yourself: your values, what matters to you, how you think -->

## How to Help Me

<!-- What should an AI assistant know about helping you? -->

## Current Focus

<!-- What are you focused on right now in life? -->
`;

const STREAM_AGENT_TEMPLATE = `# Stream Context

This directory contains check-ins — raw, unfiltered captures of thoughts, feelings, and events.

## How to Interpret

- These are snapshots in time, not polished thoughts
- Look for patterns across entries, not isolated moments
- Emotions here are valid data, not problems to solve
- Connect entries to goals when relevant

## What to Track

- Recurring themes
- Emotional patterns
- Progress signals
- Blockers and friction
`;

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function multiLinePrompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(question);
  console.log("(Press Enter twice to finish)\n");

  return new Promise((resolve) => {
    const lines: string[] = [];
    let emptyLineCount = 0;

    rl.on("line", (line) => {
      if (line === "") {
        emptyLineCount++;
        if (emptyLineCount >= 1 && lines.length > 0) {
          rl.close();
          resolve(lines.join("\n"));
          return;
        }
      } else {
        emptyLineCount = 0;
      }
      lines.push(line);
    });

    rl.on("close", () => {
      resolve(lines.join("\n"));
    });
  });
}

function getDatePath(): { year: string; month: string; filename: string } {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");

  return {
    year,
    month,
    filename: `${day}-${hours}${minutes}.md`,
  };
}

function formatCheckinContent(content: string): string {
  const now = new Date();
  const isoDate = now.toISOString();

  return `---
date: ${isoDate}
---

${content}
`;
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

async function initVault(vaultPath?: string) {
  const path = vaultPath || DEFAULT_VAULT_PATH;

  console.log(`\n🌱 Initializing life vault at: ${path}\n`);

  // Check if already initialized
  const agentPath = join(path, "agent.md");
  if (await exists(agentPath)) {
    console.log("⚠️  Vault already exists at this location.");
    const overwrite = await prompt("Reinitialize? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  // Create directory structure
  await mkdir(path, { recursive: true });
  await mkdir(join(path, "stream"), { recursive: true });

  // Write agent.md files
  await Bun.write(agentPath, ROOT_AGENT_TEMPLATE);
  await Bun.write(join(path, "stream", "agent.md"), STREAM_AGENT_TEMPLATE);

  const displayPath = path.replace(homedir(), "~");
  console.log(`✓ Created ${displayPath}/`);
  console.log(`✓ Created ${displayPath}/agent.md`);
  console.log(`✓ Created ${displayPath}/stream/`);
  console.log(`✓ Created ${displayPath}/stream/agent.md`);
  console.log("\n🎉 Vault initialized! Edit agent.md to tell AI who you are.\n");
  console.log(`Run 'life checkin' to capture your first check-in.\n`);
}

async function checkin(vaultPath?: string) {
  const path = vaultPath || DEFAULT_VAULT_PATH;

  // Check if vault exists
  if (!(await exists(join(path, "agent.md")))) {
    console.log("\n⚠️  No vault found. Run 'life init' first.\n");
    return;
  }

  const content = await multiLinePrompt("\n💭 What's on your mind?\n");

  if (!content.trim()) {
    console.log("\nNothing to save.\n");
    return;
  }

  // Create date-based path
  const { year, month, filename } = getDatePath();
  const streamDir = join(path, "stream", year, month);

  await mkdir(streamDir, { recursive: true });

  const filePath = join(streamDir, filename);
  const formattedContent = formatCheckinContent(content);

  await Bun.write(filePath, formattedContent);

  const relativePath = filePath.replace(homedir(), "~");
  console.log(`\n✓ Saved to ${relativePath}\n`);
}

async function showStatus(vaultPath?: string) {
  const path = vaultPath || DEFAULT_VAULT_PATH;

  if (!(await exists(join(path, "agent.md")))) {
    console.log("\n⚠️  No vault found at", path);
    console.log("Run 'life init' to create one.\n");
    return;
  }

  console.log(`\n📂 Vault: ${path}`);

  // Count check-ins
  const streamPath = join(path, "stream");
  let checkinCount = 0;

  async function countFiles(dir: string): Promise<number> {
    const { readdir, stat } = await import("fs/promises");
    let count = 0;

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          count += await countFiles(fullPath);
        } else if (entry.endsWith(".md") && entry !== "agent.md") {
          count++;
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return count;
  }

  checkinCount = await countFiles(streamPath);
  console.log(`📝 Check-ins: ${checkinCount}`);
  console.log();
}

async function handleAsk(args: string[]) {
  // Parse arguments
  let question = "";
  let vaultPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      verbose = true;
    } else if (!args[i].startsWith("-")) {
      // Collect all non-flag arguments as the question
      if (question) {
        question += " " + args[i];
      } else {
        question = args[i];
      }
    }
  }

  if (!question) {
    console.log("\n⚠️  Please provide a question to ask.");
    console.log("Example: life ask \"What have I been focused on lately?\"\n");
    return;
  }

  console.log(`\n🔍 Searching vault for: "${question}"\n`);

  const result = await askAgent({ question, vaultPath, verbose });

  if (result.success) {
    console.log("─".repeat(60));
    console.log("\n" + result.answer + "\n");
  } else {
    console.log(`\n⚠️  ${result.error}\n`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const HELP = `
life-fs — Your life as a filesystem

Usage:
  life init [path]      Initialize a new vault (default: ~/life)
  life checkin          Capture a check-in
  life status           Show vault status
  life ask <question>   Ask a question about your vault
  life help             Show this help

Options for ask:
  --vault <path>        Path to vault (default: ~/life)
  --verbose, -v         Show detailed output

Examples:
  life init                    # Create vault at ~/life
  life init ~/my-vault         # Create vault at custom path
  life checkin                 # Record what's on your mind
  life ask "What have I been focused on lately?"
  life ask "What patterns do you see?" --verbose
`;

switch (command) {
  case "init":
    await initVault(args[0]);
    break;
  case "checkin":
  case "c":
    await checkin(args[0]);
    break;
  case "status":
  case "s":
    await showStatus(args[0]);
    break;
  case "ask":
  case "a":
    await handleAsk(args);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(HELP);
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
