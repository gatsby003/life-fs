import matter from "gray-matter";
import { mkdir, exists, readdir, unlink } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import readline from "readline";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export enum GoalStatus {
  Active = "active",
  Completed = "completed",
  Paused = "paused",
  Abandoned = "abandoned",
}

export interface GoalFrontmatter {
  id: string;
  title: string;
  status: GoalStatus;
  version: number;
  tags: string[];
  created: string;
  updated: string;
}

export interface ParsedGoal {
  frontmatter: GoalFrontmatter;
  content: string;
  filePath: string;
}

export interface GoalSection {
  intent: string;
  definitionOfDone: string;
  currentFocus: string;
  history: string[];
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), "life");

export const GOAL_DIRECTORIES = [
  "active",
  "archive",
  "paused",
  "completed",
  "abandoned",
] as const;

export const GOALS_AGENT_TEMPLATE = `# Goals Context

This directory contains your goals — structured intentions with clear definitions of done.

## Structure

- \`active/\` — Goals you're currently working on
- \`paused/\` — Goals temporarily on hold
- \`completed/\` — Successfully achieved goals
- \`abandoned/\` — Goals you've consciously decided to drop
- \`archive/\` — Version history of goal updates

## Goal Format

Each goal file contains:
- **Frontmatter**: ID, title, status, version, tags, timestamps
- **Intent**: Why this goal matters to you
- **Definition of Done**: Clear criteria for completion
- **Current Focus**: What you're working on right now
- **History**: Log of updates and changes

## How to Interpret

- Active goals represent current commitments
- Paused goals aren't failures — they're conscious deferrals
- Abandoned goals are valuable data about what didn't work
- Version history shows how goals evolve over time
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

// ─────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────

/**
 * Generate a unique goal ID (8 character hex string)
 */
export function generateGoalId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse a goal file and extract frontmatter and content
 */
export function parseGoalFile(
  fileContent: string,
  filePath: string
): ParsedGoal {
  const { data, content } = matter(fileContent);

  const frontmatter: GoalFrontmatter = {
    id: data.id || "",
    title: data.title || "",
    status: data.status || GoalStatus.Active,
    version: data.version || 1,
    tags: data.tags || [],
    created: data.created || new Date().toISOString(),
    updated: data.updated || new Date().toISOString(),
  };

  return {
    frontmatter,
    content: content.trim(),
    filePath,
  };
}

/**
 * Serialize a goal back to markdown with frontmatter
 */
export function serializeGoal(
  frontmatter: GoalFrontmatter,
  content: string
): string {
  return matter.stringify(content, frontmatter);
}

/**
 * Get the vault path from args or use default
 */
export function getVaultPath(vaultPath?: string): string {
  return vaultPath || DEFAULT_VAULT_PATH;
}

/**
 * Get the goals directory path
 */
export function getGoalsPath(vaultPath?: string): string {
  return join(getVaultPath(vaultPath), "goals");
}

/**
 * Find a goal by ID across all status directories
 */
export async function findGoalById(
  goalId: string,
  vaultPath?: string
): Promise<ParsedGoal | null> {
  const goalsPath = getGoalsPath(vaultPath);

  for (const dir of GOAL_DIRECTORIES) {
    if (dir === "archive") continue; // Skip archive directory for active searches

    const dirPath = join(goalsPath, dir);
    if (!(await exists(dirPath))) continue;

    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".md") || file === "agent.md") continue;

      const filePath = join(dirPath, file);
      const content = await Bun.file(filePath).text();
      const goal = parseGoalFile(content, filePath);

      if (goal.frontmatter.id === goalId) {
        return goal;
      }
    }
  }

  return null;
}

/**
 * Check if a goal ID already exists
 */
export async function goalIdExists(
  goalId: string,
  vaultPath?: string
): Promise<boolean> {
  return (await findGoalById(goalId, vaultPath)) !== null;
}

/**
 * Get all goals in a specific status directory
 */
export async function getGoalsByStatus(
  status: GoalStatus,
  vaultPath?: string
): Promise<ParsedGoal[]> {
  const goalsPath = getGoalsPath(vaultPath);
  const dirPath = join(goalsPath, status);

  if (!(await exists(dirPath))) return [];

  const files = await readdir(dirPath);
  const goals: ParsedGoal[] = [];

  for (const file of files) {
    if (!file.endsWith(".md") || file === "agent.md") continue;

    const filePath = join(dirPath, file);
    const content = await Bun.file(filePath).text();
    const goal = parseGoalFile(content, filePath);
    goals.push(goal);
  }

  // Sort by updated date descending
  goals.sort(
    (a, b) =>
      new Date(b.frontmatter.updated).getTime() -
      new Date(a.frontmatter.updated).getTime()
  );

  return goals;
}

/**
 * Create a goal file path
 */
export function getGoalFilePath(
  goalId: string,
  status: GoalStatus,
  vaultPath?: string
): string {
  return join(getGoalsPath(vaultPath), status, `${goalId}.md`);
}

/**
 * Format ISO date to human readable
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

/**
 * Interactive goal creation
 */
export async function goalAdd(vaultPath?: string): Promise<void> {
  const path = getVaultPath(vaultPath);

  // Check if vault exists
  if (!(await exists(join(path, "agent.md")))) {
    console.log("\n  No vault found. Run 'life init' first.\n");
    return;
  }

  console.log("\n  Creating a new goal...\n");

  // Get goal details
  const title = await prompt("Title: ");
  if (!title.trim()) {
    console.log("\nGoal title is required.\n");
    return;
  }

  console.log();
  const intent = await multiLinePrompt("Intent (why does this goal matter?):");
  if (!intent.trim()) {
    console.log("\nIntent is required.\n");
    return;
  }

  console.log();
  const definitionOfDone = await multiLinePrompt(
    "Definition of Done (what does success look like?):"
  );
  if (!definitionOfDone.trim()) {
    console.log("\nDefinition of Done is required.\n");
    return;
  }

  console.log();
  const currentFocus = await multiLinePrompt(
    "Current Focus (what are you working on first?):"
  );

  const tagsInput = await prompt("\nTags (comma-separated): ");
  const tags = tagsInput
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Generate unique ID
  let goalId = generateGoalId();
  while (await goalIdExists(goalId, vaultPath)) {
    goalId = generateGoalId();
  }

  const now = new Date().toISOString();

  const frontmatter: GoalFrontmatter = {
    id: goalId,
    title: title.trim(),
    status: GoalStatus.Active,
    version: 1,
    tags,
    created: now,
    updated: now,
  };

  const content = `## Intent

