import { describe, expect, it } from "vitest";
import { hashReadableStream, hashText } from "../src/sha256";

describe("streaming SHA-256", () => {
  it("matches the standard empty and abc vectors", async () => {
    expect(hashText("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        controller.enqueue(new TextEncoder().encode("bc"));
        controller.close();
      },
    });
    await expect(hashReadableStream(stream)).resolves.toEqual({
      size: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});
