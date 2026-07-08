import * as fs from "fs";
import * as path from "path";

// Source contract over the hook-template files the plugin generator copies
// verbatim (Task 5, Step 1). Guards the SOURCE, so no build / no generator run.
const TEMPLATE_DIR = path.resolve(__dirname, "../../src/hooks-template");

// The exact inventory the generator ships: 9 registered scripts (5 core + 4 ce0)
// + 3 support files. Hardcoded on purpose so a NEW or REMOVED template is a
// deliberate edit here, mirroring the generator's explicit allowlist (never a
// readdir). Kept sorted to compare against a sorted readdir directly.
const EXPECTED_TEMPLATES = [
  "ce0-post-tool-use.sh",
  "ce0-session-start.sh",
  "ce0-stop.sh",
  "ce0-user-prompt-submit.sh",
  "common.sh",
  "event-batch-filter.jq",
  "flush.sh",
  "post-tool-use.sh",
  "pre-tool-use.sh",
  "session-start.sh",
  "stop.sh",
  "user-prompt-submit.sh",
].sort();

describe("hook-template newline source contract", () => {
  it("ships exactly the 12 expected template files", () => {
    const actual = fs.readdirSync(TEMPLATE_DIR).sort();
    expect(actual).toEqual(EXPECTED_TEMPLATES);
  });

  it.each(EXPECTED_TEMPLATES)(
    "%s ends with exactly one trailing newline",
    (name) => {
      const content = fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
    },
  );
});
