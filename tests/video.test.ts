import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createVideoAnalyzer } from "../src/video.js";

describe("screen recording analysis", () => {
  it("extracts audio and bounded visual frames without invoking a shell", async () => {
    const calls: string[][] = [];
    const analyzer = createVideoAnalyzer({
      transcribe: async (bytes, mimeType) => {
        expect(bytes.toString()).toBe("audio");
        expect(mimeType).toBe("audio/mpeg");
        return "The save button does nothing.";
      },
      run: async (_command, args) => {
        calls.push(args);
        const output = args.at(-1)!;
        if (output.includes("frame-%03d.jpg")) {
          await writeFile(output.replace("%03d", "001"), "frame-one");
          await writeFile(output.replace("%03d", "002"), "frame-two");
        } else {
          await writeFile(output, "audio");
        }
      },
    });

    const result = await analyzer(Buffer.from("video"), "video/mp4");

    expect(result.transcript).toBe("The save button does nothing.");
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls).toHaveLength(2);
    expect(calls.flat()).toContain("12");
  });
});
