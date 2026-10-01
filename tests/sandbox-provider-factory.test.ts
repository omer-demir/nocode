import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSandboxProvider,
  createSandboxProviderForPlacement,
  createSandboxProviderForProfile,
} from "../src/sandbox/create-sandbox-provider.js";

describe("createSandboxProvider", () => {
  it("uses local Docker by default", () => {
    assert.equal(createSandboxProvider({}).placement, "local");
  });

  it("creates a remote Azure session pool provider", () => {
    const provider = createSandboxProvider({
      NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
      AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT:
        "https://pool.example.azurecontainerapps.io",
      AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE: "bridge",
    });

    assert.equal(provider.placement, "remote");
  });

  it("requires an endpoint for the Azure provider", () => {
    assert.throws(
      () =>
        createSandboxProvider({
          NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
        }),
      /AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT is required/,
    );
  });

  it("creates independent providers for explicit gateway placements", () => {
    assert.equal(
      createSandboxProviderForPlacement("local", {
        NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
      }).placement,
      "local",
    );
    assert.equal(
      createSandboxProviderForPlacement("remote", {
        AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT:
          "https://pool.example.azurecontainerapps.io",
      }).placement,
      "remote",
    );
    assert.throws(
      () => createSandboxProviderForPlacement("remote", {}),
      /AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT is required/,
    );
  });

  it("routes an agent pool profile through the structured pool map", () => {
    const provider = createSandboxProviderForProfile(
      "node-hyperv-1cpu-2gi-no-egress",
      {
        NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
        AZURE_CONTAINER_APPS_SESSION_POOLS: JSON.stringify({
          "node-hyperv-1cpu-2gi-no-egress": {
            endpoint: "https://offline.example.azurecontainerapps.io",
            networkMode: "none",
            cpuLimit: 1,
            memoryMb: 2048,
          },
        }),
      },
    );

    assert.equal(provider.placement, "remote");
  });

  it("fails closed when an agent pool profile is not configured", () => {
    assert.throws(
      () =>
        createSandboxProviderForProfile("missing-profile", {
          NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
          AZURE_CONTAINER_APPS_SESSION_POOLS: "{}",
        }),
      /No Azure session pool is configured for missing-profile/,
    );
  });
});