export type TuiCommand =
  | { kind: "help" }
  | { kind: "agent.list" }
  | { kind: "agent.launch"; agentRef: string; repositoryUrl: string }
  | { kind: "test.list" }
  | { kind: "test.run"; testCaseId: string }
  | { kind: "workflow.list" }
  | {
      kind: "workflow.run";
      workflowId: string;
      repositoryUrl: string;
      fresh: boolean;
    }
  | { kind: "session.list" }
  | { kind: "session.attach"; sessionId: string }
  | { kind: "session.detach" }
  | { kind: "session.cancel"; sessionId: string }
  | { kind: "session.workspace"; sessionId: string }
  | { kind: "session.message"; sessionId: string; message: string }
  | {
      kind: "session.run-agent";
      sessionId: string;
      agentRef: string;
      task: string;
    }
  | { kind: "session.history"; sessionId: string }
  | { kind: "session.publish"; sessionId: string; branch: string }
  | {
      kind: "approval.resolve";
      sessionId: string;
      approved: boolean;
      remember?: boolean;
    }
  | {
      kind: "iteration.resolve";
      sessionId: string;
      continue: boolean;
    }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "invalid"; message: string };

export function parseTuiCommand(input: string): TuiCommand {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) {
    return { kind: "invalid", message: "Enter a slash command" };
  }
  const [command, ...args] = tokens;
  if (!command?.startsWith("/")) {
    return { kind: "invalid", message: "Commands must start with /" };
  }

  switch (command) {
    case "/help":
      return { kind: "help" };
    case "/agent":
      if (args[0] === "list" && args.length === 1) {
        return { kind: "agent.list" };
      }
      if (args[0] === "run" && args.length === 3) {
        return {
          kind: "agent.launch",
          agentRef: args[1] ?? "",
          repositoryUrl: args[2] ?? "",
        };
      }
      return invalid("Usage: /agent list | /agent run <agent-id> <repo-url>");
    case "/test":
      if (args[0] === "list" && args.length === 1) {
        return { kind: "test.list" };
      }
      if (args[0] === "run" && args.length === 2) {
        return { kind: "test.run", testCaseId: args[1] ?? "" };
      }
      return invalid("Usage: /test list | /test run <testcase-id|all>");
    case "/workflow":
      if (args[0] === "list" && args.length === 1) {
        return { kind: "workflow.list" };
      }
      if (
        args[0] === "run" &&
        (args.length === 3 || (args.length === 4 && args[3] === "fresh"))
      ) {
        return {
          kind: "workflow.run",
          workflowId: args[1] ?? "",
          repositoryUrl: args[2] ?? "",
          fresh: args[3] === "fresh",
        };
      }
      if (
        args[0] === "review-repair" &&
        (args.length === 2 || (args.length === 3 && args[2] === "fresh"))
      ) {
        return {
          kind: "workflow.run",
          workflowId: "review-repair",
          repositoryUrl: args[1] ?? "",
          fresh: args[2] === "fresh",
        };
      }
      return invalid(
        "Usage: /workflow list | /workflow run <workflow-id> <repo-url> [fresh]",
      );
    case "/sessions":
      return args.length === 0
        ? { kind: "session.list" }
        : invalid("Usage: /sessions");
    case "/session":
      if (args[0] === "attach" && args.length === 2) {
        return { kind: "session.attach", sessionId: args[1] ?? "" };
      }
      if (args[0] === "message" && args.length >= 3) {
        return {
          kind: "session.message",
          sessionId: args[1] ?? "",
          message: args.slice(2).join(" "),
        };
      }
      if (args[0] === "run-agent" && args.length >= 4) {
        return {
          kind: "session.run-agent",
          sessionId: args[1] ?? "",
          agentRef: args[2] ?? "",
          task: args.slice(3).join(" "),
        };
      }
      if (args[0] === "history" && args.length === 2) {
        return { kind: "session.history", sessionId: args[1] ?? "" };
      }
      if (
        args[0] === "publish" &&
        args.length === 4 &&
        args[2] === "--branch"
      ) {
        return {
          kind: "session.publish",
          sessionId: args[1] ?? "",
          branch: args[3] ?? "",
        };
      }
      return invalid(
        "Usage: /session attach <id> | /session message <id> <message> | /session run-agent <id> <agent-id> <task> | /session history <id> | /session publish <id> --branch <branch>",
      );
    case "/attach":
      return oneArgument(args, "Usage: /attach <session-id>", (sessionId) => ({
        kind: "session.attach",
        sessionId,
      }));
    case "/detach":
      return args.length === 0
        ? { kind: "session.detach" }
        : invalid("Usage: /detach");
    case "/cancel":
      return oneArgument(args, "Usage: /cancel <session-id>", (sessionId) => ({
        kind: "session.cancel",
        sessionId,
      }));
    case "/workspace":
      return oneArgument(
        args,
        "Usage: /workspace <session-id>",
        (sessionId) => ({ kind: "session.workspace", sessionId }),
      );
    case "/continue":
    case "/stop":
      return oneArgument(
        args,
        `Usage: ${command} <session-id>`,
        (sessionId) => ({
          kind: "iteration.resolve" as const,
          sessionId,
          continue: command === "/continue",
        }),
      );
    case "/approve":
    case "/deny":
    case "/allow-all":
    case "/deny-all":
      return oneArgument(
        args,
        `Usage: ${command} <session-id>`,
        (sessionId) => {
          const remember = command === "/allow-all" || command === "/deny-all";
          return {
            kind: "approval.resolve" as const,
            sessionId,
            approved: command === "/approve" || command === "/allow-all",
            ...(remember ? { remember: true } : {}),
          };
        },
      );
    case "/clear":
      return args.length === 0 ? { kind: "clear" } : invalid("Usage: /clear");
    case "/exit":
    case "/quit":
      return args.length === 0 ? { kind: "exit" } : invalid(`Usage: ${command}`);
    default:
      if (args.length === 1) {
        return {
          kind: "agent.launch",
          agentRef: command.slice(1),
          repositoryUrl: args[0] ?? "",
        };
      }
      return invalid(`Unknown command: ${command}`);
  }
}

function oneArgument<T extends TuiCommand>(
  args: readonly string[],
  usage: string,
  create: (value: string) => T,
): T | Extract<TuiCommand, { kind: "invalid" }> {
  return args.length === 1 && args[0] ? create(args[0]) : invalid(usage);
}

function invalid(message: string): Extract<TuiCommand, { kind: "invalid" }> {
  return { kind: "invalid", message };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
  for (const match of input.matchAll(expression)) {
    tokens.push((match[1] ?? match[2] ?? match[0]).replace(/\\([\\"'])/g, "$1"));
  }
  return tokens;
}