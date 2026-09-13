import { describe, it, expect } from "vitest";
import { createHistory, push, undo, redo, canUndo, canRedo, HISTORY_LIMIT } from "./history";

describe("history", () => {
  it("starts empty", () => {
    const h = createHistory<number>();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, 0)).toBeNull();
    expect(redo(h, 0)).toBeNull();
  });

  it("undoes and redoes in order", () => {
    let h = createHistory<number>();
    h = push(h, 0); // state becomes 1
    h = push(h, 1); // state becomes 2
    const u1 = undo(h, 2)!;
    expect(u1.state).toBe(1);
    const u2 = undo(u1.history, u1.state)!;
    expect(u2.state).toBe(0);
    expect(canUndo(u2.history)).toBe(false);
    const r1 = redo(u2.history, u2.state)!;
    expect(r1.state).toBe(1);
    const r2 = redo(r1.history, r1.state)!;
    expect(r2.state).toBe(2);
    expect(canRedo(r2.history)).toBe(false);
  });

  it("a new edit after undo discards the redo branch", () => {
    let h = createHistory<number>();
    h = push(h, 0);
    const u = undo(h, 1)!;
    expect(canRedo(u.history)).toBe(true);
    const h2 = push(u.history, u.state);
    expect(canRedo(h2)).toBe(false);
  });

  it("coalesces rapid edits with the same key into one step", () => {
    let h = createHistory<number>();
    h = push(h, 0, "gain:a", 0);
    h = push(h, 1, "gain:a", 100);
    h = push(h, 2, "gain:a", 200);
    expect(h.undoStack).toEqual([0]);
    expect(undo(h, 3)!.state).toBe(0);
  });

  it("does not coalesce across keys or after the window", () => {
    let h = createHistory<number>();
    h = push(h, 0, "gain:a", 0);
    h = push(h, 1, "gain:b", 100);
    h = push(h, 2, "gain:b", 5000);
    expect(h.undoStack).toEqual([0, 1, 2]);
  });

  it("an unkeyed edit never coalesces", () => {
    let h = createHistory<number>();
    h = push(h, 0, null, 0);
    h = push(h, 1, null, 1);
    expect(h.undoStack).toEqual([0, 1]);
  });

  it("caps the stack", () => {
    let h = createHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = push(h, i);
    expect(h.undoStack.length).toBe(HISTORY_LIMIT);
    expect(h.undoStack[0]).toBe(20);
  });
});
