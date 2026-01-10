#!/Users/ganesh/.bun/bin/bun

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { exists, mkdir } from "fs/promises";
import readline from "readline";

// ─────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class Spinner {
  private frameIndex = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private message: string;

  constructor(message = "Thinking") {
    this.message = message;
  }

  start() {
    this.frameIndex = 0;
    process.stdout.write(`\r${SPINNER_FRAMES[0]} ${this.message}...`);
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r${SPINNER_FRAMES[this.frameIndex]} ${this.message}...`);
    }, 80);
  }

  stop(clearLine = true) {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (clearLine) {
      process.stdout.write("\r" + " ".repeat(this.message.length + 10) + "\r");
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), "life");

const CHECKIN_AGENT_SYSTEM_PROMPT = `You are a thoughtful check-in companion helping the user process and articulate their thoughts.

## Your Role
You help users dig deeper into their check-ins through gentle, curious questions. Your goal is to help them:
- Clarify what they're really feeling or thinking
- Uncover what's beneath the surface
- Identify patterns or connections they might not see
- Process their experiences in a meaningful way

## How to Engage
1. **Start with what they shared**: Acknowledge their initial thoughts without judgment
2. **Ask ONE follow-up question**: Use the AskFollowUp tool to ask a single, thoughtful question
3. **Go deeper gradually**: Each question should help them explore a bit more
4. **Know when to stop**: After 3-4 exchanges, check if they want to continue or close

## Question Guidelines
- Ask open-ended questions (not yes/no)
- Be curious, not interrogative
- Focus on feelings, motivations, or patterns
- Keep questions concise and clear
- Match their energy - if they're brief, don't overwhelm them

## When They Skip a Question
If the user presses enter without answering (empty response), gracefully move on:
- Don't repeat the same question
- Either ask something different or offer to wrap up
- Respect their boundaries

## Closing the Loop
After 3-4 exchanges, use AskFollowUp with is_closing=true to ask if they want to:
- Share anything else
- Or wrap up the check-in

## Your Output
At the end, you'll summarize the key themes from the check-in for the final entry.
Keep the essence of what they shared - don't over-sanitize or add your interpretations.
`;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface CheckinAgentOptions {
  vaultPath?: string;
  initialThoughts: string;
  verbose?: boolean;
}

export interface CheckinAgentResult {
  success: boolean;
  finalContent?: string;
  error?: string;
}

interface ConversationExchange {
  question: string;
  answer: string;
}

// ─────────────────────────────────────────────────────────────
// Interactive Input Handler
// ─────────────────────────────────────────────────────────────

class InteractiveSession {
  private rl: readline.Interface | null = null;
  private exchanges: ConversationExchange[] = [];
  private currentQuestion: string = "";
  private resolveInput: ((value: string) => void) | null = null;

  async askQuestion(question: string): Promise<string> {
    this.currentQuestion = question;

    // Display the question
    console.log(`\n${question}`);
    console.log("(Press Enter to skip)\n");

    // Show initial prompt
    process.stdout.write("> ");

    return new Promise((resolve) => {
      this.resolveInput = resolve;

      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const lines: string[] = [];

      this.rl.on("line", (line) => {
        if (line === "") {
          this.rl?.close();
          const answer = lines.join("\n").trim();
          this.exchanges.push({ question: this.currentQuestion, answer });
          resolve(answer);
          return;
        } else {
          lines.push(line);
        }
        // Show prompt for next line
        process.stdout.write("> ");
      });

      this.rl.on("close", () => {
        const answer = lines.join("\n").trim();
        if (this.resolveInput) {
          this.exchanges.push({ question: this.currentQuestion, answer });
          resolve(answer);
        }
      });
    });
  }

  getExchanges(): ConversationExchange[] {
    return this.exchanges;
  }

  close() {
    this.rl?.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Check-in Agent
// ─────────────────────────────────────────────────────────────

export async function checkinAgent(options: CheckinAgentOptions): Promise<CheckinAgentResult> {
  const vaultPath = options.vaultPath || DEFAULT_VAULT_PATH;

  // Check if vault exists
  if (!(await exists(join(vaultPath, "agent.md")))) {
    return {
      success: false,
      error: `No vault found at ${vaultPath}. Run 'life init' first.`,
    };
  }

  const session = new InteractiveSession();
  let exchangeCount = 0;
  const maxExchanges = 4;
  let shouldContinue = true;
  let finalSummary = "";

  // Track conversation for the agent
  const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  const queryOptions: Options = {
    cwd: vaultPath,
    tools: ["AskUserQuestion"],
    allowedTools: ["AskUserQuestion"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: CHECKIN_AGENT_SYSTEM_PROMPT,
    maxTurns: 10,
  };

  const spinner = new Spinner("Thinking");

  try {
    // Initial prompt to the agent
    let currentPrompt = `The user has started a check-in and shared their initial thoughts:

"${options.initialThoughts}"

Please acknowledge what they shared and ask ONE thoughtful follow-up question to help them explore their thoughts deeper. Use the AskUserQuestion tool to ask your question.

Remember: You'll have ${maxExchanges} exchanges total, so pace your questions accordingly.`;

    while (shouldContinue && exchangeCount < maxExchanges) {
      let questionToAsk = "";
      let isClosingQuestion = false;

      // Start spinner while AI is thinking
      spinner.start();

      // Query the agent
      for await (const message of query({ prompt: currentPrompt, options: queryOptions })) {
        if (options.verbose) {
          logMessage(message);
        }

        // Look for AskUserQuestion tool calls
        if (message.type === "assistant" && message.message.content) {
          for (const block of message.message.content) {
            if (block.type === "tool_use" && block.name === "AskUserQuestion") {
              const input = block.input as { questions: Array<{ question: string }> };
              if (input.questions && input.questions[0]) {
                questionToAsk = input.questions[0].question;
                // Check if this seems like a closing question
                isClosingQuestion = questionToAsk.toLowerCase().includes("anything else") ||
                  questionToAsk.toLowerCase().includes("wrap up") ||
                  questionToAsk.toLowerCase().includes("ready to close") ||
                  questionToAsk.toLowerCase().includes("that's all");
              }
            } else if (block.type === "text") {
              // Capture any text output for the summary
              finalSummary = block.text;
            }
          }
        }

        if (message.type === "result") {
          if (message.subtype === "success" && message.result) {
            finalSummary = message.result;
          }
          break;
        }
      }

      // Stop spinner before asking user question
      spinner.stop();

      // If the agent wants to ask a question, present it to the user
      if (questionToAsk) {
        const userResponse = await session.askQuestion(questionToAsk);
        exchangeCount++;

        // If user skipped (empty response) twice in a row, or it's a closing question with "no"
        if (userResponse === "") {
          if (isClosingQuestion) {
            shouldContinue = false;
            break;
          }
          // User skipped - agent should move on or wrap up
          currentPrompt = `The user chose not to answer that question (they pressed enter to skip).

${exchangeCount >= maxExchanges - 1 ?
  "This is the final exchange. Please ask if they'd like to share anything else before we wrap up, or offer to close the check-in." :
  "Ask a different question or offer to wrap up if they seem done."}

Use the AskUserQuestion tool for your response.`;
        } else if (isClosingQuestion && (userResponse.toLowerCase().includes("no") || userResponse.toLowerCase().includes("that's all") || userResponse.toLowerCase().includes("done"))) {
          shouldContinue = false;
          break;
        } else {
          // Continue the conversation
          conversationHistory.push({ role: "user", content: userResponse });

          if (exchangeCount >= maxExchanges - 1) {
            currentPrompt = `The user responded: "${userResponse}"

This is the final exchange. Please ask if they'd like to share anything else before we wrap up the check-in.

Use the AskUserQuestion tool for your response.`;
          } else {
            currentPrompt = `The user responded: "${userResponse}"

Continue the conversation. Ask another thoughtful question to help them explore further. You have ${maxExchanges - exchangeCount} exchanges remaining.

Use the AskUserQuestion tool for your response.`;
          }
        }
      } else {
        // No question asked, agent is done
        shouldContinue = false;
      }
    }

    session.close();

    // Build the final check-in content
    const exchanges = session.getExchanges();
    let finalContent = options.initialThoughts;

    if (exchanges.length > 0) {
      finalContent += "\n\n---\n\n**Reflections:**\n";
      for (const exchange of exchanges) {
        if (exchange.answer) {
          finalContent += `\n*${exchange.question}*\n${exchange.answer}\n`;
        }
      }
    }

    return {
      success: true,
      finalContent,
    };
  } catch (error) {
    spinner.stop();
    session.close();
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
            console.log(`\n[Agent] ${block.text.slice(0, 200)}...`);
          } else if (block.type === "tool_use") {
            console.log(`\n[Tool] ${block.name}`);
          }
        }
      }
      break;
    case "result":
      if (message.subtype === "success") {
        console.log(`\n[Result] Completed in ${message.num_turns} turns`);
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// File Operations
// ─────────────────────────────────────────────────────────────

export function getDatePath(): { year: string; month: string; filename: string } {
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

export function formatCheckinContent(content: string): string {
  const now = new Date();
  const isoDate = now.toISOString();

  return `---
date: ${isoDate}
---

${content}
`;
}

export async function saveCheckin(vaultPath: string, content: string): Promise<string> {
  const { year, month, filename } = getDatePath();
  const streamDir = join(vaultPath, "stream", year, month);

  await mkdir(streamDir, { recursive: true });

  const filePath = join(streamDir, filename);
  const formattedContent = formatCheckinContent(content);

  await Bun.write(filePath, formattedContent);

  return filePath;
}

// ─────────────────────────────────────────────────────────────
// Analysis Agent
// ─────────────────────────────────────────────────────────────

const ANALYSIS_AGENT_SYSTEM_PROMPT = `You are a content editor that cleans up check-in conversations into a polished, readable format.

## Your Task
Take the raw check-in exchange (initial thoughts + follow-up Q&A) and clean it up by:
1. Removing redundancies and repetitive content
2. Consolidating scattered thoughts into coherent themes
3. Preserving the user's authentic voice and key insights
4. Removing filler words, hesitations, and conversational artifacts
5. Organizing content in a logical flow

## Output Format
Return ONLY the cleaned content in this format:

[Main thoughts/reflections in clear prose]

**Key Insights:**
- [Bullet points of the most important realizations or themes]

## Guidelines
- Do NOT add your own interpretations or advice
- Do NOT change the meaning or sentiment
- Do NOT remove emotional content - it's important
- Keep it concise but preserve what matters
- If the original is already clean and brief, minimal changes are fine
- Preserve specific details, names, dates, and context
`;

export interface AnalysisAgentOptions {
  vaultPath: string;
  rawContent: string;
  verbose?: boolean;
}

export interface AnalysisAgentResult {
  success: boolean;
  cleanedContent?: string;
  error?: string;
}

export async function analysisAgent(options: AnalysisAgentOptions): Promise<AnalysisAgentResult> {
  const queryOptions: Options = {
    cwd: options.vaultPath,
    tools: [],
    allowedTools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: ANALYSIS_AGENT_SYSTEM_PROMPT,
    maxTurns: 1,
  };

  const prompt = `Please clean up this check-in exchange:

---
${options.rawContent}
---

Return only the cleaned content, nothing else.`;

  try {
    let cleanedContent = "";

    for await (const message of query({ prompt, options: queryOptions })) {
      if (options.verbose) {
        logMessage(message);
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          cleanedContent = message.result;
        } else {
          return {
            success: false,
            error: message.errors?.join("\n") || "Analysis failed",
          };
        }
      }
    }

    return {
      success: true,
      cleanedContent,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
checkin-agent — Interactive check-in for your life vault

Usage:
  bun src/agents/checkin.ts [options]

Options:
  --vault <path>   Path to vault (default: ~/life)
  --verbose, -v    Show detailed output
  --help, -h       Show this help
`);
    return;
  }

  // Parse arguments
  let vaultPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && args[i + 1]) {
      vaultPath = args[i + 1];
      i++;
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      verbose = true;
    }
  }

  const path = vaultPath || DEFAULT_VAULT_PATH;

  // Check if vault exists
  if (!(await exists(join(path, "agent.md")))) {
    console.log("\n No vault found. Run 'life init' first.\n");
    return;
  }

  // Get initial thoughts
  console.log("\n What's on your mind?\n");
  console.log("(Press Enter to continue)\n");

  // Show initial prompt
  process.stdout.write("> ");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const initialThoughts = await new Promise<string>((resolve) => {
    const lines: string[] = [];

    rl.on("line", (line) => {
      if (line === "") {
        rl.close();
        resolve(lines.join("\n"));
        return;
      } else {
        lines.push(line);
      }
      // Show prompt for next line
      process.stdout.write("> ");
    });

    rl.on("close", () => {
      resolve(lines.join("\n"));
    });
  });

  if (!initialThoughts.trim()) {
    console.log("\nNothing to save.\n");
    return;
  }

  console.log("\n Let me help you explore that a bit more...\n");

  const result = await checkinAgent({
    initialThoughts,
    vaultPath,
    verbose,
  });

  if (result.success && result.finalContent) {
    // Run analysis agent to clean up the content
    const analysisSpinner = new Spinner("Analyzing");
    analysisSpinner.start();

    const analysisResult = await analysisAgent({
      vaultPath: path,
      rawContent: result.finalContent,
      verbose,
    });

    analysisSpinner.stop();

    const contentToSave = analysisResult.success && analysisResult.cleanedContent
      ? analysisResult.cleanedContent
      : result.finalContent;

    const filePath = await saveCheckin(path, contentToSave);
    const relativePath = filePath.replace(homedir(), "~");
    console.log(`\n Saved to ${relativePath}\n`);
  } else {
    console.log(`\n Error: ${result.error}\n`);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