${intent.trim()}

## Definition of Done

${definitionOfDone.trim()}

## Current Focus

${currentFocus.trim() || "_Not specified_"}

## History

- ${formatDate(now)}: Goal created
`;

  const goalContent = serializeGoal(frontmatter, content);
  const filePath = getGoalFilePath(goalId, GoalStatus.Active, vaultPath);

  await Bun.write(filePath, goalContent);

  const displayPath = filePath.replace(homedir(), "~");
  console.log(`\n  Goal created: ${displayPath}`);
  console.log(`  ID: ${goalId}\n`);
}

/**
 * Display a goal by ID
 */
export async function goalShow(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal show <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  const { frontmatter, content, filePath } = goal;
  const displayPath = filePath.replace(homedir(), "~");

  console.log(`
  ${frontmatter.title}
  ${"─".repeat(frontmatter.title.length + 4)}

  ID:       ${frontmatter.id}
  Status:   ${frontmatter.status}
  Version:  ${frontmatter.version}
  Tags:     ${frontmatter.tags.length > 0 ? frontmatter.tags.join(", ") : "none"}
  Created:  ${formatDate(frontmatter.created)}
  Updated:  ${formatDate(frontmatter.updated)}
  File:     ${displayPath}

${content}
`);
}

/**
 * List active goals
 */
export async function goalList(vaultPath?: string): Promise<void> {
  const goals = await getGoalsByStatus(GoalStatus.Active, vaultPath);

  if (goals.length === 0) {
    console.log("\n  No active goals.\n");
    console.log("  Create one with: life goal add\n");
    return;
  }

  console.log(`\n  Active Goals (${goals.length})\n`);
  console.log("  " + "─".repeat(60));

  for (const goal of goals) {
    const { frontmatter } = goal;
    const tags =
      frontmatter.tags.length > 0 ? `[${frontmatter.tags.join(", ")}]` : "";

    console.log(`  ${frontmatter.id}  ${frontmatter.title}`);
    console.log(
      `            Updated: ${formatDate(frontmatter.updated)} ${tags}`
    );
    console.log();
  }
}

/**
 * Move goal from one status to another
 */
async function moveGoal(
  goalId: string,
  newStatus: GoalStatus,
  historyEntry: string,
  vaultPath?: string
): Promise<ParsedGoal | null> {
  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return null;
  }

  const { frontmatter, content, filePath } = goal;
  const oldStatus = frontmatter.status;

  // Update frontmatter
  frontmatter.status = newStatus;
  frontmatter.updated = new Date().toISOString();

  // Add history entry
  const historySection = content.indexOf("## History");
  let newContent = content;

  if (historySection !== -1) {
    const historyStart = content.indexOf("\n", historySection) + 1;
    newContent =
      content.slice(0, historyStart) +
      `\n- ${formatDate(frontmatter.updated)}: ${historyEntry}` +
      content.slice(historyStart);
  }

  // Write to new location
  const newFilePath = getGoalFilePath(goalId, newStatus, vaultPath);
  const newGoalContent = serializeGoal(frontmatter, newContent);
  await Bun.write(newFilePath, newGoalContent);

  // Delete from old location
  if (filePath !== newFilePath) {
    await unlink(filePath);
  }

  return parseGoalFile(newGoalContent, newFilePath);
}

/**
 * Mark a goal as completed
 */
export async function goalComplete(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal complete <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  if (goal.frontmatter.status !== GoalStatus.Active) {
    console.log(
      `\n  Goal must be active to complete. Current status: ${goal.frontmatter.status}\n`
    );
    return;
  }

  console.log(`\n  Completing goal: ${goal.frontmatter.title}\n`);

  const reflection = await multiLinePrompt(
    "Completion reflection (what did you learn?):"
  );
  const historyEntry = reflection.trim()
    ? `Completed - ${reflection.trim()}`
    : "Completed";

  const updatedGoal = await moveGoal(
    goalId,
    GoalStatus.Completed,
    historyEntry,
    vaultPath
  );

  if (updatedGoal) {
    const displayPath = updatedGoal.filePath.replace(homedir(), "~");
    console.log(`\n  Goal completed: ${displayPath}\n`);
  }
}

/**
 * Pause a goal
 */
export async function goalPause(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal pause <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  if (goal.frontmatter.status !== GoalStatus.Active) {
    console.log(
      `\n  Goal must be active to pause. Current status: ${goal.frontmatter.status}\n`
    );
    return;
  }

  console.log(`\n  Pausing goal: ${goal.frontmatter.title}\n`);

  const reason = await multiLinePrompt("Reason for pausing (optional):");
  const historyEntry = reason.trim() ? `Paused - ${reason.trim()}` : "Paused";

  const updatedGoal = await moveGoal(
    goalId,
    GoalStatus.Paused,
    historyEntry,
    vaultPath
  );

  if (updatedGoal) {
    const displayPath = updatedGoal.filePath.replace(homedir(), "~");
    console.log(`\n  Goal paused: ${displayPath}\n`);
  }
}

/**
 * Resume a paused goal
 */
export async function goalResume(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal resume <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  if (goal.frontmatter.status !== GoalStatus.Paused) {
    console.log(
      `\n  Goal must be paused to resume. Current status: ${goal.frontmatter.status}\n`
    );
    return;
  }

  console.log(`\n  Resuming goal: ${goal.frontmatter.title}\n`);

  const note = await multiLinePrompt(
    "Note on resuming (what changed? optional):"
  );
  const historyEntry = note.trim() ? `Resumed - ${note.trim()}` : "Resumed";

  const updatedGoal = await moveGoal(
    goalId,
    GoalStatus.Active,
    historyEntry,
    vaultPath
  );

  if (updatedGoal) {
    const displayPath = updatedGoal.filePath.replace(homedir(), "~");
    console.log(`\n  Goal resumed: ${displayPath}\n`);
  }
}

/**
 * Abandon a goal
 */
export async function goalAbandon(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal abandon <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  if (
    goal.frontmatter.status !== GoalStatus.Active &&
    goal.frontmatter.status !== GoalStatus.Paused
  ) {
    console.log(
      `\n  Goal must be active or paused to abandon. Current status: ${goal.frontmatter.status}\n`
    );
    return;
  }

  console.log(`\n  Abandoning goal: ${goal.frontmatter.title}\n`);

  const reason = await prompt("Reason for abandoning: ");
  if (!reason.trim()) {
    console.log("\nReason is required to abandon a goal.\n");
    return;
  }

  const historyEntry = `Abandoned - ${reason.trim()}`;

  const updatedGoal = await moveGoal(
    goalId,
    GoalStatus.Abandoned,
    historyEntry,
    vaultPath
  );

  if (updatedGoal) {
    const displayPath = updatedGoal.filePath.replace(homedir(), "~");
    console.log(`\n  Goal abandoned: ${displayPath}\n`);
  }
}

/**
 * Update a goal (archive current version, increment version, update content)
 */
export async function goalUpdate(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal update <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  const { frontmatter, content, filePath } = goal;

  console.log(`\n  Updating goal: ${frontmatter.title}`);
  console.log(`  Current version: ${frontmatter.version}\n`);

  // Archive current version
  const archivePath = join(getGoalsPath(vaultPath), "archive", goalId);
  await mkdir(archivePath, { recursive: true });

  const archiveFilename = `v${frontmatter.version}-${frontmatter.updated.split("T")[0]}.md`;
  const archiveFilePath = join(archivePath, archiveFilename);

  const currentContent = await Bun.file(filePath).text();
  await Bun.write(archiveFilePath, currentContent);

  console.log(`  Archived v${frontmatter.version} to archive/${goalId}/\n`);

  // Prompt for updates
  console.log(
    "Leave blank to keep current value. Enter new text to replace.\n"
  );

  // Extract current sections
  const intentMatch = content.match(/## Intent\n\n([\s\S]*?)(?=\n## |$)/);
  const dodMatch = content.match(
    /## Definition of Done\n\n([\s\S]*?)(?=\n## |$)/
  );
  const focusMatch = content.match(
    /## Current Focus\n\n([\s\S]*?)(?=\n## |$)/
  );
  const historyMatch = content.match(/## History\n([\s\S]*?)$/);

  const currentIntent = intentMatch?.[1]?.trim() ?? "";
  const currentDoD = dodMatch?.[1]?.trim() ?? "";
  const currentFocus = focusMatch?.[1]?.trim() ?? "";
  const currentHistory = historyMatch?.[1]?.trim() ?? "";

  console.log("Current Intent:", currentIntent.substring(0, 100) + "...\n");
  const newIntent = await multiLinePrompt("New Intent (or leave blank):");

  console.log(
    "\nCurrent Definition of Done:",
    currentDoD.substring(0, 100) + "...\n"
  );
  const newDoD = await multiLinePrompt(
    "New Definition of Done (or leave blank):"
  );

  console.log(
    "\nCurrent Focus:",
    currentFocus.substring(0, 100) + "...\n"
  );
  const newFocus = await multiLinePrompt("New Current Focus (or leave blank):");

  const changeDescription = await prompt("\nDescribe this update: ");
  if (!changeDescription.trim()) {
    console.log("\nUpdate description is required.\n");
    return;
  }

  // Build new content
  const now = new Date().toISOString();
  const newHistoryEntry = `- ${formatDate(now)}: v${frontmatter.version + 1} - ${changeDescription.trim()}`;

  const updatedContent = `## Intent

