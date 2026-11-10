/**
 * Run by a test as a separate process: node keeper-child.ts <mode> <keeperDir> <hiddenPath>
 * mode "wait": hide, guard the process, print "hidden", then wait to be killed.
 * mode "throw": hide, guard the process, print "hidden", then throw an uncaught error.
 * mode "exit": hide, guard the process, and exit normally.
 */
import { HiddenKeeper, restoreOnExit } from "../../src/hidden-keeper.ts";

const [mode, keeperDir, hiddenPath] = process.argv.slice(2);
if (!mode || !keeperDir || !hiddenPath) throw new Error("usage: keeper-child.ts <wait|throw|exit> <keeperDir> <hiddenPath>");
const keeper = new HiddenKeeper({ dir: keeperDir });
keeper.hide([hiddenPath]);
restoreOnExit(keeper);
process.stdout.write("hidden\n");
if (mode === "throw")
  setTimeout(() => {
    throw new Error("boom in the child");
  }, 50);
else if (mode === "wait") setInterval(() => {}, 1000);
