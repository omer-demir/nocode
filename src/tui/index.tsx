#!/usr/bin/env node
import { resolve } from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { FileCatalog, loadScenario } from "../catalog/file-catalog.js";
import { resolveAgentModelConfiguration } from "../catalog/model-configuration.js";
import type { AgentDescriptor } from "../catalog/catalog-types.js";
import { RepositoryWorkspaceManager } from "../scenarios/workspace-manager.js";
import { createSandboxProvider } from "../sandbox/create-sandbox-provider.js";
import { startTelemetry } from "../telemetry/telemetry.js";
import type { RuntimeEvent } from "../runtime/runtime-events.js";
import { parseTuiCommand, type TuiCommand } from "./commands.js";
import { shortId, TuiController } from "./controller.js";
import {
  TuiSessionStore,
  type ConsoleMessage,
  type TuiSessionRecord,
  type TuiSnapshot,
} from "./session-store.js";

const HELP = [
  "/agent list                         List registered agents",
  "/vue-migrator <repo-url>           Launch the Vue coding agent",
  "/vue-reviewer <repo-url>           Launch the review-first agent",
  "/agent run <agent-id> <repo-url>   Launch any registered agent",
  "/test list                          List sample test cases",
  "/test run <id|all>                  Run sample test cases",
  "/workflow list                      List registered workflows",
  "/workflow run <id> <repo> [fresh]   Run a registered workflow",
  "/sessions                           List current sessions",
  "/session attach <id>                Follow one collaboration session",
  "/session message <id> <message>     Continue against its workspace",
  "/session run-agent <id> <agent> <task>  Run another registered agent",
  "/session history <id>               Show workflow and follow-up outputs",
  "/session publish <id> --branch <name>  Commit and push the workspace",
  "/attach <session-id>                Follow one session (alias)",
  "/detach                             Return to latest session",
  "/workspace <session-id>             Show the cloned workspace",
  "/approve <session-id>               Approve a pending tool",
  "/deny <session-id>                  Deny a pending tool",
  "/continue <session-id>              Grant 20 more agent turns",
  "/stop <session-id>                  Stop at the iteration limit",
  "/allow-all <session-id>             Approve all later requests in this run",
  "/deny-all <session-id>              Deny all later requests in this run",
  "/cancel <session-id>                Cancel a running session",
  "/clear                              Clear console messages",
  "/exit                               Stop sessions and close",
].join("\n");

interface WizardOption {
  label: string;
  value: string;
}

type Wizard =
  | {
      kind: "agent";
      step: "details" | "confirm";
      agentRef: string;
      agent: AgentDescriptor;
      repositoryUrl: string;
      baseTask: string;
      placement: "local" | "remote";
      task?: string;
    }
  | {
      kind: "test";
      step: "fresh" | "confirm";
      testCaseId: string;
      placement: "local" | "remote";
      fresh?: boolean;
    };

interface AppProps {
  controller: TuiController;
  store: TuiSessionStore;
  verbose: boolean;
}

