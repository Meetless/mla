import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeMeetlessSkills, removeMeetlessAgents } from "../../src/lib/unwire";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mla-unwire-"));

describe("removeMeetlessSkills", () => {
  it("removes each legacy SKILL.md and rmdirs the now-empty skill dir", () => {
    const skills = mkTmp();
    for (const name of ["mla", "mla-onboard"]) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.writeFileSync(path.join(skills, name, "SKILL.md"), "# skill\n");
    }
    const r = removeMeetlessSkills(skills);
    expect(r.changed).toBe(true);
    expect(fs.existsSync(path.join(skills, "mla"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "mla-onboard"))).toBe(false);
  });

  it("preserves memory.md / events.jsonl (removes only SKILL.md, keeps the dir)", () => {
    const skills = mkTmp();
    fs.mkdirSync(path.join(skills, "mla"), { recursive: true });
    fs.writeFileSync(path.join(skills, "mla", "SKILL.md"), "# skill\n");
    fs.writeFileSync(path.join(skills, "mla", "memory.md"), "# memory\n");
    const r = removeMeetlessSkills(skills);
    expect(r.changed).toBe(true);
    expect(fs.existsSync(path.join(skills, "mla", "SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "mla", "memory.md"))).toBe(true);
  });

  it("is a no-op (changed=false) when nothing is installed", () => {
    expect(removeMeetlessSkills(mkTmp()).changed).toBe(false);
  });
});

describe("removeMeetlessAgents", () => {
  it("removes each scout agent file unconditionally", () => {
    const agents = mkTmp();
    for (const f of ["meetless-doc-scout.md", "meetless-history-scout.md"]) {
      fs.writeFileSync(path.join(agents, f), "---\nname: x\n---\n");
    }
    const r = removeMeetlessAgents(agents);
    expect(r.changed).toBe(true);
    expect(fs.readdirSync(agents)).toHaveLength(0);
  });

  it("is a no-op (changed=false) when no agent files exist", () => {
    expect(removeMeetlessAgents(mkTmp()).changed).toBe(false);
  });
});
