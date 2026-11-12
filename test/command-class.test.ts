import { describe, expect, it } from "vitest";
import { isLightCommand } from "../src/command-class.ts";

/**
 * The table of command classifications (docs/18 step 1). "light" commands cannot hold a CPU for long and do not wait for a slot; everything else is "heavy".
 * A wrong answer costs a little speed or a little room, never safety, but the table is the contract: a change of the classifier shows up here.
 */
const TABLE: Array<[command: string, expected: "light" | "heavy", why: string]> = [
  // reading and looking
  ["ls -la", "light", "read-only program"],
  ["cat a.txt | head -5", "light", "every part of a pipe is cheap"],
  ["grep -r foo . | wc -l", "light", "pipe of cheap programs"],
  ["tail -n 50 log.txt", "light", "read-only program"],
  ["pwd", "light", "read-only program"],
  ["/bin/ls", "light", "the program is taken by its base name"],
  ["sleep 5", "light", "waiting costs no CPU"],
  ["echo hi > f.txt", "light", "a redirect of a cheap program"],
  ["cd data && ls", "light", "&& joins two cheap parts"],
  ["cd data; ls; pwd", "light", "; joins cheap parts"],
  ["(cd data && ls)", "heavy", "the closing ) sticks to the last word, which is then not understood: the safe answer is heavy"],
  ["(cd data; ls", "light", "a leading ( is ignored"],
  ["FOO=1 ls", "light", "an assignment in front is ignored"],
  ["test -f a || echo none", "light", "|| joins cheap parts"],
  // trivial writers
  ["mkdir -p out; touch out/x", "light", "trivial writers"],
  ["cp a b && mv b c && rm c", "light", "trivial writers"],
  ["chmod +x run.sh", "light", "trivial writer"],
  // git
  ["git status", "light", "git: status"],
  ["git add -A && git commit -m x", "light", "git: add and commit"],
  ["git log --oneline | head", "light", "git: log"],
  ["git diff --stat", "light", "git: diff"],
  ["git clone https://example.org/x", "heavy", "git: clone downloads and writes a lot"],
  ["git -C other status", "heavy", "git with an option that takes a value is not understood: the safe answer is heavy"],
  // sed, awk, find with and without side effects
  ["sed -n 1,5p a.py", "light", "sed without -i only reads"],
  ["sed -i s/a/b/ f", "heavy", "sed -i rewrites files"],
  ["awk '{print $1}' a.txt", "light", "awk reads"],
  ["find . -name '*.py'", "light", "find without actions"],
  ["find . -exec python {} ;", "heavy", "find -exec runs programs"],
  ["find . -delete", "heavy", "find -delete"],
  // interpreters, scripts, builders, installers
  ["python train.py", "heavy", "an interpreter"],
  ["python3 -c 'print(1)'", "heavy", "an interpreter, even for a line"],
  ["node script.js", "heavy", "an interpreter"],
  ["pip install scikit-learn", "heavy", "an installer"],
  ["./run.sh", "heavy", "a script"],
  ["make", "heavy", "a builder"],
  ["torchrun --nproc 2 train.py", "heavy", "a training launcher"],
  ["gpu python train.py", "heavy", "a GPU job (its own slot is taken by the shim)"],
  // mixtures: one heavy part makes the whole command heavy
  ["cd x && python a.py", "heavy", "one heavy part"],
  ["ls | python filter.py", "heavy", "one heavy part in a pipe"],
  ["echo done; python a.py", "heavy", "one heavy part after ;"],
  ["A=1 python a.py", "heavy", "an assignment does not change the program"],
  ["python a.py && echo ok", "heavy", "one heavy part before &&"],
  // substitutions are heavy because they run something unseen
  ["echo $(python a.py)", "heavy", "command substitution"],
  ["echo `python a.py`", "heavy", "backtick substitution"],
  // nothing to classify
  ["", "heavy", "an empty command is not known to be cheap"],
  ["   ", "heavy", "only spaces"],
  ["FOO=1", "heavy", "only an assignment: nothing is known"],
  [";", "heavy", "only a separator"],
];

describe("classification of commands: light or heavy", () => {
  it.each(TABLE)("%j is %s (%s)", (command, expected) => {
    expect(isLightCommand(command) ? "light" : "heavy").toBe(expected);
  });

  it("has at least one example of every rule: the table covers both classes", () => {
    expect(TABLE.filter(([, expected]) => expected === "light").length).toBeGreaterThanOrEqual(15);
    expect(TABLE.filter(([, expected]) => expected === "heavy").length).toBeGreaterThanOrEqual(15);
  });
});
