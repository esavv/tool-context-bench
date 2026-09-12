import { expect, it } from "vitest";
import { executorCatalog, executorToolNames, executorVersion } from "../src/executor.js";

it("wraps the tuned upstream catalog as the minimal Executor surface", () => {
  const upstream = {
    hash: "upstream-hash",
    names: ["github_get_commit"],
    tools: [
      {
        _server: "github",
        name: "get_commit",
        annotations: { readOnlyHint: true },
      },
    ],
    instructions: "upstream",
    server: { name: "github" },
  };
  const first = executorCatalog(upstream);
  const second = executorCatalog(structuredClone(upstream));
  expect(first.names).toEqual(executorToolNames);
  expect(first.tools).toEqual(upstream.tools);
  expect(first.hash).toBe(second.hash);
  expect(first.server).toMatchObject({
    executorVersion,
    downstreamTools: ["execute", "skills"],
    upstreamCatalogHash: upstream.hash,
  });
});