${newIntent.trim() || currentIntent}

## Definition of Done

${newDoD.trim() || currentDoD}

## Current Focus

${newFocus.trim() || currentFocus}

## History

${newHistoryEntry}
${currentHistory}
`;

  // Update frontmatter
  frontmatter.version += 1;
  frontmatter.updated = now;

  const goalContent = serializeGoal(frontmatter, updatedContent);
  await Bun.write(filePath, goalContent);

  const displayPath = filePath.replace(homedir(), "~");
  console.log(`\n  Goal updated to v${frontmatter.version}: ${displayPath}\n`);
}

/**
 * Show version history for a goal
 */
export async function goalHistory(
  goalId?: string,
  vaultPath?: string
): Promise<void> {
  if (!goalId) {
    console.log("\n  Usage: life goal history <goal-id>\n");
    return;
  }

  const goal = await findGoalById(goalId, vaultPath);

  if (!goal) {
    console.log(`\n  Goal not found: ${goalId}\n`);
    return;
  }

  const { frontmatter, filePath } = goal;
  const displayPath = filePath.replace(homedir(), "~");

  console.log(`\n  ${frontmatter.title}`);
  console.log(`  ${"─".repeat(frontmatter.title.length + 4)}\n`);
  console.log(`  Current: v${frontmatter.version} (${displayPath})\n`);

  // List archived versions
  const archivePath = join(getGoalsPath(vaultPath), "archive", goalId);

  if (!(await exists(archivePath))) {
    console.log("  No archived versions.\n");
    return;
  }

  const archiveFiles = await readdir(archivePath);
  const versions = archiveFiles
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  if (versions.length === 0) {
    console.log("  No archived versions.\n");
    return;
  }

  console.log(`  Archived versions (${versions.length}):\n`);

  for (const version of versions) {
    const versionPath = join(archivePath, version);
    const archiveDisplayPath = versionPath.replace(homedir(), "~");

    // Extract version number and date from filename
    const match = version.match(/v(\d+)-(\d{4}-\d{2}-\d{2})\.md/);
    if (match) {
      console.log(`  v${match[1]}  ${match[2]}  ${archiveDisplayPath}`);
    }
  }

  console.log();
}
