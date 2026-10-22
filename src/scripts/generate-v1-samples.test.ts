import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { buildSamples, SAMPLES_DIR } from "./generate-v1-samples";

// The committed docs/api/samples/*.json are the published contract Vanward
// builds against. They must stay byte-for-byte what the real serializers emit.
// If this fails, the serializers changed without regenerating the samples:
//   npx ts-node src/scripts/generate-v1-samples.ts
describe("docs/api/samples is up to date", () => {
  const expected = buildSamples();

  it("has a committed file for every generated sample", () => {
    const onDisk = fs
      .readdirSync(SAMPLES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(onDisk).toEqual(Object.keys(expected).sort());
  });

  for (const [name, contents] of Object.entries(expected)) {
    it(`${name} matches the serializer output`, () => {
      const committed = fs.readFileSync(path.join(SAMPLES_DIR, name), "utf8");
      expect(committed).toBe(contents);
    });
  }
});
