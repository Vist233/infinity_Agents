/**
 * Puts hidden evaluator and data back after a run was killed: node examples/recover-hidden.ts <keeperDir>
 * Nothing is overwritten or deleted; a conflict is reported and both copies are kept.
 */
import { HiddenKeeper } from "../src/hidden-keeper.ts";

const keeperDir = process.argv[2];
if (!keeperDir) throw new Error("usage: node examples/recover-hidden.ts <keeperDir>");
console.log(JSON.stringify(HiddenKeeper.recover(keeperDir), null, 2));