function App({ controller, store, verbose }: AppProps): React.ReactNode {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => store.snapshot());
  const [input, setInput] = useState("");
  const [wizard, setWizard] = useState<Wizard>();
  const [selectedOption, setSelectedOption] = useState(0);
  const choices = wizardOptions(wizard);

  useEffect(() => store.subscribe(() => setSnapshot(store.snapshot())), [store]);
  useEffect(() => {
    setSelectedOption(0);
  }, [controller, wizard?.kind, wizard?.step]);
  useInput((value, key) => {
    if (key.escape && wizard) {
      setWizard(undefined);
      store.message("warning", "Launch cancelled");
      return;
    }
    if (choices && (key.upArrow || key.leftArrow)) {
      setSelectedOption((current) => wrapOption(current - 1, choices.length));
      return;
    }
    if (choices && (key.downArrow || key.rightArrow)) {
      setSelectedOption((current) => wrapOption(current + 1, choices.length));
      return;
    }
    if (choices && key.return && wizard) {
      const selected = choices[selectedOption];
      if (selected) {
        handleWizardSelection(
          selected.value,
          wizard,
          setWizard,
          controller,
          store,
        );
      }
      return;
    }
    if (key.ctrl && value === "c") {
      controller.cancelAll();
      exit();
    }
  });

  const attached = useMemo(() => selectActivitySession(snapshot), [snapshot]);
  const prompt = wizardPrompt(wizard);

  const submit = (value: string): void => {
    setInput("");
    if (wizard) {
      handleWizardInput(value.trim(), wizard, setWizard, controller, store);
      return;
    }
    handleCommand(parseTuiCommand(value), controller, store, setWizard, exit);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">NoCode Agent Console</Text>
        <Text dimColor>
          {controller.sandboxPlacement()} sandbox | OTel{verbose ? " | verbose" : ""}
        </Text>
      </Box>
      <Text dimColor>Type /help. Press Esc to cancel a question.</Text>
      {verbose ? (
        <Text dimColor>
          Verbose log is sanitized; prompts, file contents, credentials, and tool output remain hidden.
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Sessions</Text>
        {snapshot.sessions.length === 0 ? (
          <Text dimColor>No sessions started.</Text>
        ) : (
          snapshot.sessions.slice(0, 6).map((session) => (
            <SessionLine key={session.id} session={session} />
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>
          Activity{attached ? ` - ${shortId(attached.id)} ${attached.agentName}` : ""}
        </Text>
        {!attached ? (
          <Text dimColor>Attach to a session or launch an agent.</Text>
        ) : attached.events.length === 0 ? (
          <Text dimColor>Waiting for runtime events.</Text>
        ) : (
          <ActivityTimeline session={attached} verbose={verbose} />
        )}
        {attached?.summary ? (
          <Text color="green">Result: {singleLine(attached.summary, 180)}</Text>
        ) : null}
        {attached && attached.runs.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Outputs</Text>
            {attached.runs.slice(-8).map((run) => (
              <Text key={run.id}>
                <Text color={run.status === "completed" ? "green" : "red"}>
                  {run.status === "completed" ? "+" : "x"}
                </Text>{" "}
                <Text bold>{run.label}</Text>
                {run.agentId ? <Text dimColor> [{run.agentId}]</Text> : null}
                <Text>: {singleLine(run.summary, 140)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {attached?.error ? (
          <Text color="red">Error: {singleLine(attached.error, 180)}</Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Notifications</Text>
        {snapshot.messages.length === 0 ? (
          <Text dimColor>No notifications.</Text>
        ) : (
          snapshot.messages.slice(-5).map((message) => (
            <MessageLine key={message.id} message={message} />
          ))
        )}
      </Box>

      {choices ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">{prompt}</Text>
          <Box gap={2}>
            {choices.map((choice, index) => (
              <Text
                key={choice.value}
                bold={index === selectedOption}
                color={index === selectedOption ? "black" : "white"}
                {...(index === selectedOption
                  ? { backgroundColor: "cyan" as const }
                  : {})}
              >
                {index === selectedOption ? ">" : " "} {choice.label} {" "}
              </Text>
            ))}
          </Box>
          <Text dimColor>Use arrow keys to move, Enter to select, Esc to cancel.</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={wizard ? "yellow" : "cyan"}>{prompt} </Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function ActivityTimeline({
  session,
  verbose,
}: {
  session: TuiSessionRecord;
  verbose: boolean;
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {currentActivity(session)} | {session.events.length} events | {session.placement}
        {verbose ? ` | session ${session.id}` : ""}
        {verbose && session.agentIdentity ? ` | ${session.agentIdentity}` : ""}
      </Text>
      {session.events.slice(verbose ? -40 : -14).map((event, index) => {
        const details = eventDetails(event, verbose);
        return (
          <Box key={`${event.timestamp}-${index}`} flexDirection="column">
            <Text>
              <Text dimColor>{event.timestamp.slice(11, 19)} </Text>
              <Text color={eventColor(event.type)}>{eventMarker(event.type)} </Text>
              <Text color={eventColor(event.type)}>{event.message}</Text>
            </Text>
            {details ? <Text dimColor>         {details}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

function SessionLine({ session }: { session: TuiSessionRecord }): React.ReactNode {
  return (
    <Text>
      <Text color={statusColor(session.status)}>{session.status.padEnd(17)}</Text>
      <Text> {shortId(session.id)} </Text>
      <Text bold>{session.agentName}</Text>
      <Text dimColor>{session.workspacePath ? `  ${session.workspacePath}` : ""}</Text>
    </Text>
  );
}

function MessageLine({ message }: { message: ConsoleMessage }): React.ReactNode {
  const marker =
    message.level === "success"
      ? "+"
      : message.level === "warning"
        ? "!"
        : message.level === "error"
          ? "x"
          : "-";
  return (
    <Text color={messageColor(message.level)}>
      {marker} {message.text}
    </Text>
  );
}

function handleCommand(
  command: TuiCommand,
  controller: TuiController,
  store: TuiSessionStore,
  setWizard: React.Dispatch<React.SetStateAction<Wizard | undefined>>,
  exit: (error?: Error) => void,
): void {
  try {
    switch (command.kind) {
      case "help":
        store.message("info", HELP);
        return;
      case "agent.list":
        store.message(
          "info",
          controller
            .listAgents()
            .map((agent) => {
              const model =
                agent.model.provider === "microsoft-foundry"
                  ? resolveAgentModelConfiguration(agent.model)
                  : agent.model;
              const modelLabel =
                model.provider === "microsoft-foundry"
                  ? `${model.provider}/${model.deployment}`
                  : model.provider;
              return `${agent.id} [${agent.identity.subject} | ${modelLabel}]: ${agent.description}`;
            })
            .join("\n"),
        );
        return;
      case "agent.launch": {
        const agent = controller.resolveAgent(command.agentRef);
        const sampleTask = controller
          .listTestCases()
          .find((testCase) => testCase.agentId === agent.id)?.task;
        setWizard({
          kind: "agent",
          step: "details",
          agentRef: command.agentRef,
          agent,
          repositoryUrl: command.repositoryUrl,
          baseTask:
            sampleTask ??
            `Apply the registered ${agent.name} instructions to this repository and report the result.`,
          placement: controller.sandboxPlacement(),
        });
        store.message("info", `Configuring ${agent.name}`);
        return;
      }
      case "test.list":
        store.message(
          "info",
          controller
            .listTestCases()
            .map((testCase) => `${testCase.id}: ${testCase.description}`)
            .join("\n"),
        );
        return;
      case "test.run":
        setWizard({
          kind: "test",
          step: "fresh",
          testCaseId: command.testCaseId,
          placement: controller.sandboxPlacement(),
        });
        store.message("info", `Configuring test run ${command.testCaseId}`);
        return;
      case "workflow.list":
        store.message(
          "info",
          controller
            .listWorkflows()
            .map(
              (workflow) =>
                `${workflow.id}@${workflow.version} [${workflow.identity.subject}]: ${workflow.description}`,
            )
            .join("\n"),
        );
        return;
      case "workflow.run": {
        const sessionId = controller.launchWorkflow(
          command.workflowId,
          command.repositoryUrl,
          command.fresh,
        );
        store.attach(sessionId);
        return;
      }
      case "session.list":
        store.message(
          "info",
          store
            .snapshot()
            .sessions.map(
              (session) =>
                `${shortId(session.id)} ${session.status} ${session.agentName}`,
            )
            .join("\n") || "No sessions",
        );
        return;
      case "session.attach": {
        const id = store.resolveId(command.sessionId);
        store.attach(id);
        store.message("info", `Attached to ${shortId(id)}`);
        return;
      }
      case "session.message": {
        const id = controller.continueSession(command.sessionId, command.message);
        store.attach(id);
        return;
      }
      case "session.run-agent": {
        const id = controller.runAgentInSession(
          command.sessionId,
          command.agentRef,
          command.task,
        );
        store.attach(id);
        return;
      }
      case "session.history": {
        const id = store.resolveId(command.sessionId);
        const session = store.get(id);
        const history = session?.runs
          .map(
            (run) =>
              `${run.completedAt} ${run.status} ${run.label}${run.agentId ? ` [${run.agentId}]` : ""}: ${singleLine(run.summary, 500)}`,
          )
          .join("\n");
        store.message("info", history || `Session ${shortId(id)} has no run history`);
        return;
      }
      case "session.publish": {
        const id = controller.publishSession(command.sessionId, command.branch);
        store.attach(id);
        return;
      }
      case "session.detach":
        store.detach();
        store.message("info", "Detached; showing latest session");
        return;
      case "session.cancel":
        controller.cancel(command.sessionId);
        return;
      case "session.workspace": {
        const id = store.resolveId(command.sessionId);
        const workspace = store.get(id)?.workspacePath;
        store.message(
          workspace ? "info" : "warning",
          workspace ?? `Session ${shortId(id)} has not prepared a workspace yet`,
        );
        return;
      }
      case "approval.resolve":
        controller.resolveApproval(
          command.sessionId,
          command.approved,
          command.remember ?? false,
        );
        return;
      case "iteration.resolve":
        controller.resolveIterationLimit(
          command.sessionId,
          command.continue,
        );
        return;
      case "clear":
        store.clearMessages();
        return;
      case "exit":
        controller.cancelAll();
        exit();
        return;
      case "invalid":
        store.message("error", command.message);
    }
  } catch (error) {
    store.message("error", error instanceof Error ? error.message : String(error));
  }
}

function handleWizardInput(
  input: string,
  wizard: Wizard,
  setWizard: React.Dispatch<React.SetStateAction<Wizard | undefined>>,
  controller: TuiController,
  store: TuiSessionStore,
): void {
  try {
    if (wizard.kind === "agent" && wizard.step === "details") {
      const task = input
        ? `${wizard.baseTask}\n\nAdditional user requirements: ${input}`
        : wizard.baseTask;
      setWizard({ ...wizard, task, step: "confirm" });
      return;
    }
    store.message("error", "Use the arrow keys and Enter for this choice");
  } catch (error) {
    store.message("error", error instanceof Error ? error.message : String(error));
    setWizard(undefined);
  }
}

function handleWizardSelection(
  value: string,
  wizard: Wizard,
  setWizard: React.Dispatch<React.SetStateAction<Wizard | undefined>>,
  controller: TuiController,
  store: TuiSessionStore,
): void {
  try {
    if (wizard.kind === "test" && wizard.step === "fresh") {
      setWizard({ ...wizard, fresh: value === "fresh", step: "confirm" });
      return;
    }
    if (wizard.step === "confirm") {
      if (value !== "start") {
        setWizard(undefined);
        store.message("warning", "Launch cancelled");
        return;
      }
      const sessionIds =
        wizard.kind === "agent"
          ? [
              controller.launchAgent({
                agentRef: wizard.agentRef,
                repositoryUrl: wizard.repositoryUrl,
                placement: wizard.placement,
                task: wizard.task ?? wizard.baseTask,
              }),
            ]
          : controller.launchTestCases(
              wizard.testCaseId,
              wizard.placement,
              wizard.fresh ?? true,
            );
      const firstSession = sessionIds[0];
      if (firstSession) {
        store.attach(firstSession);
      }
      setWizard(undefined);
    }
  } catch (error) {
    store.message("error", error instanceof Error ? error.message : String(error));
    setWizard(undefined);
  }
}

function wizardPrompt(wizard: Wizard | undefined): string {
  if (!wizard) return "nocode>";
  if (wizard.kind === "agent" && wizard.step === "details") {
    return "Additional task details (optional)>";
  }
  if (wizard.kind === "test" && wizard.step === "fresh") {
    return "Workspace preparation";
  }
  return "Start agent session?";
}

function wizardOptions(wizard: Wizard | undefined): readonly WizardOption[] | undefined {
  if (!wizard) return undefined;
  if (wizard.kind === "test" && wizard.step === "fresh") {
    return [
      { label: "Fresh clones", value: "fresh" },
      { label: "Reuse workspaces", value: "reuse" },
    ];
  }
  if (wizard.step === "confirm") {
    return [
      { label: "Start", value: "start" },
      { label: "Cancel", value: "cancel" },
    ];
  }
  return undefined;
}

function wrapOption(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function selectActivitySession(snapshot: TuiSnapshot): TuiSessionRecord | undefined {
  if (snapshot.attachedSessionId) {
    return snapshot.sessions.find(
      (session) => session.id === snapshot.attachedSessionId,
    );
  }
  return snapshot.sessions[0];
}

function statusColor(status: TuiSessionRecord["status"]): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "awaiting-approval") return "yellow";
  return "cyan";
}

function eventColor(type: string): string {
  if (type === "session.failed") return "red";
  if (type === "security.detected") return "red";
  if (type === "session.cancelled") return "red";
  if (type === "session.completed") return "green";
  if (type === "tool.completed") return "cyan";
  if (type === "tool.requested" || type === "model.started") return "blue";
  if (type.startsWith("approval.")) return "yellow";
  return "white";
}

function eventMarker(type: RuntimeEvent["type"]): string {
  if (type === "session.failed") return "[x]";
  if (type === "security.detected") return "[!]";
  if (type === "session.cancelled") return "[x]";
  if (type === "session.completed") return "[+]";
  if (type === "model.started") return "[..]";
  if (type === "model.completed") return "[m]";
  if (type === "tool.requested") return "[>]";
  if (type === "tool.completed") return "[t]";
  if (type.startsWith("approval.")) return "[?]";
  return "[-]";
}

function currentActivity(session: TuiSessionRecord): string {
  if (session.status === "awaiting-approval") return "Waiting for approval";
  if (session.status === "completed") return "Completed";
  if (session.status === "failed") return "Failed";
  if (session.status === "cancelled") return "Cancelled";
  const latest = session.events.at(-1);
  if (latest?.type === "model.started") {
    return `Model working on turn ${attribute(latest, "iteration") ?? ""}`.trim();
  }
  if (latest?.type === "tool.requested") {
    return `Running ${attribute(latest, "toolName") ?? "tool"}`;
  }
  return session.status === "queued" ? "Preparing workspace" : "Running";
}

function eventDetails(
  event: RuntimeEvent,
  verbose: boolean,
): string | undefined {
  if (event.type === "model.started") {
    return joinDetails([
      "Awaiting model response",
      verbose ? prefixedAttribute(event, "iteration", "turn") : undefined,
    ]);
  }
  if (event.type === "model.completed") {
    return joinDetails([
      durationDetail(event),
      verbose ? prefixedAttribute(event, "model.provider", "provider") : undefined,
      verbose ? prefixedAttribute(event, "model.name", "model") : undefined,
      verbose ? tokenDetail(event, "model.usage.input_tokens", "input") : undefined,
      verbose ? tokenDetail(event, "model.usage.output_tokens", "output") : undefined,
      verbose ? tokenDetail(event, "model.usage.total_tokens", "total") : undefined,
      verbose
        ? tokenDetail(event, "model.usage.cached_input_tokens", "cached")
        : undefined,
      verbose
        ? tokenDetail(event, "model.usage.reasoning_tokens", "reasoning")
        : undefined,
      prefixedAttribute(event, "modelNote", "note"),
      verbose
        ? prefixedAttribute(event, "reasoningSummary", "reasoning summary")
        : undefined,
    ]);
  }
  if (event.type === "tool.requested") {
    return joinDetails([
      prefixedAttribute(event, "argumentSummary", "input"),
      verbose ? prefixedAttribute(event, "toolCallId", "call") : undefined,
    ]);
  }
  if (event.type === "tool.completed") {
    const success = attribute(event, "success");
    const outputBytes = attribute(event, "outputBytes");
    return joinDetails([
      success === undefined ? undefined : success ? "succeeded" : "failed",
      durationDetail(event),
      typeof outputBytes === "number" ? `${outputBytes} output bytes` : undefined,
      verbose ? prefixedAttribute(event, "toolCallId", "call") : undefined,
    ]);
  }
  if (event.type.startsWith("approval.")) {
    return prefixedAttribute(event, "toolName", "tool");
  }
  if (verbose && event.type === "sandbox.created") {
    return joinDetails([
      prefixedAttribute(event, "provider", "provider"),
      prefixedAttribute(event, "sandboxId", "sandbox"),
    ]);
  }
  if (verbose && event.type === "sandbox.terminated") {
    return prefixedAttribute(event, "sandboxId", "sandbox");
  }
  if (verbose && event.type === "session.started") {
    return prefixedAttribute(event, "agentId", "agent");
  }
  return undefined;
}

function tokenDetail(
  event: RuntimeEvent,
  name: string,
  label: string,
): string | undefined {
  const value = attribute(event, name);
  return typeof value === "number" ? `${label}: ${value} tokens` : undefined;
}

function durationDetail(event: RuntimeEvent): string | undefined {
  const durationMs = attribute(event, "durationMs");
  if (typeof durationMs !== "number") return undefined;
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(1)} s`;
}

function prefixedAttribute(
  event: RuntimeEvent,
  name: string,
  label: string,
): string | undefined {
  const value = attribute(event, name);
  return value === undefined ? undefined : `${label}: ${String(value)}`;
}

function attribute(
  event: RuntimeEvent,
  name: string,
): string | number | boolean | undefined {
  return event.attributes?.[name];
}

function joinDetails(values: readonly (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  return present.length > 0 ? present.join(" | ") : undefined;
}

function messageColor(level: ConsoleMessage["level"]): string {
  if (level === "success") return "green";
  if (level === "warning") return "yellow";
  if (level === "error") return "red";
  return "white";
}

function singleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 3)}...`;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Run `npm run tui` to open the NoCode Agent Console.");
    console.log("Use `npm run tui -- --verbose` for expanded sanitized logs.");
    console.log(HELP);
    return;
  }
  const verbose = process.argv.includes("--verbose");
  const catalog = await FileCatalog.load(
    resolve(option("--catalog") ?? "samples/catalog"),
  );
  const scenario = await loadScenario(
    resolve(
      option("--scenario") ??
        "samples/last-hour-vue-migration/scenario.json",
    ),
  );
  const store = await TuiSessionStore.open(
    resolve(option("--session-store") ?? ".agent-workspaces/sessions.json"),
  );
  const controller = new TuiController({
    catalog,
    scenario,
    workspaceManager: new RepositoryWorkspaceManager(
      resolve(option("--workspace-root") ?? ".agent-workspaces"),
    ),
    store,
    ...(verbose ? { reasoningSummary: "auto" as const } : {}),
    sandboxProvider: createSandboxProvider(),
  });
  store.message(
    "info",
    `Console ready: ${controller.sandboxPlacement()} sandbox; ${telemetryDestination()} telemetry. Use /agent list or /test list.`,
  );

  const sdk = startTelemetry("agenttui");
  const instance = render(
    <App controller={controller} store={store} verbose={verbose} />,
  );
  try {
    await instance.waitUntilExit();
  } finally {
    controller.cancelAll();
    await controller.waitForIdle();
    await store.flush();
    await sdk.shutdown();
  }
}

await main();

function telemetryDestination(): string {
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return "Azure Monitor";
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return "OTLP";
  return "console only";
}