import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  SpawnProcessRunner,
  type ProcessRunner,
} from "../sandbox/process-runner.js";
import type {
  AgentScenario,
  ScenarioTestCase,
} from "../catalog/catalog-types.js";

const CLONE_TIMEOUT_MS = 120_000;

export class RepositoryWorkspaceManager {
  private readonly runner: ProcessRunner;
  private readonly root: string;

  constructor(root: string, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.root = resolve(root);
    this.runner = runner;
  }

  async prepare(
    scenario: AgentScenario,
    testCase: ScenarioTestCase,
    fresh = false,
  ): Promise<string> {
    const workspace = this.workspacePath(scenario.id, this.sourceCaseId(testCase));
    if (testCase.workspace.source === "test-case-output") {
      if (!(await exists(workspace))) {
        throw new Error(
          `Output workspace for ${testCase.workspace.testCaseId} does not exist: ${workspace}`,
        );
      }
      return workspace;
    }

    if (fresh && (await exists(workspace))) {
      await rm(workspace, { recursive: true, force: true });
    }
    if (await exists(workspace)) {
      return workspace;
    }

    await mkdir(resolve(workspace, ".."), { recursive: true });
    const cloneArgs = ["clone", "--depth", "1"];
    if (scenario.repository.ref) {
      cloneArgs.push(
        "--branch",
        scenario.repository.ref,
        "--single-branch",
      );
    }
    cloneArgs.push(scenario.repository.url, workspace);
    const result = await this.runner.run(
      "git",
      cloneArgs,
      { timeoutMs: CLONE_TIMEOUT_MS, maxOutputBytes: 1_048_576 },
    );
    if (result.exitCode !== 0) {
      await rm(workspace, { recursive: true, force: true });
      throw new Error(`Repository clone failed: ${result.stderr}`);
    }
    return workspace;
  }

  workspacePath(scenarioId: string, testCaseId: string): string {
    validatePathSegment(scenarioId, "scenario id");
    validatePathSegment(testCaseId, "test case id");
    const path = resolve(join(this.root, scenarioId, testCaseId));
    if (!path.startsWith(`${this.root}${sep}`)) {
      throw new Error("Workspace path escaped its configured root");
    }
    return path;
  }

  private sourceCaseId(testCase: ScenarioTestCase): string {
    return testCase.workspace.source === "clone"
      ? testCase.id
      : testCase.workspace.testCaseId;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validatePathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}