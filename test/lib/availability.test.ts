import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAvailability,
  createAvailabilityState,
} from "#src/lib/availability";
import type { Exec } from "#src/lib/exec";

describe("checkAvailability", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
  });

  it("returns available=true when colgrep --version exits 0", async () => {
    exec.mockResolvedValue({ stdout: "colgrep 1.2.0\n", stderr: "", code: 0 });
    const result = await checkAvailability(exec);
    expect(result).toEqual({ available: true });
  });

  it("calls colgrep with --version", async () => {
    exec.mockResolvedValue({ stdout: "colgrep 1.2.0\n", stderr: "", code: 0 });
    await checkAvailability(exec);
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      ["--version"],
      expect.anything(),
    );
  });

  it("returns available=false when colgrep --version exits non-zero", async () => {
    exec.mockResolvedValue({
      stdout: "",
      stderr: "command not found",
      code: 127,
    });
    const result = await checkAvailability(exec);
    expect(result).toEqual({ available: false });
  });

  it("returns available=false when exec throws", async () => {
    exec.mockRejectedValue(new Error("ENOENT: colgrep not found"));
    const result = await checkAvailability(exec);
    expect(result).toEqual({ available: false });
  });
});

describe("createAvailabilityState", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
  });

  it("starts with available=undefined before first check", () => {
    const state = createAvailabilityState();
    expect(state.available).toBeUndefined();
  });

  it("caches the result after refresh", async () => {
    exec.mockResolvedValue({ stdout: "colgrep 1.2.0\n", stderr: "", code: 0 });
    const state = createAvailabilityState();
    await state.refresh(exec);
    expect(state.available).toBe(true);
  });

  it("caches false when colgrep is absent", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 127 });
    const state = createAvailabilityState();
    await state.refresh(exec);
    expect(state.available).toBe(false);
  });

  it("updates the cached value on subsequent refreshes", async () => {
    exec
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 127 })
      .mockResolvedValueOnce({
        stdout: "colgrep 1.2.0\n",
        stderr: "",
        code: 0,
      });
    const state = createAvailabilityState();
    await state.refresh(exec);
    expect(state.available).toBe(false);
    await state.refresh(exec);
    expect(state.available).toBe(true);
  });
});
