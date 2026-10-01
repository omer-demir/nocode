import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
} from "../protocol/agent-protocol.js";

export class DemoModelProvider implements ModelProvider {
  private step = 0;

  async complete(messages: readonly AgentMessage[]): Promise<ModelResponse> {
    const task = messages.find((message) => message.role === "user")?.content ?? "demo";
    const actions: ModelResponse[] = [
      {
        toolRequest: {
          id: "demo-search",
          name: "filesystem.search",
          arguments: { path: "package.json", query: "name" },
        },
      },
      {
        toolRequest: {
          id: "demo-read",
          name: "filesystem.read",
          arguments: { path: "package.json" },
        },
      },
      {
        toolRequest: {
          id: "demo-write",
          name: "filesystem.write",
          arguments: {
            path: ".nocode-demo.txt",
            content: `Task: ${task}\nCompleted by the governed demo agent.\n`,
          },
        },
      },
      {
        toolRequest: {
          id: "demo-test",
          name: "test.run",
          arguments: {},
        },
      },
      { content: "Completed the governed read, search, write, and test workflow." },
    ];
    const response = actions[this.step];
    this.step += 1;
    return response ?? { content: "Demo agent completed." };
  }
}