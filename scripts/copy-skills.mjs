import { copyFileSync, mkdirSync } from "node:fs";

// Preserve the skill's relative location for source and compiled entry points.
const skill = ".agents/skills/babysit-contribution/";
mkdirSync(new URL(`../dist/${skill}`, import.meta.url), { recursive: true });
copyFileSync(new URL(`../${skill}SKILL.md`, import.meta.url), new URL(`../dist/${skill}SKILL.md`, import.meta.url));
