import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// test/** and scripts/** used to be outside both this scan and tsconfig's include, so neither the
// banned-pattern list nor strict typechecking ever ran over them. Both now cover all three.
function filesIn(dir: string): string[] {
  return readdirSync(new URL(dir, import.meta.url))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(new URL(dir, import.meta.url).pathname, name));
}
const sourceFiles = filesIn("../src");
const allFiles = [...sourceFiles, ...filesIn("../test"), ...filesIn("../scripts")];
const selfPath = new URL(import.meta.url).pathname;

const forbidden = [
  { pattern: /\bclass\s+[A-Za-z_$]/, reason: "classes hide state; use functions and plain data" },
  { pattern: /(?:\bas|:)\s+any\b|<any>/, reason: "explicit any bypasses boundary validation" },
  { pattern: /@ts-ignore|@ts-expect-error|eslint-disable/, reason: "suppression comments hide reviewable failures" },
  // `as unknown as X` is deliberately not banned here: runtime.ts's Node-http-to-fetch-Request
  // bridge needs it, and strict typechecking is the real gate against misusing that idiom, not a
  // text pattern that can't tell a narrowing cast from a lazy one.
];
const failures: string[] = [];

for (const path of allFiles) {
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  if (sourceFiles.includes(path) && lines.length > 300) failures.push(`${path}: ${lines.length} lines; split effects by responsibility`);
  // This file's own pattern definitions necessarily contain the banned substrings as literal
  // regex source, not violations; scanning itself would just be self-referential noise.
  if (path === selfPath) continue;
  for (const { pattern, reason } of forbidden) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) failures.push(`${path}:${index + 1}: ${reason}`);
    });
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`quality: ${allFiles.length} functional TypeScript modules passed`);
