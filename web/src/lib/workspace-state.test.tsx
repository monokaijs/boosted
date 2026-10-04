import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueWorkspaceOperation, useWorkspaceState, useWorkspaceStore } from "./workspace-state";

afterEach(cleanup);

describe("workspace UI state", () => {
  it("restores per-chat values on remount without notifying unrelated selectors", () => {
    let otherRenders = 0;
    const other = renderHook(() => { otherRenders++; return useWorkspaceState("other", ""); });
    const chat = renderHook(() => useWorkspaceState("chat:draft", ""));
    const before = otherRenders;
    act(() => chat.result.current[1]("Draft"));
    expect(otherRenders).toBe(before);
    chat.unmount();
    const restored = renderHook(() => useWorkspaceState("chat:draft", ""));
    expect(restored.result.current[0]).toBe("Draft");
    expect(other.result.current[0]).toBe("");
  });

  it("rejects old async writers after a machine switch", () => {
    const chat = renderHook(() => useWorkspaceState("chat:draft", ""));
    const oldWriter = chat.result.current[1];
    act(() => oldWriter("Machine A"));
    act(() => useWorkspaceStore.getState().reset());
    act(() => oldWriter("Late response"));
    expect(chat.result.current[0]).toBe("");
    expect(useWorkspaceStore.getState().values).toEqual({});
  });

  it("bounds UI entries while retaining pending deliveries", () => {
    const { write, generation } = useWorkspaceStore.getState();
    write("assistant:agent:outbox", [{ id: "pending" }], [], generation);
    for (let i = 0; i < 140; i++) write(`draft:${i}`, "Draft", "", generation);
    const { values } = useWorkspaceStore.getState();
    expect(Object.keys(values)).toHaveLength(128);
    expect(values["draft:0"]).toBeUndefined();
    expect(values["draft:139"]).toBe("Draft");
    expect(values["assistant:agent:outbox"]).toEqual([{ id: "pending" }]);
  });

  it("serializes sends across remounts and releases completed queues", async () => {
    const order: number[] = [];
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((done) => { started = done; });
    const first = enqueueWorkspaceOperation("agent", async () => { order.push(1); started(); await new Promise<void>((done) => { release = done; }); order.push(2); });
    const second = enqueueWorkspaceOperation("agent", async () => { order.push(3); });
    await firstStarted;
    expect(order).toEqual([1]);
    release(); await first; await second;
    expect(order).toEqual([1, 2, 3]);
  });
});
