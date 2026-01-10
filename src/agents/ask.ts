#!/Users/ganesh/.bun/bin/bun

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { exists } from "fs/promises";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), "life");

const ASK_AGENT_SYSTEM_PROMPT = `You are an intelligent assistant helping the user query and understand their personal life vault.

## Your Role
You help users search through their vault of check-ins, notes, goals, and personal reflections to find answers, identify patterns, and surface insights.

## Context
The user's vault is a structured filesystem containing:
- \`agent.md\` - The user's identity context, values, and preferences
- \`stream/\` - Directory of timestamped check-ins organized by year/month
- Check-in files follow the format: \`stream/YYYY/MM/DD-HHMM.md\`
- Each check-in has YAML frontmatter with a date field

## How to Search
1. **Start broad**: Use Glob to find relevant files by pattern
2. **Search content**: Use Grep to search file contents for keywords
3. **Read relevant files**: Read the most promising files to understand context
4. **Synthesize**: Connect information across multiple check-ins

## When to Ask Questions
Use the AskUserQuestion tool when:
- The question is ambiguous and could mean different things
- You find multiple relevant topics and need to narrow down
- You need to understand the timeframe the user is interested in
- You want to confirm your interpretation before deep diving

## Response Style
- Be concise but thorough
- Quote relevant passages from check-ins when helpful
- Note patterns or connections across entries
- If you can't find relevant information, say so honestly
- Suggest follow-up questions the user might want to explore

## Important
- Respect the personal nature of this data
- Focus on being helpful, not judgmental
- If the user seems to be struggling with something, be supportive
`;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AskAgentOptions {
  vaultPath?: string;
  question: string;
  verbose?: boolean;
}

export interface AskAgentResult {
  success: boolean;
  answer?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// Ask Agent
// ─────────────────────────────────────────────────────────────

export async function askAgent(options: AskAgentOptions): Promise<AskAgentResult> {
  const vaultPath = options.vaultPath || DEFAULT_VAULT_PATH;

  // Check if vault exists
  if (!(await exists(join(vaultPath, "agent.md")))) {
    return {
      success: false,
      error: `No vault found at ${vaultPath}. Run 'life init' first.`,
    };
  }

  const queryOptions: Options = {
    cwd: vaultPath,
    tools: ["Glob", "Grep", "Read", "Bash", "WebFetch", "WebSearch", "AskUserQuestion"],
    allowedTools: ["Glob", "Grep", "Read", "Bash", "WebFetch", "WebSearch", "AskUserQuestion"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: ASK_AGENT_SYSTEM_PROMPT,
    maxTurns: 20,
  };

  const prompt = `The user is asking about their life vault located at: ${vaultPath}

Their question: "${options.question}"

Please search through the vault to find relevant information and provide a helpful answer. Start by reading the agent.md file to understand the user's context, then search through the stream/ directory for relevant check-ins.

If the question is ambiguous, use the AskUserQuestion tool to ask clarifying questions before searching.`;

  let answer = "";
  let lastAssistantMessage = "";

  try {
    for await (const message of query({ prompt, options: queryOptions })) {
      if (options.verbose) {
        logMessage(message);
      }

      // Capture the final result
      if (message.type === "result") {
        if (message.subtype === "success") {
          answer = message.result;
        } else {
          return {
            success: false,
            error: message.errors?.join("\n") || "Unknown error occurred",
          };
        }
      }

      // Capture assistant messages for verbose output
      if (message.type === "assistant" && message.message.content) {
        for (const block of message.message.content) {
          if (block.type === "text") {
            lastAssistantMessage = block.text;
          }
        }
      }
    }

    return {
      success: true,
      answer: answer || lastAssistantMessage,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function logMessage(message: SDKMessage): void {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        console.log(`\n[System] Initialized with model: ${message.model}`);
        console.log(`[System] Tools: ${message.tools.join(", ")}`);
      }
      break;
    case "assistant":
      if (message.message.content) {
        for (const block of message.message.content) {
          if (block.type === "text") {
            console.log(`\n[Assistant] ${block.text.slice(0, 200)}...`);
          } else if (block.type === "tool_use") {
            console.log(`\n[Tool Call] ${block.name}`);
          }
        }
      }
      break;
    case "result":
      if (message.subtype === "success") {
        console.log(`\n[Result] Completed in ${message.num_turns} turns`);
        console.log(`[Result] Cost: $${message.total_cost_usd.toFixed(4)}`);
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
ask-agent — Query your life vault

Usage:
  bun src/agents/ask.ts <question> [options]

Options:
  --vault <path>   Path to vault (default: ~/life)
  --verbose, -v    Show detailed output
  --help, -h       Show this help

Examples:
  bun src/agents/ask.ts "What have I been focused on lately?"
  bun src/agents/ask.ts "When did I last feel stressed?" --verbose
  bun src/agents/ask.ts "What patterns do you see in my check-ins?" --vault ~/my-vault
`);
    return;
  }

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
      question = args[i];
    }
  }

  if (!question) {
    console.error("Error: Please provide a question to ask.");
    process.exit(1);
  }

  console.log(`\nSearching vault for: "${question}"\n`);

  const result = await askAgent({ question, vaultPath, verbose });

  if (result.success) {
    console.log("\n" + "─".repeat(60));
    console.log("\n" + result.answer + "\n");
  } else {
    console.error(`\nError: ${result.error}\n`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
